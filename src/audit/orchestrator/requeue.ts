import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { AuditTask, CoverageMatrix } from "../types.js";
import { buildRequeueTargets } from "../coverage.js";
import { getExternalSignalPaths } from "./requeueUtils.js";

function taskPriority(
  hasExternalSignal: boolean,
  lens: string,
): "high" | "medium" | "low" {
  if (hasExternalSignal) return "high";
  if (lens === "security" || lens === "data_integrity" || lens === "reliability") {
    return "medium";
  }
  return "low";
}

export function buildRequeueTasks(
  matrix: CoverageMatrix,
  externalAnalyzerResults?: ExternalAnalyzerResults[],
): AuditTask[] {
  const targets = buildRequeueTargets(matrix);
  const tasks: AuditTask[] = [];
  const externalPaths = getExternalSignalPaths(externalAnalyzerResults);

  for (const target of targets) {
    for (const lens of target.missing_lenses) {
      const hasExternalSignal = externalPaths.has(target.path);
      tasks.push({
        task_id: `requeue:${lens}:${target.path}`,
        unit_id: `requeue:${target.path}`,
        pass_id: `requeue:${lens}`,
        lens,
        file_paths: [target.path],
        rationale: `Mandatory audit coverage is still missing for ${target.path} under the ${lens} lens.`,
        priority: taskPriority(hasExternalSignal, lens),
        tags: hasExternalSignal ? ["external_analyzer_signal"] : [],
        status: "pending",
      });
    }
  }

  return tasks;
}
