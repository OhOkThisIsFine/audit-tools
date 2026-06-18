import { runAuditStep } from "./auditStep.js";
import { getArtifactsDir, getFlag, getRootDir } from "./args.js";

export async function cmdUpdateRuntimeValidation(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    preferredExecutor: "runtime_validation_update_executor",
    runtimeUpdatesPath: getFlag(argv, "--updates"),
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
