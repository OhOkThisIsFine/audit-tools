import type { UnitManifest } from "../types.js";
import type { FlowCoverageManifest } from "../types/flowCoverage.js";
import type { CriticalFlowManifest } from "audit-tools/shared";
import { discoverProjectCommands } from "audit-tools/shared";
import type {
  RuntimeValidationReport,
  RuntimeValidationTask,
  RuntimeValidationTaskManifest,
} from "../types/runtimeValidation.js";

function checksForFlow(requiredLenses: string[]): string[] {
  const checks: string[] = [];
  if (requiredLenses.includes("security")) {
    checks.push("Exercise malformed or unauthorized inputs against the flow.");
  }
  if (requiredLenses.includes("reliability")) {
    checks.push("Exercise retries or repeated submissions.");
  }
  if (requiredLenses.includes("correctness")) {
    checks.push("Exercise representative success and edge-case behavior.");
  }
  if (requiredLenses.includes("data_integrity")) {
    checks.push("Verify state transitions and persistence invariants.");
  }
  return checks;
}

export async function discoverRuntimeValidationCommand(
  root: string,
): Promise<string[] | undefined> {
  // Shared discovery (Node test script → Go → Python) is the single source of
  // truth; the runtime-validation command is the discovered test command.
  return discoverProjectCommands(root).test;
}

export function buildRuntimeValidationTasks(params: {
  unitManifest: UnitManifest;
  criticalFlows?: CriticalFlowManifest;
  flowCoverage?: FlowCoverageManifest;
  command?: string[];
}): RuntimeValidationTaskManifest {
  if (!params.command) {
    return { tasks: [] };
  }

  const tasks: RuntimeValidationTask[] = [];
  const seen = new Set<string>();

  const highRiskUnits = params.unitManifest.units.filter(
    (unit) =>
      (unit.risk_score ?? 0) >= 5 ||
      unit.required_lenses.includes("security") ||
      unit.required_lenses.includes("data_integrity"),
  );

  for (const unit of highRiskUnits) {
    const id = `runtime:unit:${unit.unit_id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    tasks.push({
      id,
      kind: "unit-risk-check",
      target_paths: unit.files,
      reason: `Unit ${unit.unit_id} is high risk or touches sensitive concerns.`,
      priority: (unit.risk_score ?? 0) >= 7 ? "high" : "medium",
      command: params.command,
      suggested_checks: [
        "Run the deterministic runtime command for the repository.",
        "Confirm the affected unit does not regress under the command output.",
      ],
      source_artifacts: ["unit_manifest.json", "risk_register.json"],
    });
  }

  if (params.criticalFlows && params.flowCoverage) {
    const flowMap = new Map(
      params.criticalFlows.flows.map((flow) => [flow.id, flow]),
    );
    for (const record of params.flowCoverage.flows) {
      if (record.status === "complete") {
        continue;
      }
      const flow = flowMap.get(record.flow_id);
      if (!flow) {
        continue;
      }

      const id = `runtime:flow:${record.flow_id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      tasks.push({
        id,
        kind: "critical-flow-check",
        target_paths: flow.paths,
        reason: `Critical flow ${record.flow_id} is still ${record.status} and needs deterministic runtime validation.`,
        priority: record.status === "pending" ? "high" : "medium",
        command: params.command,
        suggested_checks: checksForFlow(record.required_lenses),
        source_artifacts: ["critical_flows.json", "flow_coverage.json"],
      });
    }
  }

  return { tasks };
}

export function mergeRuntimeValidationReport(
  tasks: RuntimeValidationTaskManifest,
  existing?: RuntimeValidationReport,
): RuntimeValidationReport {
  const existingMap = new Map(
    (existing?.results ?? []).map((result) => [result.task_id, result]),
  );
  return {
    results: tasks.tasks.map((task) => {
      const prior = existingMap.get(task.id);
      return (
        prior ?? {
          task_id: task.id,
          status: "pending",
          summary: `Deterministic runtime validation has not executed yet for ${task.id}.`,
          evidence: [],
          notes: [],
        }
      );
    }),
  };
}
