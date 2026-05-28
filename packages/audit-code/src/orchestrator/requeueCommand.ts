import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { buildRequeueTasks } from "./requeue.js";
import { buildFlowRequeueTasks } from "./flowRequeue.js";
import type { CoverageMatrix } from "../types.js";
import type { FlowCoverageManifest } from "../types/flowCoverage.js";
import type { CriticalFlowManifest } from "@audit-tools/shared";

function dedupeTasks<T extends { task_id: string }>(tasks: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const task of tasks) {
    if (seen.has(task.task_id)) {
      continue;
    }
    seen.add(task.task_id);
    deduped.push(task);
  }
  return deduped;
}

function dedupeByScope<T extends { lens: string; file_paths: string[] }>(
  tasks: T[],
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];

  for (const task of tasks) {
    const signature = `${task.lens}:${[...task.file_paths].sort().join(",")}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push(task);
  }

  return deduped;
}

export function buildRequeuePayload(
  matrix: CoverageMatrix,
  criticalFlows?: CriticalFlowManifest,
  flowCoverage?: FlowCoverageManifest,
  externalAnalyzerResults?: ExternalAnalyzerResults,
) {
  const fileTasks = dedupeTasks(
    buildRequeueTasks(matrix, externalAnalyzerResults),
  );
  const flowTasks =
    criticalFlows && flowCoverage
      ? dedupeTasks(
          buildFlowRequeueTasks(
            criticalFlows,
            flowCoverage,
            matrix,
            externalAnalyzerResults,
          ),
        )
      : [];
  const tasks = dedupeByScope(dedupeTasks([...fileTasks, ...flowTasks]));

  return {
    task_count: tasks.length,
    file_task_count: fileTasks.length,
    flow_task_count: flowTasks.length,
    tasks,
  };
}
