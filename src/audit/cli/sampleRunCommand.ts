import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { buildRepoManifest } from "../extractors/fileInventory.js";
import { buildFileDisposition } from "../extractors/disposition.js";
import { buildCriticalFlowManifest } from "../extractors/flows.js";
import { buildSurfaceManifest } from "../extractors/surfaces.js";
import { buildUnitManifest } from "../orchestrator/unitBuilder.js";
import { buildFlowCoverage } from "../orchestrator/flowCoverage.js";
import { buildRuntimeValidationTasks } from "../orchestrator/runtimeValidation.js";
import { initializeCoverageFromPlan } from "../orchestrator/planning.js";
import { writeCoreArtifacts } from "../io/artifacts.js";
import {
  buildAuditReportModel,
  renderAuditReportMarkdown,
} from "../reporting/synthesis.js";
import { deriveAuditState } from "../orchestrator/state.js";
import type { AuditResult } from "../types.js";
import type { Finding } from "../../shared/types/finding.js";
import { getArtifactsDir, hasFlag } from "./args.js";
import { outputJson } from "./cliHelpers.js";

const SAMPLE_REPO_FILES = [
  { path: "src/api/auth.ts", size_bytes: 1240, hash: "abc123" },
  { path: "src/lib/session.ts", size_bytes: 980, hash: "def456" },
  { path: "infra/deploy.yml", size_bytes: 420, hash: "ghi789" },
  { path: "docs/notes.md", size_bytes: 300, hash: "doc111" },
];

/**
 * Fabricated fixture finding for the README sample-report block. It cites the
 * fabricated sample repo above, never this repository. Typed here so tsc
 * checks the fixture against the real contract; the README generator
 * (scripts/check-readme-sample-report.mjs) renders it through the real
 * renderer and excerpts the output.
 */
export const SAMPLE_REPORT_FINDING: Finding = {
  id: "FND-001",
  title: "Expired session tokens are accepted on the refresh path",
  category: "auth-token-lifecycle",
  severity: "high",
  confidence: "high",
  lens: "security",
  summary:
    "refreshSession() checks the token signature but never the expiry, so an expired token mints a fresh session.",
  affected_files: [{ path: "src/api/auth.ts", line_start: 41, line_end: 58 }],
  impact: "A leaked token stays usable indefinitely.",
  likelihood: "Any expired token replayed against the refresh endpoint.",
  evidence: [
    "The expiry field read at line 44 is never compared against the clock.",
  ],
  grounding: { status: "grounded" },
  systemic: false,
};

/**
 * Build the fabricated sample bundle. Pure — nothing is written. `sample-run`
 * persists it with no findings; the README sample-report generator threads
 * SAMPLE_REPORT_FINDING through it so the rendered report exercises the
 * per-finding template.
 */
export async function buildSampleAuditBundle(findings: Finding[] = []) {
  const repoManifest = buildRepoManifest("sample-repo", SAMPLE_REPO_FILES);
  const disposition = await buildFileDisposition(repoManifest);
  const unitManifest = buildUnitManifest(repoManifest, disposition);
  const surfaceManifest = buildSurfaceManifest(repoManifest, disposition);
  const criticalFlows = buildCriticalFlowManifest(
    repoManifest,
    surfaceManifest,
    disposition,
  );
  const coverage = initializeCoverageFromPlan(
    repoManifest,
    unitManifest,
    disposition,
  );
  const sampleUnitId = unitManifest.units[0]?.unit_id ?? "sample-unit";
  const sampleLens = "security";
  // Derive task_id from the actual unit ID + lens, matching the real planning
  // pipeline format (COR-a278fbe0 fix: no hardcoded task_id).
  const sampleTaskId = `${sampleUnitId}:${sampleLens}`;
  const sampleResults: AuditResult[] = [
    {
      task_id: sampleTaskId,
      unit_id: sampleUnitId,
      pass_id: `pass:${sampleLens}`,
      lens: sampleLens,
      agent_role: "security-auditor",
      file_coverage: [
        {
          path: "src/api/auth.ts",
          total_lines: SAMPLE_REPO_FILES.find((f) => f.path === "src/api/auth.ts")
            ? 100
            : 0,
        },
      ],
      findings,
      notes: ["Sample result ingestion path."],
      requires_followup: false,
    },
  ];
  const flowCoverage = buildFlowCoverage(criticalFlows, coverage);
  const runtimeValidationTasks = buildRuntimeValidationTasks({
    unitManifest,
    criticalFlows,
    flowCoverage,
    command: ["npm", "test"],
  });
  const runtimeValidationReport = {
    results: runtimeValidationTasks.tasks.map((task) => ({
      task_id: task.id,
      status: "confirmed" as const,
      summary: "Sample runtime validation completed.",
      evidence: [],
      notes: [],
    })),
  };
  const auditReport = renderAuditReportMarkdown(
    buildAuditReportModel({
      results: sampleResults,
      unitManifest,
      criticalFlows,
      coverageMatrix: coverage,
      runtimeValidationReport,
    }),
  );
  return {
    repoManifest,
    disposition,
    unitManifest,
    surfaceManifest,
    criticalFlows,
    coverage,
    flowCoverage,
    runtimeValidationTasks,
    runtimeValidationReport,
    sampleResults,
    auditReport,
  };
}

export async function runSample(argv: string[] = process.argv): Promise<void> {
  const {
    repoManifest,
    disposition,
    unitManifest,
    surfaceManifest,
    criticalFlows,
    coverage,
    flowCoverage,
    runtimeValidationTasks,
    runtimeValidationReport,
    sampleResults,
    auditReport,
  } = await buildSampleAuditBundle();
  const auditState = deriveAuditState({
    repo_manifest: repoManifest,
    file_disposition: disposition,
    unit_manifest: unitManifest,
    surface_manifest: surfaceManifest,
    critical_flows: criticalFlows,
    flow_coverage: flowCoverage,
    coverage_matrix: coverage,
    runtime_validation_tasks: runtimeValidationTasks,
    runtime_validation_report: runtimeValidationReport,
    audit_results: sampleResults,
    audit_report: auditReport,
  });
  const artifactsDir = getArtifactsDir(argv);
  // A live bundle (audit_state.json present) is real run state — fabricated
  // sample artifacts must never overwrite it. `--force` is the explicit
  // disposable-target override, mirroring the cleanup verb.
  if (
    existsSync(join(artifactsDir, "audit_state.json")) &&
    !hasFlag(argv, "--force")
  ) {
    console.error(
      `Refusing to write sample artifacts into '${artifactsDir}': an audit state file is present. Pass --force to overwrite a disposable target.`,
    );
    process.exitCode = 1;
    return;
  }
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, {
    repo_manifest: repoManifest,
    file_disposition: disposition,
    unit_manifest: unitManifest,
    surface_manifest: surfaceManifest,
    critical_flows: criticalFlows,
    flow_coverage: flowCoverage,
    coverage_matrix: coverage,
    runtime_validation_tasks: runtimeValidationTasks,
    runtime_validation_report: runtimeValidationReport,
    audit_results: sampleResults,
    audit_report: auditReport,
    audit_state: auditState,
  });
  outputJson({ audit_state: auditState, artifacts_dir: artifactsDir });
}
