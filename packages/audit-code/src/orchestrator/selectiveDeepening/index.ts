import type { AuditTask } from "../../types.js";
import {
  type BuildSelectiveDeepeningTaskOptions,
  DEFAULT_MAX_DEEPENING_TASKS,
  DEFAULT_MAX_TOTAL_DEEPENING_TASKS,
  DEEPENING_TAG,
  LENS_VERIFICATION_FOLLOWUP_TAG,
  LENS_VERIFICATION_TAG,
  SEVERITY_RANK,
  intersects,
  isDeepeningTask,
  priorityRank,
} from "./shared.js";
import { buildFindingFollowupTask, findingContexts } from "./findingFollowup.js";
import { buildConflictFollowupTask, conflictGroups } from "./conflict.js";
import {
  buildHighRiskCleanFollowupTask,
  isHighRiskCleanResult,
} from "./highRiskClean.js";
import {
  buildRuntimeValidationFollowupTask,
  runtimeResultNeedsFollowup,
  runtimeValidationHasStrongStaticFinding,
} from "./runtimeValidation.js";
import { buildLensVerificationTasks } from "./lensVerification.js";
import { buildVerificationFollowupTasks } from "./stewardFollowup.js";

export type { BuildSelectiveDeepeningTaskOptions } from "./shared.js";

/**
 * Build the bounded set of selective-deepening follow-up tasks. Each strategy
 * (finding-followup, conflict, steward-followup, runtime-validation, lens-
 * verification, high-risk-clean) lives in its own module under this directory;
 * this entry sequences them and enforces the shared budget (`effectiveMax`,
 * `maxTotalDeepeningTasks`) and dedupe (via `pushIfNew`). Task ordering, caps,
 * and dedupe are unchanged from the former single-file implementation.
 */
export function buildSelectiveDeepeningTasks(
  options: BuildSelectiveDeepeningTaskOptions,
): AuditTask[] {
  const taskById = new Map(
    (options.existingTasks ?? []).map((task) => [task.task_id, task]),
  );
  const existingTasks = options.existingTasks ?? [];
  const existingIds = new Set(taskById.keys());
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_DEEPENING_TASKS;
  const maxTotalDeepeningTasks =
    options.maxTotalDeepeningTasks ?? DEFAULT_MAX_TOTAL_DEEPENING_TASKS;

  const existingDeepeningCount = existingTasks.filter((task) =>
    isDeepeningTask(task),
  ).length;
  if (existingDeepeningCount >= maxTotalDeepeningTasks) {
    return [];
  }
  const remainingBudget = maxTotalDeepeningTasks - existingDeepeningCount;
  const effectiveMax = Math.min(maxTasks, remainingBudget);
  const created: AuditTask[] = [];

  function pushIfNew(task: AuditTask): void {
    if (created.length >= effectiveMax || existingIds.has(task.task_id)) {
      return;
    }
    existingIds.add(task.task_id);
    created.push(task);
  }

  const contexts = findingContexts(options.results, taskById);
  for (const context of contexts) {
    const triggers: string[] = [];
    if (SEVERITY_RANK[context.finding.severity] >= SEVERITY_RANK.high) {
      triggers.push("high_severity");
    }
    if (context.finding.confidence === "low") {
      triggers.push("low_confidence");
    }
    if (triggers.length === 0) {
      continue;
    }
    pushIfNew(
      buildFindingFollowupTask({
        result: context.result,
        task: context.task,
        finding: context.finding,
        triggers,
        lineIndex: options.lineIndex,
      }),
    );
  }

  for (const [key, group] of [...conflictGroups(contexts).entries()].sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    pushIfNew(
      buildConflictFollowupTask({
        contexts: group,
        conflictKey: key,
        lineIndex: options.lineIndex,
      }),
    );
  }

  for (const result of options.results) {
    const task = taskById.get(result.task_id);
    for (const followupTask of buildVerificationFollowupTasks({
      result,
      task,
      lineIndex: options.lineIndex,
    })) {
      pushIfNew(followupTask);
    }
  }

  const runtimeTaskById = new Map(
    (options.runtimeValidationTasks?.tasks ?? []).map((task) => [
      task.id,
      task,
    ]),
  );
  for (const result of [...(options.runtimeValidationReport?.results ?? [])].sort(
    (a, b) => a.task_id.localeCompare(b.task_id),
  )) {
    if (!runtimeResultNeedsFollowup(result.status)) {
      continue;
    }
    const runtimeTask = runtimeTaskById.get(result.task_id);
    if (!runtimeTask || runtimeTask.target_paths.length === 0) {
      continue;
    }
    if (runtimeValidationHasStrongStaticFinding(runtimeTask, contexts)) {
      continue;
    }
    const relatedTasks = existingTasks.filter(
      (task) =>
        !isDeepeningTask(task) && intersects(task.file_paths, runtimeTask.target_paths),
    );
    pushIfNew(
      buildRuntimeValidationFollowupTask({
        runtimeTask,
        runtimeResultStatus: result.status,
        relatedTasks,
        results: options.results,
        lineIndex: options.lineIndex,
      }),
    );
  }

  for (const task of buildLensVerificationTasks({
    existingTasks,
    results: options.results,
    lineIndex: options.lineIndex,
    externalAnalyzerResults: options.externalAnalyzerResults,
  })) {
    pushIfNew(task);
  }

  const cleanResults = options.results
    .map((result) => ({ result, task: taskById.get(result.task_id) }))
    .filter(({ result, task }) => isHighRiskCleanResult(result, task))
    .sort((a, b) => {
      const priorityDelta =
        priorityRank(b.task?.priority) - priorityRank(a.task?.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return a.result.task_id.localeCompare(b.result.task_id);
    });

  for (const { result, task } of cleanResults) {
    pushIfNew(
      buildHighRiskCleanFollowupTask({
        result,
        task,
        lineIndex: options.lineIndex,
      }),
    );
  }

  return created;
}

export const selectiveDeepeningTestUtils = {
  DEEPENING_TAG,
  LENS_VERIFICATION_TAG,
  LENS_VERIFICATION_FOLLOWUP_TAG,
  DEFAULT_MAX_TOTAL_DEEPENING_TASKS,
};
