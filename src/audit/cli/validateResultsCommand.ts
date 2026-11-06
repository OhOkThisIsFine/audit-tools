// sites-pinned: tests/audit/frozen-snapshot.test.ts, tests/audit/inspection-handoff-binding.test.ts
import { readJsonFile } from "audit-tools/shared";
import { resolve } from "node:path";
import { loadArtifactBundle } from "../io/artifacts.js";
import { validateAuditResults } from "../validation/auditResults.js";
import { buildLineIndex } from "./lineIndex.js";
import { readRunSourceRoot } from "../io/runSnapshot.js";
import { getArtifactsDir, getFlag, getRootDir } from "./args.js";
import { checkAuditHostResult } from "./dispatch/hostHandoff.js";

const SHAPE_HINT =
  "validate-results takes either a semantic-review result — the audit-host-result/v1alpha1 object a work item's prompt " +
  "asks for, written at its bound result_path under runs/<run id>/host-results/ — or, for `ingest-results --results`, " +
  "a JSON array of AuditResult objects (wrap a single AuditResult in [ ]).";

/**
 * A host result is recognized by what it declares OR by where it lives: a file
 * at a host-results path is judged by the host door even when its
 * `contract_version` is misspelled, so the host gets that door's refusal and not
 * the array door's.
 */
function isHostResult(value: unknown, path: string): boolean {
  if (Array.isArray(value)) return false;
  const declared =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { contract_version?: unknown }).contract_version === "string" &&
    (value as { contract_version: string }).contract_version.startsWith("audit-host-result/");
  return declared || /(^|\/)host-results\/[^/]+$/u.test(resolve(path).replace(/\\/g, "/"));
}

/**
 * Check a results file BEFORE it is ingested, by the rules of the door it will
 * go through:
 *   - a host result (what every semantic-review work item asks for) is judged
 *     by `checkAuditHostResult`, the same judgment — and the same classified
 *     refusals — the next-step fold applies when it ingests that file;
 *   - anything else is judged by `validateAuditResults`, the gate of
 *     `ingest-results --results` (a JSON array of AuditResults); a lone object
 *     also gets a hint naming both shapes.
 * Neither branch writes anything.
 */
export async function cmdValidateResults(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const resultsPath = getFlag(argv, "--results");
  if (!resultsPath) {
    throw new Error("validate-results requires --results <file>");
  }
  const root = getRootDir(argv);
  const bundle = await loadArtifactBundle(artifactsDir);
  const sourceRoot = await readRunSourceRoot(root, artifactsDir);
  const lineIndex = bundle.repo_manifest
    ? await buildLineIndex(sourceRoot, bundle.repo_manifest)
    : undefined;
  const results = await readJsonFile<unknown>(resultsPath);

  if (isHostResult(results, resultsPath)) {
    const check = await checkAuditHostResult({
      root,
      sourceRoot,
      artifactsDir,
      resultPath: resultsPath,
      auditTasks: bundle.audit_tasks ?? [],
      lineIndex,
    });
    console.log(
      JSON.stringify(
        {
          artifacts_dir: artifactsDir,
          results_path: resolve(resultsPath),
          ...check,
          warning_count: check.validation_warnings.length,
          error_count: check.issues.length,
        },
        null,
        2,
      ),
    );
    process.exitCode = check.issues.length > 0 ? 1 : 0;
    return;
  }

  const issues = validateAuditResults(results, bundle.audit_tasks ?? [], {
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
        ...(Array.isArray(results) ? {} : { hint: SHAPE_HINT }),
      },
      null,
      2,
    ),
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}
