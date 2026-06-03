import type { AuditResult, AuditTask, Finding } from "../../types.js";
import {
  DEEPENING_TAG,
  type FindingContext,
  SEVERITY_RANK,
  isDeepeningTask,
  lineCountForPath,
  pathsForFinding,
  sanitizeSegment,
  taskIdFor,
} from "./shared.js";

export function buildFindingFollowupTask(params: {
  result: AuditResult;
  task?: AuditTask;
  finding: Finding;
  triggers: string[];
  lineIndex?: Record<string, number>;
}): AuditTask {
  const paths = pathsForFinding(params.finding, params.result, params.task);
  const triggerLabel = params.triggers.join("+");
  const taskId = taskIdFor("finding", [
    params.result.task_id,
    params.finding.id,
    triggerLabel,
  ]);
  const priority =
    SEVERITY_RANK[params.finding.severity] >= SEVERITY_RANK.high
      ? "high"
      : "medium";

  return {
    task_id: taskId,
    unit_id: params.result.unit_id,
    pass_id: `deepening:${params.result.pass_id}`,
    lens: params.result.lens,
    file_paths: paths,
    file_line_counts: Object.fromEntries(
      paths.map((path) => [
        path,
        lineCountForPath(path, params.task, params.result, params.lineIndex),
      ]),
    ),
    rationale:
      `Follow up on ${params.finding.id} (${params.finding.severity}/${params.finding.confidence}) from ${params.result.task_id}. ` +
      "Verify impact, evidence quality, affected scope, and whether the finding should stand, narrow, or be downgraded.",
    priority,
    tags: [
      DEEPENING_TAG,
      ...params.triggers.map((trigger) => `trigger:${trigger}`),
      `source_task:${sanitizeSegment(params.result.task_id)}`,
      `finding:${sanitizeSegment(params.finding.id)}`,
    ],
    status: "pending",
  };
}

export function findingContexts(
  results: AuditResult[],
  taskById: Map<string, AuditTask>,
): FindingContext[] {
  const contexts: FindingContext[] = [];
  for (const result of results) {
    const task = taskById.get(result.task_id);
    if (isDeepeningTask(task)) {
      continue;
    }
    for (const finding of result.findings) {
      contexts.push({
        result,
        task,
        finding,
        paths: pathsForFinding(finding, result, task),
      });
    }
  }
  return contexts;
}
