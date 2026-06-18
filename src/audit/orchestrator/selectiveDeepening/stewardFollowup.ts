import type { AuditResult, AuditTask } from "../../types.js";
import {
  DEEPENING_TAG,
  LENS_VERIFICATION_FOLLOWUP_TAG,
  MAX_VERIFICATION_FOLLOWUP_TASKS_PER_RESULT,
  isLensVerificationTask,
  isRecord,
  normalizedSuggestedPriority,
  sanitizeSegment,
  taskIdFor,
  uniqueSorted,
} from "./shared.js";

export function buildVerificationFollowupTasks(params: {
  result: AuditResult;
  task?: AuditTask;
  lineIndex?: Record<string, number>;
}): AuditTask[] {
  if (
    !params.result.verification?.needs_followup ||
    !Array.isArray(params.result.verification.followup_tasks) ||
    !isLensVerificationTask(params.task)
  ) {
    return [];
  }

  const coverageByPath = new Map(
    params.result.file_coverage.map((coverage) => [
      coverage.path,
      coverage.total_lines,
    ]),
  );
  const concerns = [
    ...(params.result.verification.concerns ?? []),
    ...(params.result.verification.coverage_concerns ?? []),
    ...(params.result.verification.confidence_concerns ?? []),
  ];
  const tasks: AuditTask[] = [];

  for (let index = 0; index < params.result.verification.followup_tasks.length; index++) {
    if (tasks.length >= MAX_VERIFICATION_FOLLOWUP_TASKS_PER_RESULT) {
      break;
    }
    const suggestion = params.result.verification.followup_tasks[index] as unknown;
    if (!isRecord(suggestion)) {
      continue;
    }
    if (suggestion.lens !== params.result.lens) {
      continue;
    }
    const suggestedPaths = Array.isArray(suggestion.file_paths)
      ? suggestion.file_paths.filter(
          (path): path is string =>
            typeof path === "string" && coverageByPath.has(path),
        )
      : [];
    const paths = uniqueSorted(suggestedPaths);
    if (paths.length === 0) {
      continue;
    }
    const suggestedRationale =
      typeof suggestion.rationale === "string" && suggestion.rationale.trim().length > 0
        ? suggestion.rationale.trim()
        : concerns[0] ?? "Lens steward requested bounded follow-up.";
    const suggestedId =
      typeof suggestion.task_id === "string" && suggestion.task_id.trim().length > 0
        ? suggestion.task_id
        : `suggestion-${index + 1}`;

    tasks.push({
      task_id: taskIdFor("steward-followup", [
        params.result.task_id,
        String(index),
        suggestedId,
        ...paths,
        suggestedRationale,
      ]),
      unit_id:
        typeof suggestion.unit_id === "string" && suggestion.unit_id.trim().length > 0
          ? suggestion.unit_id
          : params.result.unit_id,
      pass_id: `deepening:${params.result.pass_id}`,
      lens: params.result.lens,
      file_paths: paths,
      file_line_counts: Object.fromEntries(
        paths.map((path) => [
          path,
          coverageByPath.get(path) ?? params.lineIndex?.[path] ?? 0,
        ]),
      ),
      rationale:
        `Lens steward follow-up from ${params.result.task_id}. ${suggestedRationale}`,
      priority: normalizedSuggestedPriority(suggestion.priority, "medium"),
      tags: [
        DEEPENING_TAG,
        LENS_VERIFICATION_FOLLOWUP_TAG,
        "trigger:lens_verification",
        `source_task:${sanitizeSegment(params.result.task_id)}`,
      ],
      status: "pending",
    });
  }

  return tasks;
}
