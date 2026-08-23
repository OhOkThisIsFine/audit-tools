/**
 * Hand recovery — the ONLY place a human hand may re-land a submission.
 *
 * An operator sometimes has to rescue a submission a host mangled. The danger
 * is that the rescue becomes a second, weaker door into the tool: a path that
 * skips the schema the normal lane enforces, or that lets the operator choose
 * where the payload lands. Both are closed here by construction — the caller
 * hands in the NORMAL lane's validator (there is no other validator to pass),
 * and the destination is derived from the submission id, so `--from` says what
 * to land and never where.
 *
 * The third property is that the rescue is not erased: a successful recovery
 * appends `recovered_by_hand`, so a run repaired by an operator stays
 * distinguishable from one the host got right.
 */
import { readFile, unlink } from "node:fs/promises";

import {
  readOptionalJsonFile,
  writeFileAtomic,
  writeJsonFile,
} from "../io/json.js";
import { discardOnSchemaVersionMismatch } from "../io/schemaVersion.js";
import {
  expectedSubmissionsPath,
  submissionsDir,
} from "../io/auditToolsPaths.js";
import { EXPECTED_SET_CONTRACT_VERSION } from "./expectedSubmissions.js";
import type { ExpectedSubmissionSet } from "./expectedSubmissions.js";
import type { SubmissionIssue } from "./submissionClassifier.js";
import { readSubmissionDocument } from "./submissionClassifier.js";
import {
  absoluteSubmissionPath,
  submissionPathFor,
} from "./submissionIdentity.js";
import {
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  appendSubmissionEvent,
} from "./submissionLedger.js";

export interface HandRecoveryRequest {
  readonly root: string;
  readonly artifactsDir: string;
  readonly runId: string;
  readonly submissionId: string;
  /** Where the operator's corrected payload currently sits. */
  readonly fromPath: string;
  /**
   * The lane this submission answers, when the caller knows it. Recorded on
   * the ledger so the repair reads in lane vocabulary; absent, it is looked up
   * from the recorded expectation and only then falls back to the raw id.
   */
  readonly lane?: string;
  /**
   * The DRAW's submission home, when it is not the artifacts dir's
   * `submissions/`. Declared by the calling bin, never by the operator — the
   * remediate draw binds its work-item submissions under the run directory,
   * and the core stays storage-neutral rather than picking one for both.
   */
  readonly submissionDir?: string;
}

export type HandRecoveryOutcome =
  | { readonly ok: true; readonly submission_path: string }
  | { readonly ok: false; readonly issue: SubmissionIssue };

/**
 * Resolve which lane the id belongs to from the recorded expectation, so the
 * ledger entry reads in lane vocabulary. Best-effort: a draw that keeps its
 * expected set somewhere other than the artifacts dir simply records the id.
 *
 * The set is REGENERABLE bookkeeping (rewritten at every emit), so one left by
 * another release is discarded rather than read under this release's field
 * semantics — a lane name is a label on the record, and a wrong one taken from
 * a foreign contract is worse than the raw id this function already falls back
 * to. Discarding lands on exactly that existing degrade path.
 */
async function resolveLane(
  artifactsDir: string,
  submissionId: string,
): Promise<string> {
  const set = discardOnSchemaVersionMismatch(
    await readOptionalJsonFile<ExpectedSubmissionSet>(
      expectedSubmissionsPath(artifactsDir),
    ).catch(() => undefined),
    EXPECTED_SET_CONTRACT_VERSION,
  );
  return (
    set?.entries?.find((entry) => entry.submission_id === submissionId)?.lane ??
    submissionId
  );
}

/**
 * Validate the operator's payload with the normal lane's validator and, only
 * if it passes, land it at the tool-owned path. A refusal writes nothing and
 * records nothing — a run must never look hand-repaired because a repair was
 * ATTEMPTED.
 */
export async function recoverSubmission(
  request: HandRecoveryRequest,
  validate: (value: unknown) => SubmissionIssue | null,
): Promise<HandRecoveryOutcome> {
  const paths = {
    root: request.root,
    submissionDir: request.submissionDir ?? submissionsDir(request.artifactsDir),
  };
  // BOTH destinations are resolved first, because both can refuse: the
  // repo-relative form runs the containment check, and a submission directory
  // that escapes the declared root throws. Computed after the write, that
  // refusal arrived with the payload already landed and `recovered_by_hand`
  // already appended — a rescue reported as failed that a re-run would then
  // record twice. Resolved here, a refusal is what the rejection path already
  // guarantees: nothing written, nothing recorded.
  const landingPath = absoluteSubmissionPath(paths, request.submissionId);
  const boundPath = submissionPathFor(paths, request.submissionId);
  const read = await readSubmissionDocument(request.fromPath);
  if (read.kind === "missing") {
    return {
      ok: false,
      issue: {
        code: "submission_missing",
        message: `nothing to recover at ${request.fromPath}`,
        submission_id: request.submissionId,
      },
    };
  }
  if (read.kind === "malformed") {
    return {
      ok: false,
      issue: {
        code: "submission_malformed",
        message: `the payload at ${request.fromPath} is not JSON: ${read.detail}`,
        submission_id: request.submissionId,
      },
    };
  }

  const issue = validate(read.value);
  if (issue !== null) {
    return { ok: false, issue };
  }

  // Captured BEFORE the overwrite, as raw bytes, because rollback has to be able
  // to put back exactly what was there — byte-for-byte, not a re-serialization
  // of something re-parsed. A rescue attempted over an ALREADY-LANDED submission
  // is the case that made the old unconditional rollback destructive: deleting
  // produced "no file", never "the previous file", so a failed rescue destroyed
  // bytes the run already had.
  //
  // ONLY `ENOENT` MEANS ABSENT. Every other read failure — EISDIR, EACCES,
  // EPERM, EBUSY — says something IS there and could not be read, which is the
  // opposite fact. Treating them all as "nothing was there" set `priorContent`
  // to null and routed rollback to `unlink`, so an existing-but-unreadable
  // payload was DELETED by the recovery meant to protect it. There is no safe
  // guess to make here: without the prior bytes a rollback can neither restore
  // nor justify deleting, so the recovery is refused before anything is written.
  let priorContent: Buffer | null = null;
  try {
    priorContent = await readFile(landingPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return {
        ok: false,
        issue: {
          code: "submission_rejected",
          message:
            `the submission already at ${boundPath} could not be read (${code ?? "unknown error"}), ` +
            "so a failed recovery could not be rolled back without destroying it — " +
            "resolve what is at that path, then retry the recovery",
          submission_id: request.submissionId,
          submission_path: boundPath,
        },
      };
    }
  }

  const lane =
    request.lane ?? (await resolveLane(request.artifactsDir, request.submissionId));
  await writeJsonFile(landingPath, read.value);

  try {
    await appendSubmissionEvent(request.artifactsDir, {
      contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      run_id: request.runId,
      submission_id: request.submissionId,
      lane,
      kind: "recovered_by_hand",
      message: `re-landed by hand from ${request.fromPath}`,
      recorded_at: new Date().toISOString(),
    });
  } catch (error) {
    // The payload is landed but the repair is unrecorded — the single state
    // this verb must never leave behind, because the next `next-step` would
    // consume it as a clean first-try submission and the run would read as one
    // that never drifted. That is precisely the distinguishability the ledger
    // exists to guarantee, so the write is rolled back and the operator keeps a
    // failed rescue they can retry rather than a silent falsification.
    const detail = error instanceof Error ? error.message : String(error);
    try {
      // RESTORE-OR-DELETE, decided by what was captured above. Deleting is the
      // right rollback for exactly one case — nothing was there — and it was
      // being applied to both.
      if (priorContent === null) {
        await unlink(landingPath);
      } else {
        // Restored through the SHARED atomic writer with the captured raw bytes,
        // so the rollback is byte-for-byte AND crash-safe: the forward write is
        // temp+rename and the restore must be no weaker, or a crash between
        // truncate and the last byte would leave a TRUNCATED prior payload —
        // worse than either outcome this rollback chooses between. (`writeFile`
        // accepting a Buffer was not enough; only the atomic form closes it.)
        await writeFileAtomic(landingPath, priorContent);
      }
    } catch (rollbackError) {
      // UNCOVERED HALF, stated: this branch — the append AND the rollback both
      // failing — has no test. Reaching it requires the landing path to be
      // writable at T (the forward write succeeded) and unwritable at T+1 (the
      // rollback did not), which is a genuine race rather than a state a fixture
      // can seed; every deterministic trigger fails the forward write first and
      // never arrives here. What IS covered is the message: the operator is told
      // the payload is on disk, unrecorded, and what to do about it. The branch's
      // reachability is argued, not demonstrated.
      const rollbackDetail =
        rollbackError instanceof Error
          ? rollbackError.message
          : String(rollbackError);
      throw new Error(
        `hand recovery for '${request.submissionId}' could not record the ledger event ` +
          `(${detail}), and the landed payload could NOT be rolled back (${rollbackDetail}). ` +
          `The payload IS on disk at ${boundPath} with no recovered_by_hand record — ` +
          "remove it or retry the recovery before the next next-step consumes it." +
          (priorContent === null
            ? ""
            : " It OVERWROTE a submission that was already there, which could not be" +
              " restored — recover that payload before retrying."),
        { cause: error },
      );
    }
    throw new Error(
      `hand recovery for '${request.submissionId}' could not record the ledger event: ` +
        `${detail}. The payload was NOT landed (rolled back) — retry the recovery.` +
        (priorContent === null
          ? ""
          : " The submission that was already at that path has been restored byte-for-byte."),
      { cause: error },
    );
  }

  return { ok: true, submission_path: boundPath };
}
