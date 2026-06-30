import type { AuditTask } from "../../types.js";
import {
  type BuildSelectiveDeepeningTaskOptions,
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
 * Build the self-bounding set of selective-deepening follow-up tasks. Each
 * strategy (finding-followup, conflict, steward-followup, runtime-validation,
 * lens-verification, high-risk-clean) lives in its own module under this
 * directory; this entry sequences them and dedupes (via `pushIfNew`).
 *
 * There is no per-batch or total-count limit. Each strategy keys its task id off
 * the finding/unit/lens it verifies, `pushIfNew` dedupes against tasks created in
 * prior rounds, and no strategy deepens a deepening-sourced result (finding /
 * conflict / lens-verification / high-risk-clean all filter `isDeepeningTask`;
 * steward only fires on lens-verification results and its output is not itself a
 * lens-verification task). The strategy chain is therefore a finite DAG that
 * converges on its own — each qualifying item is deepened at most once — so the
 * bound is the size of the qualifying set, never an arbitrary number.
 */
export function buildSelectiveDeepeningTasks(
  options: BuildSelectiveDeepeningTaskOptions,
): AuditTask[] {
  const taskById = new Map(
    (options.existingTasks ?? []).map((task) => [task.task_id, task]),
  );
  const existingTasks = options.existingTasks ?? [];
  const existingIds = new Set(taskById.keys());
  const created: AuditTask[] = [];

  // No cap: each qualifying item is deepened at most once. `pushIfNew` dedupes
  // against tasks already created (this round or a prior one, via existingIds),
  // and strategies never deepen a deepening-sourced result, so the qualifying
  // set is finite and the chain converges on its own.
  function pushIfNew(task: AuditTask): void {
    if (existingIds.has(task.task_id)) {
      return;
    }
    existingIds.add(task.task_id);
    created.push(task);
  }

  // FND-OBS-c8d43100: track per-strategy contribution counts so the summary log
  // can report which strategies fired and whether budget-capping occurred.
  const strategyContributions: Record<string, number> = {};

  const contexts = findingContexts(options.results, taskById);
  let beforeFindingFollowup = created.length;
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
  strategyContributions["finding_followup"] = created.length - beforeFindingFollowup;

  let beforeConflict = created.length;
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
  strategyContributions["conflict"] = created.length - beforeConflict;

  let beforeSteward = created.length;
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
  strategyContributions["steward_followup"] = created.length - beforeSteward;

  const runtimeTaskById = new Map(
    (options.runtimeValidationTasks?.tasks ?? []).map((task) => [
      task.id,
      task,
    ]),
  );
  let beforeRuntimeValidation = created.length;
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
  strategyContributions["runtime_validation"] = created.length - beforeRuntimeValidation;

  let beforeLensVerification = created.length;
  for (const task of buildLensVerificationTasks({
    existingTasks,
    results: options.results,
    lineIndex: options.lineIndex,
    externalAnalyzerResults: options.externalAnalyzerResults,
  })) {
    pushIfNew(task);
  }
  strategyContributions["lens_verification"] = created.length - beforeLensVerification;

  const cleanResults = options.results
    .map((result) => ({ result, task: taskById.get(result.task_id) }))
    .filter(({ result, task }) => isHighRiskCleanResult(result, task))
    .sort((a, b) => {
      const priorityDelta =
        priorityRank(b.task?.priority) - priorityRank(a.task?.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return a.result.task_id.localeCompare(b.result.task_id);
    });

  let beforeHighRiskClean = created.length;
  for (const { result, task } of cleanResults) {
    pushIfNew(
      buildHighRiskCleanFollowupTask({
        result,
        task,
        lineIndex: options.lineIndex,
      }),
    );
  }
  strategyContributions["high_risk_clean"] = created.length - beforeHighRiskClean;

  // FND-OBS-c8d43100: emit a structured summary of which strategies fired so
  // operators can understand deepening decisions. Deepening is self-bounding
  // (each qualifying item deepened at most once), so there is no budget to report.
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      source: "audit-code:selectiveDeepening",
      event: "strategy_summary",
      level: "info",
      created: created.length,
      strategy_contributions: strategyContributions,
    }) + "\n",
  );

  return created;
}
