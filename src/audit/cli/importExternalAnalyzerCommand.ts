import { readJsonFile } from "audit-tools/shared";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { runAuditStep } from "./auditStep.js";
import { getArtifactsDir, getFlag, getRootDir } from "./args.js";

export async function cmdImportExternalAnalyzer(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const sourcePath = getFlag(
    argv,
    "--external-analyzer-results",
    `${artifactsDir}/external_analyzer_results.json`,
  ) as string;
  const externalAnalyzerResults =
    await readJsonFile<ExternalAnalyzerResults>(sourcePath);
  if (!Array.isArray(externalAnalyzerResults.results)) {
    throw new Error(
      `External analyzer results at '${sourcePath}' must have a 'results' array, but the field is absent or not an array.`,
    );
  }
  // Pass the already-parsed data so runAuditStep does not read the file a second time.
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    preferredExecutor: "external_analyzer_import_executor",
    externalAnalyzerData: externalAnalyzerResults,
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        tool: externalAnalyzerResults.tool,
        imported_count: externalAnalyzerResults.results.length,
        selected_executor: result.selected_executor,
      },
      null,
      2,
    ),
  );
}
