// sites-pinned: tests/audit/frozen-snapshot.test.ts
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { artifactTreeLockPath } from "../../shared/io/auditToolsPaths.js";
import { hasPendingFoldReceipt } from "../io/foldReceiptPath.js";
import { basename, join } from "node:path";
import { isFileMissingError, readJsonFile } from "audit-tools/shared";
import { ARTIFACT_DEFINITIONS, isWorkingDirFullyPromoted, retiredRunEvidenceIsArchived } from "../io/artifacts.js";
import { removeRunSnapshot } from "../io/runSnapshot.js";
import type { AuditState } from "../types/auditState.js";

export type CleanupOptions = {
  repositoryRoot?: string;
  force?: boolean;
  dryRun?: boolean;
};

export type CleanupResult = {
  action: "deleted" | "skipped" | "dry-run";
  status: AuditState["status"] | "unknown";
  reason?: string;
};

// Remove a stale working artifacts directory. Two callers, ONE rule: the
// `cleanup` CLI command (cmdCleanup) and the next-step pre-run sweep
// (cmdNextStepBody) call this identically — owner decision 74c89b226ab9b9cd
// (2026-08-31), which reversed the not_started-only pre-run narrowing of
// 7ebeccc8 while keeping its protection.
//
// A dir is stale (eligible without --force) when nothing in it is still owed to
// the host: its run is `not_started` (nothing was produced), or `complete` with
// nothing left for the completion transition to do — every artifact promotion
// archives is already one level up, byte-identical, as decided by promotion's
// own archive walk in verify-only mode (isWorkingDirFullyPromoted), never by a
// second list. A `complete` dir with work left — an unpromoted render, an
// unarchived contract, friction triage pending — is a live continuation for
// BOTH callers: at next-step entry the fold's terminal step presents and
// promotes it; the verb refuses it without --force. Sweeping it would destroy
// the only copy of a finished audit. (At next-step entry an ENDED run never
// reaches this sweep: `rollOverFinishedRun` runs first and turns it into the
// next run's starting point, so for that caller the complete arm covers only
// a promoted run whose terminal step never wrote the run-ended marker.)
//
// Deletion contract: only the working artifacts dir is removed. The promoted
// final reports live one level up (promotedAuditReportPath /
// promotedAuditFindingsPath, and the remediation pair beside them) and no
// cleanup path touches them. A missing state file means there is nothing to
// clean.
//
// With options:
//   force=true  — delete even when the run is active/blocked, complete with
//                 work left, or has no state file.
//   dryRun=true — skip the actual rm call and return action='dry-run'.
// Both default to false.
export async function cleanupStaleArtifactsDir(
  artifactsDir: string,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  try {
    await stat(artifactsDir);
  } catch (error) {
    if (!isFileMissingError(error)) throw error;
    return { action: "skipped", status: "unknown" };
  }
  const result = await withArtifactTreeHold(artifactsDir, undefined, assertOwnership => cleanupHeld(
    artifactsDir, options, assertOwnership,
  ));
  if (result.action === "deleted") {
    try {
      await rmdir(artifactsDir);
    } catch (error) {
      if (!isFileMissingError(error) &&
        !(error && typeof error === "object" && "code" in error && error.code === "ENOTEMPTY")) throw error;
    }
  }
  return result;
}

async function cleanupHeld(
  artifactsDir: string,
  options: CleanupOptions,
  assertOwnership: () => Promise<void>,
): Promise<CleanupResult> {
  const { force = false, dryRun = false } = options;
  if (await hasPendingFoldReceipt(artifactsDir)) {
    return { action: "skipped", status: "unknown", reason: "An incomplete fold receipt must be recovered using next-step." };
  }

  let status: AuditState["status"] | "unknown" = "unknown";
  try {
    const state = await readJsonFile<AuditState>(
      join(artifactsDir, ARTIFACT_DEFINITIONS.audit_state.fileName),
    );
    status = state.status;
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    // State file missing — status stays "unknown".
  }

  if (!force && status === "not_started" && !(await retiredRunEvidenceIsArchived(artifactsDir))) {
    return { action: "skipped", status, reason: "Historical audit evidence is not safely archived. The working audit was kept." };
  }

  const stale =
    status === "not_started" ||
    (status === "complete" && (force || (await isWorkingDirFullyPromoted(artifactsDir))));
  const resumable = status === "active" || status === "blocked";

  if (!stale && !force) {
    // active/blocked — caller may want to resume; skip unless forced
    if (resumable) {
      const reason = `audit is ${status} and may be resumed — use --force to delete anyway`;
      return { action: "skipped", status, reason };
    }
    // complete with work left — the dir holds the only copy of the finished
    // audit until the completion transition promotes it.
    if (status === "complete") {
      const reason =
        "audit is complete but its final report is not fully promoted — this dir holds the only copy; run next-step to present and promote it (or, for a run that already ended, to archive it and start the next audit from it), or use --force to delete anyway";
      return { action: "skipped", status, reason };
    }
    // unknown (missing state file) — no-op by default; caller decides how to
    // surface this (the cleanup command sets exitCode=1)
    return { action: "skipped", status: "unknown" };
  }

  if (dryRun) {
    return { action: "dry-run", status };
  }

  // The run's frozen snapshot lives outside the repository; its record is in
  // this dir, so it goes first. When it cannot be removed the dir is kept —
  // deleting the record would leak the snapshot (a checkout, a worktree
  // registration and a ref in the user's repository) — unless the operator
  // forces it: `--force` is the escape hatch, and a corrupt record would
  // otherwise refuse it for good. A forced delete names what it leaves behind.
  await assertOwnership();
  const problems = await removeRunSnapshot(artifactsDir, options.repositoryRoot);
  if (problems.length > 0) {
    if (!force) {
      return {
        action: "skipped",
        status,
        reason: `the run's snapshot could not be removed (${problems.join("; ")}); fix that, or use --force to delete anyway`,
      };
    }
    for (const problem of problems) {
      process.stderr.write(`[audit-code] run snapshot cleanup (left behind): ${problem}\n`);
    }
  }
  for (const entry of await readdir(artifactsDir)) {
    const target = join(artifactsDir, entry);
    if (entry === basename(artifactTreeLockPath(artifactsDir))) continue;
    await assertOwnership();
    await rm(target, { recursive: true, force: true });
  }
  return { action: "deleted", status };
}
