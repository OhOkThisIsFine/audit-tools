/**
 * The `next-step` fold's TRANSACTION — the mechanics of ONE CORE WRITE BOUNDARY
 * under ONE artifact-tree hold (CX-02 landings 2 and 3).
 *
 * What is deferred to the commit:
 * - the single authoritative core-artifact write (the fold's carried bundle,
 *   pruned — the bundle is always the FULL accumulated bundle, never partial,
 *   because pruning treats a missing key as an intent to delete);
 * - design-review snapshot writes (state-critical: a snapshot lost between
 *   fold and commit silently marks a completed pass satisfied);
 * - consumed-submission deletions and their `accepted` ledger events (an
 *   accepted event recorded before the core commit double-records when a crash
 *   replays the fold).
 *
 * What stays immediate, deliberately: quarantine moves and their `rejected`
 * ledger events (the quarantine happened; the bound path is empty, so a replay
 * cannot re-consume), the `steps/deterministic-progress.json` marker protocol
 * (its value is being visible MID-fold), handoff/observability writes, and the
 * durable analyzer consent/settings stores (idempotent merges outside the
 * artifact tree).
 *
 * Staging (landing 3's decided replacement for unlink deferral): a submission
 * is RENAMED into `submission-staging/` before it is parsed or applied, so
 * recovery can tell a consumption was in flight. On commit an APPLIED staged
 * file is deleted (its effect is on disk); an UN-applied one is restored to
 * its bound path for the retry. A crash between the core write and the staged
 * cleanup can therefore restore an ALREADY-FOLDED submission — iterative-fold
 * executors guard that window with a content-hash register and ignore a
 * duplicate (see `runSystemicChallengeExecutor`).
 */

import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { hashContent, isFileMissingError } from "audit-tools/shared";
import { writeCoreArtifacts, type ArtifactBundle } from "../io/artifacts.js";
import {
  writeDesignReviewSnapshot,
  type DesignReviewSnapshot,
} from "../orchestrator/designReviewSnapshot.js";
import { laneSubmissionPath, recordLaneOutcome } from "./laneSubmissions.js";

const STAGING_DIRNAME = "submission-staging";

export function submissionStagingDir(artifactsDir: string): string {
  return join(artifactsDir, STAGING_DIRNAME);
}

function stagedFileName(lane: string): string {
  return `${encodeURIComponent(lane)}.json`;
}

function laneFromStagedFileName(fileName: string): string | null {
  if (!fileName.endsWith(".json")) return null;
  try {
    return decodeURIComponent(fileName.slice(0, -".json".length));
  } catch {
    return null;
  }
}

/** One staged (consumption-in-flight) host submission. */
export interface StagedSubmission {
  lane: string;
  boundPath: string;
  stagingPath: string;
  /** sha256 of the staged bytes — the iterative-fold duplicate-guard identity. */
  contentHash: string;
  /** True once the fold has landed the submission's effect on the carried bundle. */
  applied: boolean;
  /** Optional message for the deferred `accepted` ledger event. */
  acceptedMessage?: string;
}

/** The fold's pending side effects, committed once at the boundary. */
export interface FoldTransaction {
  staged: StagedSubmission[];
  pendingSnapshots: DesignReviewSnapshot[];
}

export function createFoldTransaction(): FoldTransaction {
  return { staged: [], pendingSnapshots: [] };
}

/** What a quarantine actually achieved, as opposed to what it attempted. */
export interface QuarantineOutcome {
  /** Where the refused content now lives. Always written. */
  readonly quarantinePath: string;
  /**
   * The source could NOT be deleted, so it survives at its original path and a
   * later pass will quarantine it again, appending one more `rejected` event
   * each time. A caller that reports the quarantine states this, so the repeat
   * is attributable rather than silent.
   *
   * This half takes the RECORD arm rather than throwing, and the asymmetry with
   * {@link moveFile} is deliberate: every caller here awaits the quarantine and
   * THEN records the refusal, so a throw would suppress the very event that
   * explains it and leave the refused file bound for the next fold to fail on
   * identically — a permanent wedge with nothing on the ledger.
   */
  readonly sourceSurvived: boolean;
}

/**
 * The clause a refusal states when the quarantined source survived, and the
 * empty string when it did not. ONE home for the wording, so the fact cannot be
 * reported by one caller and dropped by another. It appends to both halves of a
 * refusal — the operator's stderr line and the LEDGER message, which is the
 * durable record the property actually asks for.
 */
export function quarantineSurvivalNote(outcome: QuarantineOutcome): string {
  return outcome.sourceSurvived
    ? " — the quarantined source could NOT be deleted and survives at its original " +
        "path, so a later pass will quarantine it again"
    : "";
}

/**
 * Move a refused submission to `<artifactsDir>/quarantine/` rather than
 * deleting it. Falls back to copy+unlink if `rename` fails (e.g. a cross-device
 * artifacts mount) so the content is never lost. The quarantined file is named
 * for its LANE — the bound path is a digest, which tells an operator nothing.
 *
 * Reports whether the source survived; see {@link QuarantineOutcome}.
 */
export async function quarantineSubmissionFile(
  artifactsDir: string,
  filePath: string,
  lane: string,
): Promise<QuarantineOutcome> {
  const quarantineDir = join(artifactsDir, "quarantine");
  await mkdir(quarantineDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinePath = join(quarantineDir, `${lane}.${timestamp}.json`);
  try {
    await rename(filePath, quarantinePath);
  } catch {
    try {
      const content = await readFile(filePath, "utf8");
      await writeFile(quarantinePath, content, "utf8");
    } catch {
      // Best-effort: nothing left to quarantine if even the read failed.
    }
    try {
      await unlink(filePath);
    } catch (error) {
      // ENOENT is the outcome asked for: the source is gone.
      if (!isFileMissingError(error)) {
        return { quarantinePath, sourceSurvived: true };
      }
    }
  }
  return { quarantinePath, sourceSurvived: false };
}

/**
 * Rename with a copy+unlink fallback for cross-device artifact mounts.
 *
 * The copy has landed by the time the unlink runs, so the content is safe at
 * `to` and only the source deletion can fail. That failure THROWS rather than
 * resolving over it: every call site treats a surviving source as a file to
 * process again, so resolving would report a move that did not happen. All
 * three callers already rethrow anything that is not a missing file, and none
 * has consumed or recorded anything by that point — so the fold simply fails
 * and retries, with the content intact at both paths. ENOENT stays ignored: the
 * source is gone, which is the outcome asked for.
 */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (isFileMissingError(error)) throw error;
    const content = await readFile(from);
    await writeFile(to, content);
    try {
      await unlink(from);
    } catch (unlinkError) {
      if (!isFileMissingError(unlinkError)) throw unlinkError;
    }
  }
}

export type StageResult =
  | { status: "absent" }
  | { status: "staged"; staged: StagedSubmission };

/**
 * Stage one lane's bound submission: rename it into the staging directory
 * BEFORE anything parses or applies it. Registered on the transaction as
 * un-applied; `markSubmissionApplied` flips it once its effect is on the
 * carried bundle.
 */
export async function stageLaneSubmission(
  tx: FoldTransaction,
  artifactsDir: string,
  lane: string,
): Promise<StageResult> {
  const boundPath = laneSubmissionPath(artifactsDir, lane);
  const stagingPath = join(submissionStagingDir(artifactsDir), stagedFileName(lane));
  // Probe the bound path BEFORE creating anything: every gate polls its lane
  // on every pass, so the absent case must stay a pure read — an unconditional
  // mkdir turns the poll into a write (EACCES on an unwritable artifacts root,
  // a planted directory on a writable one).
  try {
    await stat(boundPath);
  } catch (error) {
    if (isFileMissingError(error)) return { status: "absent" };
    throw error;
  }
  await mkdir(submissionStagingDir(artifactsDir), { recursive: true });
  try {
    await moveFile(boundPath, stagingPath);
  } catch (error) {
    if (isFileMissingError(error)) return { status: "absent" };
    throw error;
  }
  const bytes = await readFile(stagingPath);
  const staged: StagedSubmission = {
    lane,
    boundPath,
    stagingPath,
    contentHash: hashContent(bytes),
    applied: false,
  };
  tx.staged.push(staged);
  return { status: "staged", staged };
}

/**
 * Mark a staged submission APPLIED: its effect now rides the carried bundle,
 * so the commit deletes it and records its `accepted` event. A submission a
 * gate QUARANTINED must instead be dropped from the register (the quarantine
 * moved the file; there is nothing left to delete or restore).
 */
export function markSubmissionApplied(
  tx: FoldTransaction,
  stagingPath: string,
  acceptedMessage?: string,
): void {
  const entry = tx.staged.find((s) => s.stagingPath === stagingPath);
  if (!entry) {
    throw new Error(
      `markSubmissionApplied: no staged submission at ${stagingPath} — a gate applied a submission the transaction never staged`,
    );
  }
  entry.applied = true;
  if (acceptedMessage !== undefined) entry.acceptedMessage = acceptedMessage;
}

// A quarantined staged file needs no explicit drop from the register: the
// quarantine MOVED it, and the commit's restore of an un-applied entry treats
// a missing staging file as already-handled (see commitFold). One lifecycle,
// no second bookkeeping call a gate could forget.

/**
 * Fold-start recovery sweep, run under the hold BEFORE the bundle loads: a
 * file still in staging means a previous fold crashed mid-consumption. Restore
 * it to its bound path so the fold re-consumes it; if the host has meanwhile
 * resubmitted over the bound path, quarantine the staged copy instead (the
 * newer submission supersedes the one the crashed fold held) and record the
 * refusal so the supersession is on the ledger, not silent.
 */
export async function recoverStagedSubmissions(
  artifactsDir: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(submissionStagingDir(artifactsDir));
  } catch (error) {
    if (isFileMissingError(error)) return;
    throw error;
  }
  for (const fileName of entries) {
    const lane = laneFromStagedFileName(fileName);
    if (lane === null) continue;
    const stagingPath = join(submissionStagingDir(artifactsDir), fileName);
    const boundPath = laneSubmissionPath(artifactsDir, lane);
    let boundOccupied = true;
    try {
      await readFile(boundPath);
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
      boundOccupied = false;
    }
    if (boundOccupied) {
      const quarantine = await quarantineSubmissionFile(
        artifactsDir,
        stagingPath,
        lane,
      );
      await recordLaneOutcome(artifactsDir, lane, {
        kind: "rejected",
        issueCode: "submission_rejected",
        message:
          `a crashed fold held this submission staged while a newer one arrived at the bound path; ` +
          `the staged copy is quarantined at ${quarantine.quarantinePath} and the newer submission is consumed instead` +
          quarantineSurvivalNote(quarantine),
      });
      continue;
    }
    await moveFile(stagingPath, boundPath);
  }
}

/**
 * THE commit — the fold's one core write boundary, run on EVERY fold exit
 * including the throw path. Order is load-bearing:
 * 1. the core artifacts (one authoritative pruned write of the carried bundle);
 * 2. the design-review snapshots (state-critical companions of that bundle);
 * 3. applied staged submissions: delete + `accepted` ledger event — only now,
 *    so a crash before (1) leaves the submission restorable and event-free;
 * 4. un-applied staged submissions: restore to their bound paths for the retry.
 *
 * Each deferred entry leaves the transaction the moment it completes, because
 * the throw path re-runs commitFold on the SAME transaction: a re-entry after
 * a mid-loop I/O error must RESUME at the failed entry, never re-record an
 * `accepted` event the first attempt already appended.
 */
export async function commitFold(
  artifactsDir: string,
  bundle: ArtifactBundle,
  tx: FoldTransaction,
): Promise<void> {
  await writeCoreArtifacts(artifactsDir, bundle, { prune: true });
  while (tx.pendingSnapshots.length > 0) {
    await writeDesignReviewSnapshot(artifactsDir, tx.pendingSnapshots[0]!);
    tx.pendingSnapshots.shift();
  }
  while (tx.staged.length > 0) {
    const staged = tx.staged[0]!;
    if (staged.applied) {
      // The delete must SUCCEED before the `accepted` event records. A swallowed
      // EBUSY/EPERM (an AV scan holding the file on Windows) left the ledger
      // saying consumed while the file survived for the next fold's recovery
      // sweep to restore — a disagreement the crash window cannot produce, and
      // the one state where the ledger is affirmatively wrong. Failing the
      // commit instead lands the ALREADY-ACCEPTED crash state: no event, file
      // restorable, duplicates suppressed per lane by the content-hash register.
      // ENOENT stays ignored: the file is gone, which is the outcome asked for.
      try {
        await unlink(staged.stagingPath);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
      await recordLaneOutcome(artifactsDir, staged.lane, {
        kind: "accepted",
        ...(staged.acceptedMessage ? { message: staged.acceptedMessage } : {}),
      });
    } else {
      try {
        await moveFile(staged.stagingPath, staged.boundPath);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
    }
    tx.staged.shift();
  }
}
