import type { ArtifactBundle } from "../io/artifacts.js";
import {
  type ValidationIssue,
  pushValidationIssue,
  requireKeys,
} from "audit-tools/shared";
import type { AuditUnit } from "../types.js";
import type { FileDispositionWithVcsIgnore } from "../extractors/disposition.js";
import type { RuntimeValidationTask } from "../types/runtimeValidation.js";

function pushIssue(
  issues: ValidationIssue[],
  path: string,
  message: string,
): void {
  pushValidationIssue(issues, path, message);
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// ---------------------------------------------------------------------------
// Per-artifact-type shape validators
// ---------------------------------------------------------------------------

function validateTopLevelShapes(bundle: ArtifactBundle, issues: ValidationIssue[]): void {
  if (bundle.repo_manifest) {
    issues.push(...requireKeys(bundle.repo_manifest, "repo_manifest", ["repository", "generated_at", "files"]));
  }
  if (bundle.unit_manifest) {
    issues.push(...requireKeys(bundle.unit_manifest, "unit_manifest", ["units"]));
  }
  if (bundle.coverage_matrix) {
    issues.push(...requireKeys(bundle.coverage_matrix, "coverage_matrix", ["files"]));
  }
  if (bundle.scope) {
    issues.push(...requireKeys(bundle.scope, "scope", ["mode", "since", "seed_files", "expanded_files", "budget"]));
  }
  if (bundle.intent_checkpoint) {
    issues.push(...requireKeys(bundle.intent_checkpoint, "intent_checkpoint", ["schema_version", "confirmed_at", "confirmed_by", "scope_summary", "intent_summary"]));
  }
  if (bundle.graph_bundle) {
    issues.push(...requireKeys(bundle.graph_bundle, "graph_bundle", ["graphs"]));
  }
  if (bundle.surface_manifest) {
    issues.push(...requireKeys(bundle.surface_manifest, "surface_manifest", ["surfaces"]));
  }
  if (bundle.critical_flows) {
    issues.push(...requireKeys(bundle.critical_flows, "critical_flows", ["flows"]));
  }
  if (bundle.flow_coverage) {
    issues.push(...requireKeys(bundle.flow_coverage, "flow_coverage", ["flows"]));
  }
  if (bundle.risk_register) {
    issues.push(...requireKeys(bundle.risk_register, "risk_register", ["items"]));
  }
  if (bundle.runtime_validation_tasks) {
    issues.push(...requireKeys(bundle.runtime_validation_tasks, "runtime_validation_tasks", ["tasks"]));
  }
  if (bundle.runtime_validation_report) {
    issues.push(...requireKeys(bundle.runtime_validation_report, "runtime_validation_report", ["results"]));
  }
  if (bundle.external_analyzer_results) {
    issues.push(...requireKeys(bundle.external_analyzer_results, "external_analyzer_results", ["tool", "results"]));
  }
  if (bundle.audit_plan_metrics) {
    issues.push(...requireKeys(bundle.audit_plan_metrics, "audit_plan_metrics", ["generated_at", "task_count", "packet_count"]));
  }
  if (bundle.tooling_manifest) {
    issues.push(...requireKeys(bundle.tooling_manifest, "tooling_manifest", ["generated_at", "package_root", "implementation_hash", "inputs"]));
  }
}

/** Indexes for cross-artifact consistency checks. */
interface BundleIndexes {
  repoManifestFiles: Array<{ path: string }>;
  fileDispositionEntries: Array<{ path: string; status: string }>;
  unitManifestUnits: Array<Pick<AuditUnit, "unit_id" | "files" | "required_lenses">>;
  criticalFlows: Array<{ id: string; paths: string[]; entrypoints: string[] }>;
  flowCoverageEntries: Array<{ flow_id: string; status: string; required_lenses: string[]; completed_lenses: string[] }>;
  riskRegisterItems: Array<{ unit_id: string }>;
  surfaceEntries: Array<{ id: string; entrypoint: string }>;
  runtimeValidationTasks: Array<Pick<RuntimeValidationTask, "id" | "target_paths">>;
  runtimeValidationResults: Array<{ task_id: string }>;
  externalAnalyzerResults: Array<{ id: string; path: string }>;
  auditTasks: Array<{ task_id: string; line_ranges?: Array<{ path: string; start: number; end: number }> }>;
  requeueTasks: Array<{ task_id: string; line_ranges?: Array<{ path: string; start: number; end: number }> }>;
  coverageFiles: Array<{ path: string; unit_ids: string[]; audit_status: string; required_lenses: string[]; completed_lenses: string[] }>;
  repoPaths: Set<string>;
  dispositionMap: Map<string, string>;
  unitIds: Set<string>;
  flowIds: Set<string>;
  runtimeTaskIds: Set<string>;
}

function buildIndexes(bundle: ArtifactBundle): BundleIndexes {
  const repoManifestFiles = asArray<{ path: string }>(bundle.repo_manifest?.files);
  const fileDispositionEntries = asArray<{ path: string; status: string }>(bundle.file_disposition?.files);
  const unitManifestUnits = asArray<Pick<AuditUnit, "unit_id" | "files" | "required_lenses">>(bundle.unit_manifest?.units);
  const criticalFlows = asArray<{ id: string; paths: string[]; entrypoints: string[] }>(bundle.critical_flows?.flows);
  const flowCoverageEntries = asArray<{ flow_id: string; status: string; required_lenses: string[]; completed_lenses: string[] }>(bundle.flow_coverage?.flows);
  const riskRegisterItems = asArray<{ unit_id: string }>(bundle.risk_register?.items);
  const surfaceEntries = asArray<{ id: string; entrypoint: string }>(bundle.surface_manifest?.surfaces);
  const runtimeValidationTasks = asArray<Pick<RuntimeValidationTask, "id" | "target_paths">>(bundle.runtime_validation_tasks?.tasks);
  const runtimeValidationResults = asArray<{ task_id: string }>(bundle.runtime_validation_report?.results);
  const externalAnalyzerResults = asArray<{ id: string; path: string }>(bundle.external_analyzer_results?.results);
  const auditTasks = asArray<{ task_id: string; line_ranges?: Array<{ path: string; start: number; end: number }> }>(bundle.audit_tasks);
  const requeueTasks = asArray<{ task_id: string; line_ranges?: Array<{ path: string; start: number; end: number }> }>(bundle.requeue_tasks);
  const coverageFiles = asArray<{ path: string; unit_ids: string[]; audit_status: string; required_lenses: string[]; completed_lenses: string[] }>(bundle.coverage_matrix?.files);

  return {
    repoManifestFiles,
    fileDispositionEntries,
    unitManifestUnits,
    criticalFlows,
    flowCoverageEntries,
    riskRegisterItems,
    surfaceEntries,
    runtimeValidationTasks,
    runtimeValidationResults,
    externalAnalyzerResults,
    auditTasks,
    requeueTasks,
    coverageFiles,
    repoPaths: new Set(repoManifestFiles.map((f) => f.path)),
    dispositionMap: new Map(fileDispositionEntries.map((item) => [item.path, item.status])),
    unitIds: new Set(unitManifestUnits.map((u) => u.unit_id)),
    flowIds: new Set(criticalFlows.map((f) => f.id)),
    runtimeTaskIds: new Set(runtimeValidationTasks.map((t) => t.id)),
  };
}

function validateCoverageMatrixConsistency(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.repo_manifest || !bundle.coverage_matrix) return;
  const coveragePaths = new Set(idx.coverageFiles.map((f) => f.path));
  for (const path of idx.repoPaths) {
    if (!coveragePaths.has(path)) {
      pushIssue(issues, "coverage_matrix", `Missing coverage entry for ${path}`);
    }
  }
}

function validateFileDispositionConsistency(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.repo_manifest || !bundle.file_disposition) return;
  const dispositionPaths = new Set(idx.fileDispositionEntries.map((f) => f.path));
  const aggregatePrefixes = new Set(
    asArray<{ prefix: string }>(
      (bundle.file_disposition as FileDispositionWithVcsIgnore | undefined)?.vcs_ignore?.aggregates,
    ).map((a) => a.prefix),
  );
  const coveredByAggregate = (path: string): boolean => {
    if (aggregatePrefixes.size === 0) return false;
    const posix = path.replace(/\\/g, "/");
    const slash = posix.indexOf("/");
    const prefix = slash === -1 ? "." : posix.slice(0, slash);
    return aggregatePrefixes.has(prefix);
  };
  for (const path of idx.repoPaths) {
    if (!dispositionPaths.has(path) && !coveredByAggregate(path)) {
      pushIssue(issues, "file_disposition", `Missing disposition entry for ${path}`);
    }
  }
}

function validateUnitManifest(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.unit_manifest) return;
  for (const unit of idx.unitManifestUnits) {
    if (unit.files.length === 0) {
      pushIssue(issues, `unit_manifest:${unit.unit_id}`, "Unit has no files");
    }
    if (unit.required_lenses.length === 0) {
      pushIssue(issues, `unit_manifest:${unit.unit_id}`, "Unit has no required lenses");
    }
    for (const path of unit.files) {
      if (!idx.repoPaths.has(path)) {
        pushIssue(issues, `unit_manifest:${unit.unit_id}`, `Unit references unknown file ${path}`);
      }
      const disposition = idx.dispositionMap.get(path);
      if (disposition && disposition !== "included") {
        pushIssue(issues, `unit_manifest:${unit.unit_id}`, `Unit includes non-included file ${path} with disposition ${disposition}`);
      }
    }
  }
}

function validateCoverageMatrixEntries(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.coverage_matrix || !bundle.unit_manifest) return;
  for (const file of idx.coverageFiles) {
    if (!idx.repoPaths.has(file.path)) {
      pushIssue(issues, "coverage_matrix", `Coverage contains unknown file ${file.path}`);
    }
    for (const unitId of file.unit_ids) {
      if (!idx.unitIds.has(unitId)) {
        pushIssue(issues, `coverage_matrix:${file.path}`, `Coverage references unknown unit ${unitId}`);
      }
    }
    const disposition = idx.dispositionMap.get(file.path);
    if (disposition && disposition !== "included" && file.audit_status !== "excluded") {
      pushIssue(issues, `coverage_matrix:${file.path}`, `Non-included file should be excluded in coverage; found status ${file.audit_status}`);
    }
    for (const lens of file.completed_lenses) {
      if (!file.required_lenses.includes(lens) && file.audit_status !== "excluded") {
        pushIssue(issues, `coverage_matrix:${file.path}`, `Completed lens ${lens} is not listed in required_lenses`);
      }
    }
  }
}

function validateCriticalFlows(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.critical_flows) return;
  for (const flow of idx.criticalFlows) {
    if (flow.paths.length === 0) {
      pushIssue(issues, `critical_flows:${flow.id}`, "Flow has no paths");
    }
    if (flow.entrypoints.length === 0) {
      pushIssue(issues, `critical_flows:${flow.id}`, "Flow has no entrypoints");
    }
    for (const path of flow.paths) {
      if (!idx.repoPaths.has(path)) {
        pushIssue(issues, `critical_flows:${flow.id}`, `Flow references unknown file ${path}`);
      }
      const disposition = idx.dispositionMap.get(path);
      if (disposition && disposition !== "included") {
        pushIssue(issues, `critical_flows:${flow.id}`, `Flow includes non-included file ${path} with disposition ${disposition}`);
      }
    }
  }
}

function validateFlowCoverage(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.flow_coverage || !bundle.critical_flows) return;
  for (const flow of idx.flowCoverageEntries) {
    if (!idx.flowIds.has(flow.flow_id)) {
      pushIssue(issues, `flow_coverage:${flow.flow_id}`, `Flow coverage references unknown flow ${flow.flow_id}`);
    }
    for (const lens of flow.completed_lenses) {
      if (!flow.required_lenses.includes(lens)) {
        pushIssue(issues, `flow_coverage:${flow.flow_id}`, `Completed lens ${lens} is not in required_lenses`);
      }
    }
    const expectedStatus =
      flow.required_lenses.length > 0 && flow.required_lenses.every((lens) => flow.completed_lenses.includes(lens))
        ? "complete"
        : flow.completed_lenses.length > 0
          ? "partial"
          : "pending";
    if (flow.status !== expectedStatus) {
      pushIssue(issues, `flow_coverage:${flow.flow_id}`, `Flow status ${flow.status} does not match expected ${expectedStatus}`);
    }
  }
}

function validateRiskRegister(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.risk_register || !bundle.unit_manifest) return;
  const riskUnitIds = new Set(idx.riskRegisterItems.map((item) => item.unit_id));
  for (const unit of idx.unitManifestUnits) {
    if (!riskUnitIds.has(unit.unit_id)) {
      pushIssue(issues, "risk_register", `Missing risk entry for unit ${unit.unit_id}`);
    }
  }
}

function validateSurfaceManifest(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.surface_manifest) return;
  for (const surface of idx.surfaceEntries) {
    if (!idx.repoPaths.has(surface.entrypoint)) {
      pushIssue(issues, `surface_manifest:${surface.id}`, `Surface references unknown entrypoint ${surface.entrypoint}`);
    }
    const disposition = idx.dispositionMap.get(surface.entrypoint);
    if (disposition && disposition !== "included") {
      pushIssue(issues, `surface_manifest:${surface.id}`, `Surface entrypoint ${surface.entrypoint} is not included`);
    }
  }
}

function validateRuntimeValidationTasks(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.runtime_validation_tasks) return;
  for (const task of idx.runtimeValidationTasks) {
    if (task.target_paths.length === 0) {
      pushIssue(issues, `runtime_validation_tasks:${task.id}`, "Runtime validation task has no target paths");
    }
    for (const path of task.target_paths) {
      if (!idx.repoPaths.has(path)) {
        pushIssue(issues, `runtime_validation_tasks:${task.id}`, `Runtime validation task references unknown path ${path}`);
      }
    }
  }
}

function validateRuntimeValidationReport(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.runtime_validation_report) return;
  for (const result of idx.runtimeValidationResults) {
    if (!idx.runtimeTaskIds.has(result.task_id)) {
      pushIssue(issues, `runtime_validation_report:${result.task_id}`, `Runtime validation result references unknown task ${result.task_id}`);
    }
  }
}

function validateExternalAnalyzerResults(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  if (!bundle.external_analyzer_results) return;
  for (const item of idx.externalAnalyzerResults) {
    if (!idx.repoPaths.has(item.path) && bundle.repo_manifest) {
      pushIssue(issues, `external_analyzer_results:${item.id}`, `External analyzer result references unknown path ${item.path}`);
    }
  }
}

function validateTaskLineRanges(bundle: ArtifactBundle, idx: BundleIndexes, issues: ValidationIssue[]): void {
  const taskGroups = [
    { artifactPath: "audit_tasks", tasks: idx.auditTasks },
    { artifactPath: "requeue_tasks", tasks: idx.requeueTasks },
  ];
  for (const { artifactPath, tasks } of taskGroups) {
    for (const task of tasks) {
      for (const [rangeIndex, range] of (task.line_ranges ?? []).entries()) {
        const path = `${artifactPath}:${task.task_id}.line_ranges:${rangeIndex}`;
        if (range.start < 1) {
          pushIssue(issues, path, "Line range start must be a positive 1-based integer");
        }
        if (range.end < 1) {
          pushIssue(issues, path, "Line range end must be a positive 1-based integer");
        }
        if (range.end < range.start) {
          pushIssue(issues, path, "Line range end must be greater than or equal to start");
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function validateArtifactBundle(
  bundle: ArtifactBundle,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Per-artifact shape checks (required keys).
  validateTopLevelShapes(bundle, issues);

  // Build cross-artifact indexes once.
  const idx = buildIndexes(bundle);

  // Cross-artifact consistency checks (one helper per artifact pair).
  validateCoverageMatrixConsistency(bundle, idx, issues);
  validateFileDispositionConsistency(bundle, idx, issues);
  validateUnitManifest(bundle, idx, issues);
  validateCoverageMatrixEntries(bundle, idx, issues);
  validateCriticalFlows(bundle, idx, issues);
  validateFlowCoverage(bundle, idx, issues);
  validateRiskRegister(bundle, idx, issues);
  validateSurfaceManifest(bundle, idx, issues);
  validateRuntimeValidationTasks(bundle, idx, issues);
  validateRuntimeValidationReport(bundle, idx, issues);
  validateExternalAnalyzerResults(bundle, idx, issues);
  validateTaskLineRanges(bundle, idx, issues);

  if (issues.length > 0) {
    process.stderr.write(
      `[artifact-bundle validation] ${issues.length} issue(s)\n`,
    );
  }

  return issues;
}
