import type { CoverageMatrix } from "../types.js";
import type {
  FlowCoverageManifest,
  FlowCoverageStatus,
} from "../types/flowCoverage.js";
import type { CriticalFlowManifest } from "audit-tools/shared";
import { selectFlowLenses } from "./flowPlanning.js";

export function buildFlowCoverage(
  criticalFlows: CriticalFlowManifest,
  coverageMatrix: CoverageMatrix,
): FlowCoverageManifest {
  const coverageByPath = new Map(
    coverageMatrix.files.map((file) => [file.path, file]),
  );
  const flows = criticalFlows.flows.map((flow) => {
    const flowPaths = Array.isArray(flow.paths)
      ? flow.paths.filter((path): path is string => typeof path === "string")
      : [];
    // The lenses coverage marks REQUIRED come from the same flow-lens policy
    // planning claims blocks against and requeue mints follow-ups against —
    // `selectFlowLenses`, drawn from the one lens registry. A hardcoded subset
    // here (or there) is what let a flow be required under a lens planning
    // would never schedule.
    const required = selectFlowLenses(
      Array.isArray(flow.concerns) ? flow.concerns : [],
    );
    const completed = new Set<string>();

    for (const path of flowPaths) {
      const record = coverageByPath.get(path);
      if (!record || record.audit_status === "excluded") {
        continue;
      }
      for (const lens of record.completed_lenses) {
        if ((required as string[]).includes(lens)) {
          completed.add(lens);
        }
      }
    }

    const completed_lenses = [...completed];
    const status: FlowCoverageStatus =
      required.every((lens) => completed_lenses.includes(lens))
        ? "complete"
        : completed_lenses.length > 0
          ? "partial"
          : "pending";

    return {
      flow_id: flow.id,
      paths: flowPaths,
      required_lenses: required,
      completed_lenses,
      status,
      notes: [`Derived from ${flowPaths.length} path(s).`],
    };
  });

  return { flows };
}
