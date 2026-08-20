import type { ExternalAnalyzerResults } from "audit-tools/shared";
import type { AuditTask, CoverageMatrix, Lens } from "../types.js";
import type { FlowCoverageManifest } from "../types/flowCoverage.js";
import type { CriticalFlowManifest } from "audit-tools/shared";
import { selectFlowLenses } from "./flowPlanning.js";
import { getExternalSignalPaths } from "./requeueUtils.js";

function taskPriority(
  hasExternalSignal: boolean,
  lens: Lens,
): "high" | "medium" | "low" {
  if (
    hasExternalSignal &&
    (lens === "security" || lens === "data_integrity" || lens === "reliability")
  ) {
    return "high";
  }
  return hasExternalSignal ? "medium" : "low";
}

function fileStillNeedsLens(
  coverageByPath: Map<string, CoverageMatrix["files"][number]>,
  path: string,
  lens: Lens,
): boolean {
  const record = coverageByPath.get(path);
  if (!record || record.audit_status === "excluded") {
    return false;
  }
  return !record.completed_lenses.includes(lens);
}

export function buildFlowRequeueTasks(
  criticalFlows: CriticalFlowManifest,
  flowCoverage: FlowCoverageManifest,
  coverageMatrix: CoverageMatrix,
  externalAnalyzerResults?: ExternalAnalyzerResults[],
): AuditTask[] {
  const flowMap = new Map(criticalFlows.flows.map((flow) => [flow.id, flow]));
  const coverageByPath = new Map(
    coverageMatrix.files.map((file) => [file.path, file]),
  );
  const tasks: AuditTask[] = [];
  const seen = new Set<string>();
  const externalPaths = getExternalSignalPaths(externalAnalyzerResults);

  for (const record of flowCoverage.flows) {
    const flow = flowMap.get(record.flow_id);
    if (!flow) {
      continue;
    }

    // Requeue follows the SAME flow-lens policy planning claims against and
    // coverage marks required against — `selectFlowLenses`, drawn from the one
    // lens registry. A non-canonical lens recorded in flow coverage is skipped
    // (not thrown on): one stray value must not abort the whole requeue.
    const requiredLenses = selectFlowLenses(
      Array.isArray(record.required_lenses) ? record.required_lenses : [],
    );
    const completedLenses = new Set(
      Array.isArray(record.completed_lenses)
        ? record.completed_lenses.filter(
            (lens): lens is string => typeof lens === "string",
          )
        : [],
    );
    const missingLenses = requiredLenses.filter(
      (lens) => !completedLenses.has(lens),
    );
    const flowPaths = Array.isArray(flow.paths)
      ? flow.paths.filter((path): path is string => typeof path === "string")
      : [];

    for (const lensName of missingLenses) {
      for (const path of flowPaths) {
        if (!fileStillNeedsLens(coverageByPath, path, lensName)) {
          continue;
        }
        const signature = `${flow.id}|${lensName}|${path}`;
        if (seen.has(signature)) {
          continue;
        }
        seen.add(signature);
        const hasExternalSignal = externalPaths.has(path);

        tasks.push({
          task_id: `flow-requeue:${flow.id}:${lensName}:${path}`,
          unit_id: flow.id,
          pass_id: `flow-requeue:${lensName}`,
          lens: lensName,
          file_paths: [path],
          rationale: `Mandatory audit coverage is still missing for critical flow ${flow.id} at ${path} under the ${lensName} lens.`,
          priority: taskPriority(hasExternalSignal, lensName),
          tags: hasExternalSignal
            ? ["critical_flow_followup", "external_analyzer_signal"]
            : ["critical_flow_followup"],
          status: "pending",
        });
      }
    }
  }

  return tasks;
}
