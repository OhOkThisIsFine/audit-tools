// sites-pinned: tests/audit/frozen-snapshot.test.ts
import { lstat, readdir, realpath, rm, rmdir, stat } from "node:fs/promises";
import { isArtifactTreeHoldEntry, withArtifactTreeHold } from "../../shared/io/artifactTreeHold.js";
import { foldReceiptPath, hasPendingFoldReceipt } from "../io/foldReceiptPath.js";
import { join, relative, sep } from "node:path";
import { auditToolsDir, hashContent, isFileMissingError, isJsonParseError, readJsonFile, readOptionalJsonFile, resolveWithinRoot, writeJsonFile } from "audit-tools/shared";
import { ARTIFACT_DEFINITIONS, isWorkingDirFullyPromoted, retiredRunEvidenceIsArchived } from "../io/artifacts.js";
import { assertCleanupSnapshotOwnership, removeRunSnapshot } from "../io/runSnapshot.js";
import { AuditTopLevelStatusSchema, type AuditState } from "../types/auditState.js";

export type CleanupOptions = {
  repositoryRoot?: string;
  force?: boolean;
  dryRun?: boolean;
  requireAuditMarker?: boolean;
  explicitTarget?: { root: string; custom: boolean };
};

export type CleanupResult = {
  action: "deleted" | "skipped" | "dry-run";
  status: AuditState["status"] | "unknown";
  reason?: string;
};

async function inspectDirectory(root: string, target: string): Promise<void> {
  if (resolveWithinRoot(root, target, { allowRoot: false }) === null) {
    throw new Error(`Refusing cleanup: ${target} is not strictly inside the audit root ${root}.`);
  }
  let current = root;
  for (const segment of ["", ...relative(root, target).split(sep)]) {
    current = join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Refusing cleanup: unsafe directory topology at ${current}.`);
    }
  }
  const physicalRoot = await realpath(root);
  const physicalTarget = await realpath(target);
  if (resolveWithinRoot(physicalRoot, physicalTarget, { allowRoot: false }) === null) {
    throw new Error(`Refusing cleanup: the resolved target escapes the audit root: ${target}.`);
  }
  if (relative(physicalRoot, physicalTarget).split(sep).some(part => part.toLowerCase() === ".git")) {
    throw new Error(`Refusing cleanup: ${target} is inside repository Git metadata.`);
  }
  if (resolveWithinRoot(physicalTarget, auditToolsDir(physicalRoot)) !== null) {
    throw new Error(`Refusing cleanup: ${target} contains the shared audit tools output directory.`);
  }
}

async function inspectEntry(path: string) {
  return lstat(path).catch(error => {
    if (isFileMissingError(error)) return undefined;
    throw error;
  });
}

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
//                 work left; explicit cleanup still requires a state marker.
//   dryRun=true — skip the actual rm call and return action='dry-run'.
// Both default to false.
export async function cleanupStaleArtifactsDir(
  artifactsDir: string,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  try {
    if (options.explicitTarget) await inspectDirectory(options.explicitTarget.root, artifactsDir);
    else await stat(artifactsDir);
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
  const target = options.explicitTarget;
  if (target) await inspectDirectory(target.root, artifactsDir);
  if (target ? await inspectEntry(foldReceiptPath(artifactsDir)) : await hasPendingFoldReceipt(artifactsDir)) {
    return { action: "skipped", status: "unknown", reason: "An incomplete fold receipt must be recovered using next-step." };
  }

  const marker = ARTIFACT_DEFINITIONS.audit_state.fileName;
  const sweepName = "cleanup-sweep.json";
  const sweepPath = join(artifactsDir, sweepName);
  let status: AuditState["status"] | "unknown" = "unknown";
  let stateDigest: string | undefined;
  let corrupt = false;
  if (target) {
    const info = await inspectEntry(join(artifactsDir, marker));
    if (info && (!info.isFile() || info.isSymbolicLink())) {
      throw new Error(`Refusing cleanup: unsafe audit state marker at ${join(artifactsDir, marker)}.`);
    }
  }
  try {
    const state = await readJsonFile<AuditState>(join(artifactsDir, marker));
    if (target) {
      const parsed = AuditTopLevelStatusSchema.safeParse(state?.status);
      if (parsed.success) status = parsed.data;
      else corrupt = true;
    } else {
      status = state.status;
    }
    if (!corrupt) stateDigest = hashContent(JSON.stringify(state));
  } catch (error) {
    if (target && force && isJsonParseError(error)) corrupt = true;
    else if (!isFileMissingError(error)) throw error;
  }

  if (force && options.requireAuditMarker && status === "unknown" && !corrupt) {
    return { action: "skipped", status, reason: "The working audit no longer has its identity marker; refusing forced cleanup." };
  }

  const requireSnapshot = target !== undefined && (target.custom || (force && corrupt));
  if (requireSnapshot) {
    await assertOwnership();
    await assertCleanupSnapshotOwnership(target.root, artifactsDir);
  }

  const sweep = !force && stateDigest && (status === "not_started" || status === "complete")
    ? await readOptionalJsonFile<{ state_sha256?: unknown }>(sweepPath)
    : undefined;
  const sweepReady = stateDigest !== undefined && sweep?.state_sha256 === stateDigest;
  if (!force && !sweepReady && status === "not_started" && !(await retiredRunEvidenceIsArchived(artifactsDir))) {
    return { action: "skipped", status, reason: "Historical audit evidence is not safely archived. The working audit was kept." };
  }

  const stale =
    status === "not_started" ||
    (status === "complete" && (force || sweepReady || (await isWorkingDirFullyPromoted(artifactsDir))));
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
    if (!force || requireSnapshot) {
      return {
        action: "skipped",
        status,
        reason: `the run's snapshot could not be removed (${problems.join("; ")})` +
          (requireSnapshot ? "; refusing cleanup without safe snapshot removal" : "; fix that, or use --force to delete anyway"),
      };
    }
    for (const problem of problems) {
      process.stderr.write(`[audit-code] run snapshot cleanup (left behind): ${problem}\n`);
    }
  }
  if (!force && !sweepReady && stateDigest !== undefined) {
    // Custody was verified above; do not ask a retry to reread the copy it
    // already removed. Bind the permission to this exact working run state.
    await assertOwnership();
    await writeJsonFile(sweepPath, { state_sha256: stateDigest });
  }
  for (const entry of await readdir(artifactsDir)) {
    if (entry === marker || entry === sweepName || isArtifactTreeHoldEntry(artifactsDir, entry)) continue;
    await assertOwnership();
    await rm(join(artifactsDir, entry), { recursive: true, force: true });
  }
  // Keep the identity needed for a forced retry until the sweep succeeds.
  await assertOwnership();
  await rm(join(artifactsDir, marker), { force: true });
  await assertOwnership();
  await rm(sweepPath, { force: true });
  return { action: "deleted", status };
}
