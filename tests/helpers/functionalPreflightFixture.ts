import { readdir } from "node:fs/promises";
import { writeJsonFile } from "audit-tools/shared";
import { getAnalyzerPolicyPath } from "../../src/shared/analyzerPolicy.js";
import { auditArtifactsDir } from "../../src/shared/io/auditToolsPaths.js";
import { readRunConsentUnlocked, updateRunConsentUnlocked } from "../../src/shared/analyzerRunConsent.js";
import { withArtifactTreeHold } from "../../src/shared/io/artifactTreeHold.js";
import { functionalPreflightPath } from "../../src/audit/cli/functionalPreflight.js";

interface FixtureRunOptions {
  artifactsDir?: string;
  declinedAnalyzerIds?: readonly string[];
  preflight: boolean;
}

/** Seed run-bound fixture inputs under the same artifact-tree hold used by the fold. */
export async function prepareFixtureRun(
  root: string,
  { artifactsDir = auditArtifactsDir(root), declinedAnalyzerIds = [], preflight }: FixtureRunOptions,
): Promise<void> {
  getAnalyzerPolicyPath(root); // Reject a relative root before creating a lock or run record.
  const entries = preflight ? await readdir(root) : undefined;
  await withArtifactTreeHold(artifactsDir, undefined, async () => {
    const declines = Object.fromEntries(declinedAnalyzerIds.map(id => [id, "declined" as const]));
    const run = declinedAnalyzerIds.length
      ? await updateRunConsentUnlocked(root, artifactsDir, declines)
      : await readRunConsentUnlocked(root, artifactsDir);
    if (!entries) return;
    await writeJsonFile(functionalPreflightPath(artifactsDir), {
      contract_version: "audit-functional-preflight/v1", run_id: run.run_id,
      repository_root: run.repository_root,
      source_inspection: { available: true, evidence: `Fixture host inspected the repository entries: ${entries.join(", ") || "empty repository"}.` },
      relationship_inspection: { available: true, evidence: "Fixture host can inspect the source relationships supplied by this test's fixture." },
      decision: "ready", operator_approved_degraded: false,
    });
  });
}

export function satisfyFunctionalPreflight(root: string, artifactsDir?: string): Promise<void> {
  return prepareFixtureRun(root, { artifactsDir, preflight: true });
}
