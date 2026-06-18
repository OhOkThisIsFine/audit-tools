import { readJsonFile } from "audit-tools/shared";
import { resolve } from "node:path";
import { loadArtifactBundle } from "../io/artifacts.js";
import { validateAuditResults } from "../validation/auditResults.js";
import { buildLineIndex } from "./lineIndex.js";
import { getArtifactsDir, getFlag, getRootDir } from "./args.js";

export async function cmdValidateResults(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const resultsPath = getFlag(argv, "--results");
  if (!resultsPath) {
    throw new Error("validate-results requires --results <file>");
  }
  const bundle = await loadArtifactBundle(artifactsDir);
  const lineIndex = bundle.repo_manifest
    ? await buildLineIndex(getRootDir(argv), bundle.repo_manifest)
    : undefined;
  const auditResults = await readJsonFile<unknown>(resultsPath);
  const issues = validateAuditResults(auditResults, bundle.audit_tasks ?? [], {
    lineIndex,
  });
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        results_path: resolve(resultsPath),
        warning_count: warnings.length,
        error_count: errors.length,
        issues,
      },
      null,
      2,
    ),
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}
