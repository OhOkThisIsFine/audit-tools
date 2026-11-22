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
 * A submission is renamed to staging before parsing. An immutable receipt
 * records the core/snapshot plan and applied submissions before publication.
 * The next holder replays that exact plan before staging recovery. Only
 * after core and snapshots land is applied staging removed and acknowledged.
 * Un-applied files stay staged for ordinary safe restoration.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  hashContent,
  isFileMissingError,
  readSubmissionIngestHistory,
  readOptionalJsonFile,
  writeJsonFile,
} from "audit-tools/shared";
import { applyCoreArtifactPlan, planCoreArtifacts, type ArtifactBundle, type CoreArtifactPlan } from "../io/artifacts.js";
import { assertNoPendingFoldReceipt, foldReceiptPath } from "../io/foldReceiptPath.js";
import {
  DESIGN_REVIEW_PASSES,
  writeDesignReviewSnapshot,
  type DesignReviewSnapshot,
} from "../orchestrator/designReviewSnapshot.js";
import {
  AUDIT_GATE_SUBMISSION_SCOPE,
  laneSubmissionId,
  laneSubmissionPath,
  recordLaneOutcome,
} from "./laneSubmissions.js";

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
  /**
   * Where the refused content now lives, and `null` when it does not live
   * anywhere: the `rename` failed AND the copy fallback failed too, so nothing
   * was ever written to the quarantine directory.
   *
   * Nullable rather than a bare string BECAUSE the type is the enforcement.
   * Every consumer puts this value into an operator line, a rendered notice, or
   * a persisted `quarantine_path` field; a non-null string let all of them
   * report a path naming no file, and no amount of care at the call sites would
   * have caught it. The typechecker catches it instead.
   */
  readonly quarantinePath: string | null;
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
  if (outcome.quarantinePath === null) {
    return (
      " — the content could NOT be copied to quarantine, so nothing was written " +
      "there and the file survives at its original path, where a later pass will " +
      "attempt the quarantine again"
    );
  }
  return outcome.sourceSurvived
    ? " — the quarantined source could NOT be deleted and survives at its original " +
        "path, so a later pass will quarantine it again"
    : "";
}

/**
 * How a refusal NAMES the quarantine location, from a stored path. The one home
 * for the phrasing, so a failed copy cannot read as a successful one at any
 * call site that interpolated the path itself — which is what every operator
 * line and rendered host notice used to do, and why a `null` would otherwise
 * reach a prompt as the literal word "null".
 */
export function describeQuarantineLocation(quarantinePath: string | null): string {
  return quarantinePath === null
    ? "NOT quarantined — the copy failed, so the content is still at its bound path"
    : `quarantined to ${quarantinePath}`;
}

/** {@link describeQuarantineLocation} for a fresh outcome. */
export function quarantineLocationPhrase(outcome: QuarantineOutcome): string {
  return describeQuarantineLocation(outcome.quarantinePath);
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
      // The copy did NOT land, so there is nothing at `quarantinePath` and the
      // delete below MUST NOT run. The old comment here read "nothing left to
      // quarantine if even the read failed", which holds only for the READ: a
      // `writeFile` failure — a full disk, or permissions on the quarantine
      // directory — leaves the source perfectly readable, and unlinking it then
      // DESTROYED a submission while the caller reported a path naming no file.
      return { quarantinePath: null, sourceSurvived: true };
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

function hasIoCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

async function linkStagedWithoutReplacing(stagingPath: string, boundPath: string): Promise<void> {
  try {
    await link(stagingPath, boundPath);
  } catch (error) {
    if (!hasIoCode(error, "EXDEV")) throw error;
    // A split mount needs a copy first, but only a complete sibling may be
    // published, and publishing must still fail if the destination exists.
    const tempPath = join(dirname(boundPath), "." + basename(boundPath) + "." + randomUUID() + ".restore");
    await copyFile(stagingPath, tempPath, constants.COPYFILE_EXCL);
    try {
      await link(tempPath, boundPath);
    } finally {
      // A stale private sibling is not an input slot and must not hide the
      // publication outcome or cause an unsafe retry.
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

/**
 * Restore complete bytes only into a free bound slot. A rename can replace a
 * newer result, and a check before rename cannot protect unlocked submitters.
 * A split mount copies into a private sibling first. If hard links are unsupported, keep
 * the staged copy and surface the error rather than falling back to overwrite.
 */
async function restoreStagedSubmission(
  artifactsDir: string,
  lane: string,
  stagingPath: string,
  boundPath: string,
): Promise<void> {
  try {
    await linkStagedWithoutReplacing(stagingPath, boundPath);
  } catch (error) {
    if (isFileMissingError(error)) {
      // ENOENT can also mean the bound directory is missing.
      try {
        await stat(stagingPath);
      } catch (statError) {
        if (isFileMissingError(statError)) return;
        throw statError;
      }
      throw error;
    }
    if (!hasIoCode(error, "EEXIST")) throw error;
    // A retry after linking but before removing staging sees identical bytes.
    // An identical resubmission is likewise already available in the slot.
    let staged: Buffer;
    try {
      staged = await readFile(stagingPath);
    } catch (readError) {
      if (isFileMissingError(readError)) return;
      throw readError;
    }
    if (!staged.equals(await readFile(boundPath))) {
      const quarantine = await quarantineSubmissionFile(artifactsDir, stagingPath, lane);
      await recordLaneOutcome(artifactsDir, lane, {
        kind: "rejected",
        issueCode: "submission_rejected",
        message:
          `a fold held this submission staged while a newer one arrived at the bound path; ` +
          `the staged copy is ${quarantineLocationPhrase(quarantine)} and the newer submission is ` +
          `retained` + quarantineSurvivalNote(quarantine),
      });
      if (quarantine.sourceSurvived) {
        throw new Error("Superseded submission could not leave staging; retry after resolving the filesystem error.");
      }
      return;
    }
  }
  try {
    await unlink(stagingPath);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
  }
}

/** Fold-start recovery under the hold, before the staged input can be consumed. */
// sites-pinned: tests/audit/next-step-question-workload.test.ts
export async function recoverStagedSubmissions(
  artifactsDir: string,
  recoverLane: (lane: string) => boolean = () => true,
): Promise<void> {
  await assertNoPendingFoldReceipt(artifactsDir);
  let entries: string[];
  try {
    entries = await readdir(submissionStagingDir(artifactsDir));
  } catch (error) {
    if (isFileMissingError(error)) return;
    throw error;
  }
  for (const fileName of entries) {
    const lane = laneFromStagedFileName(fileName);
    if (lane === null || !recoverLane(lane)) continue;
    await restoreStagedSubmission(
      artifactsDir,
      lane,
      join(submissionStagingDir(artifactsDir), fileName),
      laneSubmissionPath(artifactsDir, lane),
    );
  }
}

const ReceiptSchema = z.object({
  version: z.literal(1),
  core: z.object({
    writes: z.record(z.unknown()),
    prunes: z.array(z.string()),
    graphEdgeCache: z.unknown().optional(),
  }).strict(),
  snapshots: z.array(z.object({
    pass: z.enum(DESIGN_REVIEW_PASSES),
    schema_version: z.literal("audit-code/design-review-snapshot/v2alpha1"),
    reviewed_at: z.string(),
    prior_findings: z.array(z.unknown()),
    reviewed_inputs: z.record(z.unknown()),
    reviewed_task: z.unknown(),
  }).strict()),
  applied: z.array(z.object({
    lane: z.string().min(1),
    submissionId: z.string(),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    acceptedMessage: z.string().optional(),
  }).strict()),
}).strict();

type FoldReceipt = {
  version: 1;
  core: CoreArtifactPlan;
  snapshots: DesignReviewSnapshot[];
  applied: Array<Pick<StagedSubmission, "lane" | "contentHash" | "acceptedMessage"> & { submissionId: string }>;
};

const ownNoop = async (): Promise<void> => undefined;

async function applyFoldReceipt(
  artifactsDir: string,
  receipt: FoldReceipt,
  assertOwnership: () => Promise<void>,
): Promise<void> {
  for (const staged of receipt.applied) {
    if (staged.submissionId !== laneSubmissionId(staged.lane, AUDIT_GATE_SUBMISSION_SCOPE)) {
      throw new Error("The fold receipt does not own the staged submission.");
    }
    const path = join(submissionStagingDir(artifactsDir), stagedFileName(staged.lane));
    try {
      if (hashContent(await readFile(path)) !== staged.contentHash) {
        throw new Error("Staged submission bytes do not match the fold receipt; recovery stopped.");
      }
    } catch (error) {
      // Missing is valid after an interrupted acknowledgment cleanup.
      if (!isFileMissingError(error)) throw error;
    }
  }

  await assertOwnership();
  await applyCoreArtifactPlan(artifactsDir, receipt.core, assertOwnership);
  for (const snapshot of receipt.snapshots) {
    await assertOwnership();
    await writeDesignReviewSnapshot(artifactsDir, snapshot);
  }
  if (receipt.applied.length > 0) {
    const history = await readSubmissionIngestHistory(artifactsDir, { runId: AUDIT_GATE_SUBMISSION_SCOPE });
    for (const staged of receipt.applied) {
      const path = join(submissionStagingDir(artifactsDir), stagedFileName(staged.lane));
      await assertOwnership();
      try {
        await unlink(path);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
      await assertOwnership();
      await recordLaneOutcome(artifactsDir, staged.lane, {
        kind: "accepted",
        ...(staged.acceptedMessage ? { message: staged.acceptedMessage } : {}),
      }, history);
    }
  }
  await assertOwnership();
  await unlink(foldReceiptPath(artifactsDir));
}

/** Call only under the artifact-tree hold, before loading or staging the live bundle. */
export async function recoverFoldReceipt(
  artifactsDir: string,
  assertOwnership: () => Promise<void>,
): Promise<boolean> {
  const raw = await readOptionalJsonFile<unknown>(foldReceiptPath(artifactsDir));
  if (raw === undefined) return false;
  const receipt = ReceiptSchema.parse(raw) as FoldReceipt;
  await applyFoldReceipt(artifactsDir, receipt, assertOwnership);
  return true;
}

/** Persist the exact redo intent before changing any core files. */
export async function commitFold(
  artifactsDir: string,
  bundle: ArtifactBundle,
  tx: FoldTransaction,
  assertOwnership: () => Promise<void> = ownNoop,
): Promise<void> {
  if (!(await recoverFoldReceipt(artifactsDir, assertOwnership))) {
    const receipt: FoldReceipt = {
      version: 1,
      core: planCoreArtifacts(bundle, true),
      snapshots: tx.pendingSnapshots,
      applied: tx.staged.filter(staged => staged.applied).map(({ lane, contentHash, acceptedMessage }) => ({
        lane, contentHash, acceptedMessage, submissionId: laneSubmissionId(lane, AUDIT_GATE_SUBMISSION_SCOPE),
      })),
    };
    await assertOwnership();
    await writeJsonFile(foldReceiptPath(artifactsDir), receipt);
    await applyFoldReceipt(artifactsDir, receipt, assertOwnership);
  }
  tx.pendingSnapshots.length = 0;
  for (const staged of tx.staged) {
    if (!staged.applied) {
      await assertOwnership();
      await restoreStagedSubmission(artifactsDir, staged.lane, staged.stagingPath, staged.boundPath);
    }
  }
  tx.staged.length = 0;
}
