import type { CoverageMatrix, Lens } from "../types.js";
import type {
  FlowCoverageManifest,
  FlowCoverageStatus,
} from "../types/flowCoverage.js";
import type { CriticalFlowManifest } from "@audit-tools/shared";

function lensSetForFlow(concerns: string[]): Lens[] {
  const allowed: Lens[] = [
    "security",
    "reliability",
    "correctness",
    "data_integrity",
    "operability",
    "performance",
    "observability",
  ];
  return concerns.filter((concern): concern is Lens =>
    allowed.includes(concern as Lens),
  );
}

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
    const required = lensSetForFlow(
      Array.isArray(flow.concerns)
        ? flow.concerns.filter(
            (concern): concern is string => typeof concern === "string",
          )
        : [],
    );
    const completed = new Set<string>();

    for (const path of flowPaths) {
      const record = coverageByPath.get(path);
      if (!record || record.audit_status === "excluded") {
        continue;
      }
      for (const lens of record.completed_lenses) {
        if (required.includes(lens)) {
          completed.add(lens);
        }
      }
    }

    const completed_lenses = [...completed];
    const status: FlowCoverageStatus =
      required.length > 0 &&
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
