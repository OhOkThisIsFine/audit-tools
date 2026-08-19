import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isFileMissingError, readJsonFile } from "audit-tools/shared";
import type { AuditState } from "../types/auditState.js";

export type CleanupOptions = {
  force?: boolean;
  dryRun?: boolean;
  preRun?: boolean;
};

export type CleanupResult = {
  action: "deleted" | "skipped" | "dry-run";
  status: AuditState["status"] | "unknown";
  reason?: string;
};

// Remove a stale artifacts directory. Two callers: the `cleanup` CLI command
// (cmdCleanup) and the next-step pre-run sweep (cmdNextStepBody, preRun=true).
// A missing state file means there is nothing to clean.
//
// Pre-run eligibility (preRun=true) is NOT_STARTED-ONLY: a lingering `complete`
// dir at next-step time is a live continuation — friction triage may still be
// pending, and report promotion itself deletes the dir once the report is
// copied up — so sweeping it would destroy unfinished work. `complete` dirs
// stay owned by the completion transition and the manual cleanup verb, which
// keeps its complete+not_started eligibility unchanged.
//
// With options:
//   preRun=true — pre-run sweep mode: only `not_started` is eligible.
//   force=true  — delete even when status is active/blocked or state file is missing.
//   dryRun=true — skip the actual rm call and return action='dry-run'.
// All default to false.
export async function cleanupStaleArtifactsDir(
  artifactsDir: string,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const { force = false, dryRun = false, preRun = false } = options;

  let status: AuditState["status"] | "unknown" = "unknown";
  try {
    const state = await readJsonFile<AuditState>(
      join(artifactsDir, "audit_state.json"),
    );
    status = state.status;
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    // State file missing — status stays "unknown".
  }

  const eligibleWithoutForce = preRun
    ? status === "not_started"
    : status === "complete" || status === "not_started";
  const resumable = status === "active" || status === "blocked";

  if (!eligibleWithoutForce && !force) {
    // active/blocked — caller may want to resume; skip unless forced
    if (resumable) {
      const reason = `audit is ${status} and may be resumed — use --force to delete anyway`;
      return { action: "skipped", status, reason };
    }
    // complete — only reachable in preRun mode (the verb treats complete as
    // eligible above): the dir is a live continuation, never pre-run junk.
    if (status === "complete") {
      const reason =
        "audit is complete — friction triage / report promotion own this dir; the completion transition or the cleanup command clears it";
      return { action: "skipped", status, reason };
    }
    // unknown (missing state file) — no-op by default; caller decides how to
    // surface this (the cleanup command sets exitCode=1)
    return { action: "skipped", status: "unknown" };
  }

  if (dryRun) {
    return { action: "dry-run", status };
  }

  await rm(artifactsDir, { recursive: true, force: true });
  return { action: "deleted", status };
}
