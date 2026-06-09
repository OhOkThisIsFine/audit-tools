import { applyFileCoverage } from "../coverage.js";
import type {
  AuditResult,
  AuditTask,
  CoverageMatrix,
  FileCoverageRecord,
} from "../types.js";

export function ingestAuditResults(
  coverageMatrix: CoverageMatrix,
  results: AuditResult[],
): CoverageMatrix {
  const matrix: CoverageMatrix = JSON.parse(JSON.stringify(coverageMatrix));
  const fileCoverage: FileCoverageRecord[] = results.flatMap((result) =>
    result.file_coverage.map((coverage) => ({
      path: coverage.path,
      total_lines: coverage.total_lines,
      pass_id: result.pass_id,
      lens: result.lens,
      agent_role: result.agent_role,
    })),
  );

  applyFileCoverage(matrix, fileCoverage);
  return matrix;
}

export function updateAuditTaskStatuses(
  tasks: AuditTask[] | undefined,
  results: AuditResult[],
): AuditTask[] | undefined {
  if (!tasks) {
    return undefined;
  }

  const completedTaskIds = new Set(results.map((result) => result.task_id));
  const completedAt = new Date().toISOString();

  return tasks.map((task) => {
    if (completedTaskIds.has(task.task_id)) {
      return {
        ...task,
        status: "complete",
        completed_at: task.completed_at ?? completedAt,
        completion_reason: task.completion_reason ?? "result_ingested",
      };
    }

    return {
      ...task,
      status: task.status ?? "pending",
    };
  });
}

/**
 * Splits raw (unvalidated) audit results into those whose `task_id` is still in
 * the active task manifest and those orphaned by a later re-plan (e.g. selective-
 * deepening tasks pruned in a subsequent round). Orphaned results cannot be
 * ingested — coverage is keyed by the active task set — and must not abort an
 * otherwise-valid batch at the ingestion validation gate. Returns the retained
 * results plus the orphaned task ids so the caller can skip-and-warn, or `null`
 * when there is nothing to filter (not an array, or no active manifest yet),
 * signaling the caller to pass the results through unchanged.
 */
export function partitionOrphanedAuditResults(
  results: unknown,
  activeTaskIds: Set<string>,
): { retained: unknown[]; orphanedTaskIds: string[] } | null {
  if (!Array.isArray(results) || activeTaskIds.size === 0) {
    return null;
  }
  const orphanedTaskIds: string[] = [];
  const retained = results.filter((entry) => {
    const taskId =
      entry && typeof entry === "object" && !Array.isArray(entry) &&
      typeof (entry as { task_id?: unknown }).task_id === "string"
        ? (entry as { task_id: string }).task_id
        : undefined;
    if (taskId !== undefined && !activeTaskIds.has(taskId)) {
      orphanedTaskIds.push(taskId);
      return false;
    }
    return true;
  });
  return { retained, orphanedTaskIds };
}
