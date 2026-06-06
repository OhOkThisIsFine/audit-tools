import { mkdir } from "node:fs/promises";
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
import { getArtifactsDir } from "./args.js";

const SAMPLE_REPO_FILES = [
  { path: "src/api/auth.ts", size_bytes: 1240, hash: "abc123" },
  { path: "src/lib/session.ts", size_bytes: 980, hash: "def456" },
  { path: "infra/deploy.yml", size_bytes: 420, hash: "ghi789" },
  { path: "docs/notes.md", size_bytes: 300, hash: "doc111" },
];

export async function runSample(argv: string[] = process.argv): Promise<void> {
  const repoManifest = buildRepoManifest("sample-repo", SAMPLE_REPO_FILES);
  const disposition = buildFileDisposition(repoManifest);
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
  const sampleResults: AuditResult[] = [
    {
      task_id: "src-api:security:src/api/auth.ts:1-100",
      unit_id: unitManifest.units[0]?.unit_id ?? "sample-unit",
      pass_id: "pass:security",
      lens: "security",
      agent_role: "security-auditor",
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 100 }],
      findings: [],
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
  console.log(
    JSON.stringify(
      { audit_state: auditState, artifacts_dir: artifactsDir },
      null,
      2,
    ),
  );
}
