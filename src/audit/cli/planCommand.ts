import { runAuditStep } from "./auditStep.js";
import { getArtifactsDir, getFlag, getRootDir } from "./args.js";

export async function cmdPlan(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    since: getFlag(argv, "--since"),
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        selected_executor: result.selected_executor,
        progress_summary: result.progress_summary,
        next_likely_step: result.next_likely_step,
      },
      null,
      2,
    ),
  );
}
