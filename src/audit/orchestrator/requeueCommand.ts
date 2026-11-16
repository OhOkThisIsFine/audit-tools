// sites-pinned: tests/audit/dedupe-tasks.test.ts, tests/audit/field-trial-remediation.test.ts
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import { buildRequeueTasks } from "./requeue.js";
import { buildFlowRequeueTasks } from "./flowRequeue.js";
import type { CoverageMatrix } from "../types.js";
import type { FlowCoverageManifest } from "../types/flowCoverage.js";
import type { CriticalFlowManifest } from "audit-tools/shared";

/** Keep the first item for each key, in input order. */
function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function dedupeTasks<T extends { task_id: string }>(tasks: T[]): T[] {
  return dedupeBy(tasks, (task) => task.task_id);
}

function dedupeByScope<T extends { lens: string; file_paths: string[] }>(
  tasks: T[],
): T[] {
  return dedupeBy(tasks, (task) => `${task.lens}:${[...task.file_paths].sort().join(",")}`);
}

export function buildRequeuePayload(
  matrix: CoverageMatrix,
  criticalFlows?: CriticalFlowManifest,
  flowCoverage?: FlowCoverageManifest,
  externalAnalyzerResults?: ExternalAnalyzerResults[],
) {
  // Dedupe within each source first — each generator may emit duplicate task_ids independently.
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
  // Two-pass post-merge dedup:
  //   1. dedupeTasks removes any cross-source task_id collisions (same task emitted by both generators).
  //   2. dedupeByScope removes tasks that cover the same lens+file_paths scope but carry different task_ids.
  const tasks = dedupeByScope(dedupeTasks([...fileTasks, ...flowTasks]));

  return {
    task_count: tasks.length,
    file_task_count: fileTasks.length,
    flow_task_count: flowTasks.length,
    tasks,
  };
}
