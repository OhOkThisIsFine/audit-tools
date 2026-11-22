// sites-pinned: tests/audit/selective-deepening-conflicts.test.ts
import { compareCodeUnits } from "audit-tools/shared";
import type { AuditTask } from "../../types.js";
import {
  type BuildSelectiveDeepeningTaskOptions,
  SEVERITY_RANK,
  intersects,
  isDeepeningTask,
} from "./shared.js";
import { priorityRank } from "../auditTaskUtils.js";
import { buildFindingFollowupTask, findingContexts } from "./findingFollowup.js";
import { buildConflictFollowupTask, coalescedConflictGroups } from "./conflict.js";
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
 * directory; this entry sequences them and dedupes (via `contribute`).
 *
 * There is no per-batch or total-count limit. Each strategy keys its task id off
 * the finding/unit/lens it verifies, `contribute` dedupes against tasks created
 * in prior rounds, and no strategy deepens a deepening-sourced result (finding /
 * conflict / lens-verification / high-risk-clean all filter `isDeepeningTask`;
 * steward only fires on lens-verification results and its output is not itself a
 * lens-verification task). The strategy chain is therefore a finite DAG that
 * converges on its own — each qualifying item is deepened at most once — so the
 * bound is the size of the qualifying set, never an arbitrary number.
 */
export function buildSelectiveDeepeningTasks(
  options: BuildSelectiveDeepeningTaskOptions,
): AuditTask[] {
  const existingTasks = options.existingTasks ?? [];
  const taskById = new Map(existingTasks.map((task) => [task.task_id, task]));
  const existingIds = new Set(taskById.keys());
  const created: AuditTask[] = [];
  // Per-strategy contribution counts, in strategy order, for the verbose summary.
  const strategyContributions: Record<string, number> = {};

  // Push each new task (dedupe against this round and prior rounds via
  // existingIds) and record how many the strategy added.
  function contribute(strategy: string, tasks: Iterable<AuditTask>): void {
    const before = created.length;
    for (const task of tasks) {
      if (existingIds.has(task.task_id)) continue;
      existingIds.add(task.task_id);
      created.push(task);
    }
    strategyContributions[strategy] = created.length - before;
  }

  const contexts = findingContexts(options.results, taskById);
  contribute(
    "finding_followup",
    contexts.flatMap((context) => {
      const triggers: string[] = [];
      if (SEVERITY_RANK[context.finding.severity] >= SEVERITY_RANK.high) {
        triggers.push("high_severity");
      }
      if (context.finding.confidence === "low") {
        triggers.push("low_confidence");
      }
      return triggers.length === 0
        ? []
        : [buildFindingFollowupTask({ ...context, triggers, lineIndex: options.lineIndex })];
    }),
  );

  contribute(
    "conflict",
    coalescedConflictGroups(contexts, options.lineIndex).map((group) =>
      buildConflictFollowupTask({
        contexts: group.contexts,
        conflictKeys: group.conflictKeys,
        lineIndex: options.lineIndex,
      }),
    ),
  );

  contribute(
    "steward_followup",
    options.results.flatMap((result) =>
      buildVerificationFollowupTasks({
        result,
        task: taskById.get(result.task_id),
        lineIndex: options.lineIndex,
      }),
    ),
  );

  const runtimeTaskById = new Map(
    (options.runtimeValidationTasks?.tasks ?? []).map((task) => [
      task.id,
      task,
    ]),
  );
  const runtimeFollowups: AuditTask[] = [];
  for (const result of [...(options.runtimeValidationReport?.results ?? [])].sort(
    (a, b) => compareCodeUnits(a.task_id, b.task_id),
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
    const targets = new Set(runtimeTask.target_paths);
    const relatedTasks = existingTasks.filter(
      (task) => !isDeepeningTask(task) && intersects(task.file_paths, targets),
    );
    runtimeFollowups.push(
      buildRuntimeValidationFollowupTask({
        runtimeTask,
        runtimeResultStatus: result.status,
        relatedTasks,
        results: options.results,
        lineIndex: options.lineIndex,
      }),
    );
  }
  contribute("runtime_validation", runtimeFollowups);

  contribute(
    "lens_verification",
    buildLensVerificationTasks({
      existingTasks,
      results: options.results,
      lineIndex: options.lineIndex,
      externalAnalyzerResults: options.externalAnalyzerResults,
    }),
  );

  const cleanResults = options.results
    .map((result) => ({ result, task: taskById.get(result.task_id) }))
    .filter(({ result, task }) => isHighRiskCleanResult(result, task))
    .sort((a, b) => {
      const priorityDelta =
        priorityRank(b.task?.priority) - priorityRank(a.task?.priority);
      if (priorityDelta !== 0) return priorityDelta;
      return compareCodeUnits(a.result.task_id, b.result.task_id);
    });
  contribute(
    "high_risk_clean",
    cleanResults.map(({ result, task }) =>
      buildHighRiskCleanFollowupTask({
        result,
        task,
        lineIndex: options.lineIndex,
      }),
    ),
  );

  // Info-level diagnostics: which strategies fired. Deepening is self-bounding,
  // so there is no budget to report. Gated on AUDIT_CODE_VERBOSE so a normal
  // run's stderr stays clean.
  if (process.env.AUDIT_CODE_VERBOSE) {
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
  }

  return created;
}
