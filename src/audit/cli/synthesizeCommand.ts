import { runAuditStep } from "./auditStep.js";
import { getArtifactsDir, getRootDir } from "./args.js";
import { outputJson } from "./cliHelpers.js";

export async function cmdSynthesize(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    preferredExecutor: "synthesis_executor",
  });
  outputJson({
    artifacts_dir: artifactsDir,
    selected_executor: result.selected_executor,
    progress_summary: result.progress_summary,
  });
}
