// sites-pinned: tests/audit/orchestrator-remediation.test.ts
import { lineCountsFor } from "../lineCounts.js";
import type { AuditResult, AuditTask } from "../../types.js";
import {
  DEEPENING_TAG,
  assignedOrCoveredPaths,
  isDeepeningTask,
  sanitizeSegment,
  taskIdFor,
} from "./shared.js";

/** Tags that mark a task's clean verdict as worth a second look on their own. */
const HIGH_RISK_TAGS: ReadonlySet<string> = new Set([
  "critical_flow",
  "external_analyzer_signal",
]);

export function isHighRiskCleanResult(
  result: AuditResult,
  task: AuditTask | undefined,
): boolean {
  if (
    result.findings.length > 0 ||
    result.requires_followup === false ||
    isDeepeningTask(task)
  ) {
    return false;
  }
  if (!task) {
    return (
      result.requires_followup === true &&
      (result.lens === "security" || result.lens === "data_integrity")
    );
  }

  if (task.priority === "high") {
    return true;
  }

  if (task.tags?.some((tag) => HIGH_RISK_TAGS.has(tag))) {
    return true;
  }

  return result.requires_followup === true && task.priority === "medium";
}

export function buildHighRiskCleanFollowupTask(params: {
  result: AuditResult;
  task?: AuditTask;
  lineIndex?: Record<string, number>;
}): AuditTask {
  const paths = assignedOrCoveredPaths(params.result, params.task);

  return {
    task_id: taskIdFor("clean", [params.result.task_id, params.result.lens]),
    unit_id: params.result.unit_id,
    pass_id: `deepening:${params.result.pass_id}`,
    lens: params.result.lens,
    file_paths: paths,
    file_line_counts: lineCountsFor(paths, {
      task: params.task,
      result: params.result,
      lineIndex: params.lineIndex,
    }),
    rationale:
      `Sample high-risk no-finding result from ${params.result.task_id}. ` +
      "Re-review the assigned files for missed edge cases, hidden runtime failures, and whether the clean conclusion should stand.",
    priority: params.task?.priority === "high" ? "high" : "medium",
    tags: [
      DEEPENING_TAG,
      "trigger:high_risk_no_finding",
      `source_task:${sanitizeSegment(params.result.task_id)}`,
    ],
    status: "pending",
  };
}
