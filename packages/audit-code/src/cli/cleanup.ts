import { rm } from "node:fs/promises";
import { join } from "node:path";
import { isFileMissingError, readJsonFile } from "@audit-tools/shared";
import type { AuditState } from "../types/auditState.js";

// Remove a stale artifacts directory before starting a fresh run: if the prior
// run completed or never started, its artifacts are safe to clear. A missing
// state file means there is nothing to clean. Shared by run-to-completion
// (clears before a fresh loop) and the cleanup command.
export async function cleanupStaleArtifactsDir(
  artifactsDir: string,
): Promise<void> {
  let status: AuditState["status"] | undefined;
  try {
    const state = await readJsonFile<AuditState>(
      join(artifactsDir, "audit_state.json"),
    );
    status = state.status;
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    return;
  }
  if (status === "complete" || status === "not_started") {
    await rm(artifactsDir, { recursive: true, force: true });
  }
}
