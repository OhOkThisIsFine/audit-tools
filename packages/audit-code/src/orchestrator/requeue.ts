import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { AuditTask, CoverageMatrix } from "../types.js";
import { buildRequeueTargets } from "../coverage.js";

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

function getExternalSignalPaths(
  externalAnalyzerResults?: ExternalAnalyzerResults,
): Set<string> {
  const results = Array.isArray(externalAnalyzerResults?.results)
    ? externalAnalyzerResults.results
    : [];
  return new Set(
    results
      .map((item) =>
        item && typeof item.path === "string" && item.path.length > 0
          ? item.path
          : null,
      )
      .filter((path): path is string => path !== null),
  );
}

export function buildRequeueTasks(
  matrix: CoverageMatrix,
  externalAnalyzerResults?: ExternalAnalyzerResults,
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
