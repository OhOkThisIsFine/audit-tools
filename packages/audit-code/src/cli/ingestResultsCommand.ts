import { runAuditStep, ingestBatchAuditResults } from "./auditStep.js";
import { getArtifactsDir, getBatchResultsDir, getFlag, getRootDir } from "./args.js";

export async function cmdIngestResults(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const batchResultsDir = getBatchResultsDir(argv);
  if (batchResultsDir && getFlag(argv, "--results")) {
    throw new Error("Use either --results <file> or --batch-results <dir>, not both.");
  }
  if (batchResultsDir) {
    const result = await ingestBatchAuditResults({
      root: getRootDir(argv),
      artifactsDir,
      batchDir: batchResultsDir,
    });
    console.log(
      JSON.stringify(
        {
          artifacts_dir: artifactsDir,
          imported_files: result.batchFiles,
          selected_executor: result.selected_executor,
          progress_summary: result.progress_summary,
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    preferredExecutor: "result_ingestion_executor",
    auditResultsPath: getFlag(argv, "--results"),
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
