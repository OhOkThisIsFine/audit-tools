import { runAuditStep } from "./auditStep.js";
import { getArtifactsDir, getRootDir } from "./args.js";

/**
 * Deterministically synthesize from the evidence currently accepted by the
 * audit ledger. This recovery command does not invent completion, strand work,
 * or mutate execution state; uncovered tasks remain visible as uncovered.
 */
export async function cmdForceSynthesis(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root,
    artifactsDir,
    preferredExecutor: "synthesis_executor",
  });

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        selected_executor: result.selected_executor,
        progress_summary: result.progress_summary,
      },
      null,
      2,
    ),
  );
}
