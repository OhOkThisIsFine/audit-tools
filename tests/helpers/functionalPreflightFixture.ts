import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { artifactTreeLockPath, withFileLock, writeJsonFile } from "audit-tools/shared";
import { readRunConsentUnlocked } from "../../src/shared/analyzerRunConsent.js";
import { functionalPreflightPath } from "../../src/audit/cli/functionalPreflight.js";

/** Simulated host evidence through the real run-bound artifact contract, never a production bypass. */
export async function satisfyFunctionalPreflight(root: string, artifactsDir = join(root, ".audit-tools", "audit")): Promise<void> {
  const entries = await readdir(root);
  await withFileLock(artifactTreeLockPath(artifactsDir), async () => {
    const run = await readRunConsentUnlocked(root, artifactsDir);
    await writeJsonFile(functionalPreflightPath(artifactsDir), {
      contract_version: "audit-functional-preflight/v1", run_id: run.run_id,
      repository_root: await realpath(root),
      source_inspection: { available: true, evidence: `Fixture host inspected the repository entries: ${entries.join(", ") || "empty repository"}.` },
      relationship_inspection: { available: true, evidence: "Fixture host can inspect the source relationships supplied by this test's fixture." },
      decision: "ready", operator_approved_degraded: false,
    });
  });
}
