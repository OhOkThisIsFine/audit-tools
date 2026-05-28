import type { ArtifactBundle } from "../io/artifacts.js";
import {
  type ValidationIssue,
  pushValidationIssue,
  requireKeys,
} from "@audit-tools/shared";

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

function hasOwnProperty(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function validateArtifactBundle(
  bundle: ArtifactBundle,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (bundle.repo_manifest) {
    issues.push(
      ...requireKeys(
        bundle.repo_manifest,
        "repo_manifest",
        ["repository", "generated_at", "files"],
      ),
    );
  }
  if (bundle.unit_manifest) {
    issues.push(
      ...requireKeys(
        bundle.unit_manifest,
        "unit_manifest",
        ["units"],
      ),
    );
  }
  if (bundle.coverage_matrix) {
    issues.push(
      ...requireKeys(
        bundle.coverage_matrix,
        "coverage_matrix",
        ["files"],
      ),
    );
  }
  if (bundle.graph_bundle) {
    issues.push(
      ...requireKeys(
        bundle.graph_bundle,
        "graph_bundle",
        ["graphs"],
      ),
    );
  }
  if (bundle.surface_manifest) {
    issues.push(
      ...requireKeys(
        bundle.surface_manifest,
        "surface_manifest",
        ["surfaces"],
      ),
    );
  }
  if (bundle.critical_flows) {
    issues.push(
      ...requireKeys(
        bundle.critical_flows,
        "critical_flows",
        ["flows"],
      ),
    );
  }
  if (bundle.flow_coverage) {
    issues.push(
      ...requireKeys(
        bundle.flow_coverage,
        "flow_coverage",
        ["flows"],
      ),
    );
  }
  if (bundle.risk_register) {
    issues.push(
      ...requireKeys(
        bundle.risk_register,
        "risk_register",
        ["items"],
      ),
    );
  }
  if (bundle.runtime_validation_tasks) {
    issues.push(
      ...requireKeys(
        bundle.runtime_validation_tasks,
        "runtime_validation_tasks",
        ["tasks"],
      ),
    );
  }
  if (bundle.runtime_validation_report) {
    issues.push(
      ...requireKeys(
        bundle.runtime_validation_report,
        "runtime_validation_report",
        ["results"],
      ),
    );
  }
  if (bundle.external_analyzer_results) {
    issues.push(
      ...requireKeys(
        bundle.external_analyzer_results,
        "external_analyzer_results",
        ["tool", "results"],
      ),
    );
  }
  if (bundle.audit_plan_metrics) {
    issues.push(
      ...requireKeys(
        bundle.audit_plan_metrics,
        "audit_plan_metrics",
        ["generated_at", "task_count", "packet_count"],
      ),
    );
  }
  if (bundle.review_packets) {
    for (const [index, packet] of bundle.review_packets.entries()) {
      issues.push(
        ...requireKeys(packet, `review_packets:${index}`, [
          "packet_id",
          "task_ids",
          "lenses",
          "file_paths",
          "file_line_counts",
        ]),
      );
    }
  }
  if (bundle.tooling_manifest) {
    issues.push(
      ...requireKeys(
        bundle.tooling_manifest,
        "tooling_manifest",
        ["generated_at", "package_root", "implementation_hash", "inputs"],
      ),
    );
  }

  const repoManifestFiles = asArray<{ path: string }>(bundle.repo_manifest?.files);
  const fileDispositionEntries = asArray<{ path: string; status: string }>(
    bundle.file_disposition?.files,
  );
  const unitManifestUnits = asArray<{
    unit_id: string;
    files: string[];
    required_lenses: string[];
  }>(bundle.unit_manifest?.units);
  const criticalFlows = asArray<{
    id: string;
    paths: string[];
    entrypoints: string[];
  }>(bundle.critical_flows?.flows);
  const flowCoverageEntries = asArray<{
    flow_id: string;
    status: string;
    required_lenses: string[];
    completed_lenses: string[];
  }>(bundle.flow_coverage?.flows);
  const riskRegisterItems = asArray<{ unit_id: string }>(bundle.risk_register?.items);
  const surfaceEntries = asArray<{ id: string; entrypoint: string }>(
    bundle.surface_manifest?.surfaces,
  );
  const runtimeValidationTasks = asArray<{
    id: string;
    target_paths: string[];
  }>(bundle.runtime_validation_tasks?.tasks);
  const runtimeValidationResults = asArray<{ task_id: string }>(
    bundle.runtime_validation_report?.results,
  );
  const externalAnalyzerResults = asArray<{ id: string; path: string }>(
    bundle.external_analyzer_results?.results,
  );
  const auditTasks = asArray<{
    task_id: string;
    line_ranges?: Array<{ path: string; start: number; end: number }>;
  }>(bundle.audit_tasks);
  const requeueTasks = asArray<{
    task_id: string;
    line_ranges?: Array<{ path: string; start: number; end: number }>;
  }>(bundle.requeue_tasks);
  const reviewPackets = asArray<{
    packet_id: string;
    file_paths: string[];
    file_line_counts: Record<string, number>;
  }>(bundle.review_packets);
  const coverageFiles = asArray<{
    path: string;
    unit_ids: string[];
    audit_status: string;
    required_lenses: string[];
    completed_lenses: string[];
  }>(bundle.coverage_matrix?.files);

  const repoPaths = new Set(repoManifestFiles.map((file) => file.path));
  const dispositionMap = new Map(
    fileDispositionEntries.map((item) => [item.path, item.status]),
  );
  const unitIds = new Set(unitManifestUnits.map((unit) => unit.unit_id));
  const flowIds = new Set(criticalFlows.map((flow) => flow.id));
  const runtimeTaskIds = new Set(
    runtimeValidationTasks.map((task) => task.id),
  );

  if (bundle.repo_manifest && bundle.coverage_matrix) {
    const coveragePaths = new Set(coverageFiles.map((file) => file.path));
    for (const path of repoPaths) {
      if (!coveragePaths.has(path)) {
        pushIssue(
          issues,
          "coverage_matrix",
          `Missing coverage entry for ${path}`,
        );
      }
    }
  }

  if (bundle.repo_manifest && bundle.file_disposition) {
    const dispositionPaths = new Set(
      fileDispositionEntries.map((file) => file.path),
    );
    for (const path of repoPaths) {
      if (!dispositionPaths.has(path)) {
        pushIssue(
          issues,
          "file_disposition",
          `Missing disposition entry for ${path}`,
        );
      }
    }
  }

  if (bundle.unit_manifest) {
    for (const unit of unitManifestUnits) {
      if (unit.files.length === 0) {
        pushIssue(issues, `unit_manifest:${unit.unit_id}`, "Unit has no files");
      }
      if (unit.required_lenses.length === 0) {
        pushIssue(
          issues,
          `unit_manifest:${unit.unit_id}`,
          "Unit has no required lenses",
        );
      }
      for (const path of unit.files) {
        if (!repoPaths.has(path)) {
          pushIssue(
            issues,
            `unit_manifest:${unit.unit_id}`,
            `Unit references unknown file ${path}`,
          );
        }
        const disposition = dispositionMap.get(path);
        if (disposition && disposition !== "included") {
          pushIssue(
            issues,
            `unit_manifest:${unit.unit_id}`,
            `Unit includes non-included file ${path} with disposition ${disposition}`,
          );
        }
      }
    }
  }

  if (bundle.coverage_matrix && bundle.unit_manifest) {
    for (const file of coverageFiles) {
      if (!repoPaths.has(file.path)) {
        pushIssue(
          issues,
          "coverage_matrix",
          `Coverage contains unknown file ${file.path}`,
        );
      }
      for (const unitId of file.unit_ids) {
        if (!unitIds.has(unitId)) {
          pushIssue(
            issues,
            `coverage_matrix:${file.path}`,
            `Coverage references unknown unit ${unitId}`,
          );
        }
      }
      const disposition = dispositionMap.get(file.path);
      if (
        disposition &&
        disposition !== "included" &&
        file.audit_status !== "excluded"
      ) {
        pushIssue(
          issues,
          `coverage_matrix:${file.path}`,
          `Non-included file should be excluded in coverage; found status ${file.audit_status}`,
        );
      }
      for (const lens of file.completed_lenses) {
        if (
          !file.required_lenses.includes(lens) &&
          file.audit_status !== "excluded"
        ) {
          pushIssue(
            issues,
            `coverage_matrix:${file.path}`,
            `Completed lens ${lens} is not listed in required_lenses`,
          );
        }
      }
    }
  }

  if (bundle.critical_flows) {
    for (const flow of criticalFlows) {
      if (flow.paths.length === 0) {
        pushIssue(issues, `critical_flows:${flow.id}`, "Flow has no paths");
      }
      if (flow.entrypoints.length === 0) {
        pushIssue(
          issues,
          `critical_flows:${flow.id}`,
          "Flow has no entrypoints",
        );
      }
      for (const path of flow.paths) {
        if (!repoPaths.has(path)) {
          pushIssue(
            issues,
            `critical_flows:${flow.id}`,
            `Flow references unknown file ${path}`,
          );
        }
        const disposition = dispositionMap.get(path);
        if (disposition && disposition !== "included") {
          pushIssue(
            issues,
            `critical_flows:${flow.id}`,
            `Flow includes non-included file ${path} with disposition ${disposition}`,
          );
        }
      }
    }
  }

  if (bundle.flow_coverage && bundle.critical_flows) {
    for (const flow of flowCoverageEntries) {
      if (!flowIds.has(flow.flow_id)) {
        pushIssue(
          issues,
          `flow_coverage:${flow.flow_id}`,
          `Flow coverage references unknown flow ${flow.flow_id}`,
        );
      }
      for (const lens of flow.completed_lenses) {
        if (!flow.required_lenses.includes(lens)) {
          pushIssue(
            issues,
            `flow_coverage:${flow.flow_id}`,
            `Completed lens ${lens} is not in required_lenses`,
          );
        }
      }
      const expectedStatus =
        flow.required_lenses.length > 0 &&
        flow.required_lenses.every((lens) =>
          flow.completed_lenses.includes(lens),
        )
          ? "complete"
          : flow.completed_lenses.length > 0
            ? "partial"
            : "pending";
      if (flow.status !== expectedStatus) {
        pushIssue(
          issues,
          `flow_coverage:${flow.flow_id}`,
          `Flow status ${flow.status} does not match expected ${expectedStatus}`,
        );
      }
    }
  }

  if (bundle.risk_register && bundle.unit_manifest) {
    const riskUnitIds = new Set(riskRegisterItems.map((item) => item.unit_id));
    for (const unit of unitManifestUnits) {
      if (!riskUnitIds.has(unit.unit_id)) {
        pushIssue(
          issues,
          "risk_register",
          `Missing risk entry for unit ${unit.unit_id}`,
        );
      }
    }
  }

  if (bundle.surface_manifest) {
    for (const surface of surfaceEntries) {
      if (!repoPaths.has(surface.entrypoint)) {
        pushIssue(
          issues,
          `surface_manifest:${surface.id}`,
          `Surface references unknown entrypoint ${surface.entrypoint}`,
        );
      }
      const disposition = dispositionMap.get(surface.entrypoint);
      if (disposition && disposition !== "included") {
        pushIssue(
          issues,
          `surface_manifest:${surface.id}`,
          `Surface entrypoint ${surface.entrypoint} is not included`,
        );
      }
    }
  }

  if (bundle.runtime_validation_tasks) {
    for (const task of runtimeValidationTasks) {
      if (task.target_paths.length === 0) {
        pushIssue(
          issues,
          `runtime_validation_tasks:${task.id}`,
          "Runtime validation task has no target paths",
        );
      }
      for (const path of task.target_paths) {
        if (!repoPaths.has(path)) {
          pushIssue(
            issues,
            `runtime_validation_tasks:${task.id}`,
            `Runtime validation task references unknown path ${path}`,
          );
        }
      }
    }
  }

  if (bundle.runtime_validation_report) {
    for (const result of runtimeValidationResults) {
      if (!runtimeTaskIds.has(result.task_id)) {
        pushIssue(
          issues,
          `runtime_validation_report:${result.task_id}`,
          `Runtime validation result references unknown task ${result.task_id}`,
        );
      }
    }
  }

  if (bundle.external_analyzer_results) {
    for (const item of externalAnalyzerResults) {
      if (!repoPaths.has(item.path) && bundle.repo_manifest) {
        pushIssue(
          issues,
          `external_analyzer_results:${item.id}`,
          `External analyzer result references unknown path ${item.path}`,
        );
      }
    }
  }

  const taskGroups = [
    { artifactPath: "audit_tasks", tasks: auditTasks },
    { artifactPath: "requeue_tasks", tasks: requeueTasks },
  ];
  for (const { artifactPath, tasks } of taskGroups) {
    for (const task of tasks) {
      for (const [rangeIndex, range] of (task.line_ranges ?? []).entries()) {
        const path = `${artifactPath}:${task.task_id}.line_ranges:${rangeIndex}`;
        if (range.start < 1) {
          pushIssue(
            issues,
            path,
            "Line range start must be a positive 1-based integer",
          );
        }
        if (range.end < 1) {
          pushIssue(
            issues,
            path,
            "Line range end must be a positive 1-based integer",
          );
        }
        if (range.end < range.start) {
          pushIssue(
            issues,
            path,
            "Line range end must be greater than or equal to start",
          );
        }
      }
    }
  }

  if (bundle.review_packets) {
    for (const [index, packet] of reviewPackets.entries()) {
      const filePaths = asArray<string>(packet.file_paths);
      const missingPaths = filePaths.filter(
        (path) => !hasOwnProperty(packet.file_line_counts ?? {}, path),
      );
      if (missingPaths.length > 0) {
        pushIssue(
          issues,
          `review_packets:${packet.packet_id ?? index}`,
          `Every listed file must have a corresponding file_line_counts entry; missing ${missingPaths.join(", ")}`,
        );
      }
    }
  }

  return issues;
}
