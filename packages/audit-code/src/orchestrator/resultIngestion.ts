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
