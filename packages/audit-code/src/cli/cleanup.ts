import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isFileMissingError, readJsonFile } from "@audit-tools/shared";
import type { AuditState } from "../types/auditState.js";

export type CleanupOptions = {
  force?: boolean;
  dryRun?: boolean;
};

export type CleanupResult = {
  action: "deleted" | "skipped" | "dry-run";
  status: AuditState["status"] | "unknown";
  reason?: string;
};

// Remove a stale artifacts directory before starting a fresh run: if the prior
// run completed or never started, its artifacts are safe to clear. A missing
// state file means there is nothing to clean. Shared by run-to-completion
// (clears before a fresh loop) and the cleanup command.
//
// With options:
//   force=true  — delete even when status is active/blocked or state file is missing.
//   dryRun=true — skip the actual rm call and return action='dry-run'.
// Both default to false; the no-args call from run-to-completion is unchanged.
export async function cleanupStaleArtifactsDir(
  artifactsDir: string,
  options: CleanupOptions = {},
): Promise<CleanupResult> {
  const { force = false, dryRun = false } = options;

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

  const eligibleWithoutForce = status === "complete" || status === "not_started";
  const resumable = status === "active" || status === "blocked";

  if (!eligibleWithoutForce && !force) {
    // active/blocked — caller may want to resume; skip unless forced
    if (resumable) {
      const reason = `audit is ${status} and may be resumed — use --force to delete anyway`;
      return { action: "skipped", status, reason };
    }
    // unknown (missing state file) — no-op by default; caller decides how to
    // surface this (run-to-completion ignores it; cleanup command sets exitCode=1)
    return { action: "skipped", status: "unknown" };
  }

  if (dryRun) {
    return { action: "dry-run", status };
  }

  await rm(artifactsDir, { recursive: true, force: true });
  return { action: "deleted", status };
}
