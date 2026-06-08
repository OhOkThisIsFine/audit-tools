import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditResult, AuditTask } from "../types.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { runCommand } from "./runtimeCommand.js";
import { buildFlowCoverage } from "./flowCoverage.js";
import { buildRequeuePayload } from "./requeueCommand.js";
import {
  buildRuntimeValidationTasks,
  mergeRuntimeValidationReport,
} from "./runtimeValidation.js";
import {
  ingestAuditResults,
  updateAuditTaskStatuses,
} from "./resultIngestion.js";
import {
  buildAuditPlanMetrics,
  buildReviewPackets,
  sizeIndexFromManifest,
} from "./reviewPackets.js";
import { updateRuntimeValidationReport } from "./runtimeValidationUpdate.js";
import { buildSelectiveDeepeningTasks } from "./selectiveDeepening.js";
import type { ExecutorRunResult } from "./executorResult.js";

function lineIndexFromTasks(tasks: AuditTask[] | undefined): Record<string, number> {
  return Object.fromEntries(
    (tasks ?? []).flatMap((task) => Object.entries(task.file_line_counts ?? {})),
  );
}

function appendSelectiveDeepeningTasks(params: {
  bundle: ArtifactBundle;
  results: AuditResult[];
  runtimeValidationReport?: RuntimeValidationReport;
}): { bundle: ArtifactBundle; taskCount: number; artifacts: string[] } {
  if (!params.bundle.audit_tasks) {
    return { bundle: params.bundle, taskCount: 0, artifacts: [] };
  }

  const lineIndex = lineIndexFromTasks(params.bundle.audit_tasks);
  const sizeIndex = sizeIndexFromManifest(params.bundle.repo_manifest);
  const selectiveDeepeningTasks = buildSelectiveDeepeningTasks({
    existingTasks: params.bundle.audit_tasks,
    results: params.results,
    lineIndex,
    runtimeValidationTasks: params.bundle.runtime_validation_tasks,
    runtimeValidationReport:
      params.runtimeValidationReport ?? params.bundle.runtime_validation_report,
    externalAnalyzerResults: params.bundle.external_analyzer_results,
  });

  if (selectiveDeepeningTasks.length === 0) {
    return { bundle: params.bundle, taskCount: 0, artifacts: [] };
  }

  const auditTasks = [...params.bundle.audit_tasks, ...selectiveDeepeningTasks];
  return {
    bundle: {
      ...params.bundle,
      audit_tasks: auditTasks,
      audit_plan_metrics: buildAuditPlanMetrics(auditTasks, {
        graphBundle: params.bundle.graph_bundle,
        lineIndex,
        sizeIndex,
      }),
      review_packets: buildReviewPackets(auditTasks, {
        graphBundle: params.bundle.graph_bundle,
        lineIndex,
        sizeIndex,
      }),
    },
    taskCount: selectiveDeepeningTasks.length,
    artifacts: ["audit_tasks.json", "audit_plan_metrics.json", "review_packets.json"],
  };
}

/**
 * Apply selective deepening to an already-prepared base bundle and return the
 * pieces every executor needs to assemble its `ExecutorRunResult`: the updated
 * bundle, the deepening artifacts, and the progress-summary suffix.
 *
 * Centralizing this keeps the three executors that run deepening consistent —
 * previously each site invoked `appendSelectiveDeepeningTasks` and then
 * re-derived the same `Added N selective deepening task(s)` suffix by hand.
 * `excludeArtifacts` lets a caller that already lists an artifact explicitly
 * (the result-ingestion executor lists `audit_tasks.json`) drop it from the
 * spread so it is never double-counted.
 */
function applySelectiveDeepening(params: {
  baseBundle: ArtifactBundle;
  results: AuditResult[];
  runtimeValidationReport?: RuntimeValidationReport;
  excludeArtifacts?: string[];
}): { bundle: ArtifactBundle; artifacts: string[]; summarySuffix: string } {
  const selectiveDeepening = appendSelectiveDeepeningTasks({
    bundle: params.baseBundle,
    results: params.results,
    runtimeValidationReport: params.runtimeValidationReport,
  });
  const exclude = new Set(params.excludeArtifacts ?? []);
  return {
    bundle: selectiveDeepening.bundle,
    artifacts: selectiveDeepening.artifacts.filter(
      (artifact) => !exclude.has(artifact),
    ),
    summarySuffix:
      selectiveDeepening.taskCount > 0
        ? ` Added ${selectiveDeepening.taskCount} selective deepening task(s).`
        : "",
  };
}

export function runResultIngestionExecutor(
  bundle: ArtifactBundle,
  results: AuditResult[],
): ExecutorRunResult {
  if (!bundle.coverage_matrix) {
    throw new Error("Cannot ingest results without coverage_matrix");
  }

  const updatedCoverageMatrix = ingestAuditResults(bundle.coverage_matrix, results);
  const flowCoverage = bundle.critical_flows
    ? buildFlowCoverage(bundle.critical_flows, updatedCoverageMatrix)
    : bundle.flow_coverage;
  const runtimeCommand = bundle.runtime_validation_tasks?.tasks.find(
    (task) => task.command && task.command.length > 0,
  )?.command;
  const runtimeValidationTasks =
    bundle.unit_manifest && flowCoverage
      ? buildRuntimeValidationTasks({
          unitManifest: bundle.unit_manifest,
          criticalFlows: bundle.critical_flows,
          flowCoverage,
          command: runtimeCommand,
        })
      : bundle.runtime_validation_tasks;
  const runtimeValidationReport = runtimeValidationTasks
    ? mergeRuntimeValidationReport(
        runtimeValidationTasks,
        bundle.runtime_validation_report,
      )
    : bundle.runtime_validation_report;
  const mergedResults = [...(bundle.audit_results ?? []), ...results];
  const completedAuditTasks = updateAuditTaskStatuses(
    bundle.audit_tasks,
    mergedResults,
  );
  const baseUpdatedBundle: ArtifactBundle = {
    ...bundle,
    coverage_matrix: updatedCoverageMatrix,
    flow_coverage: flowCoverage,
    runtime_validation_tasks: runtimeValidationTasks,
    runtime_validation_report: runtimeValidationReport,
    audit_results: mergedResults,
    audit_tasks: completedAuditTasks,
    audit_report: undefined,
  };
  const selectiveDeepening = applySelectiveDeepening({
    baseBundle: baseUpdatedBundle,
    results: mergedResults,
    runtimeValidationReport,
    excludeArtifacts: ["audit_tasks.json"],
  });
  const requeuePayload = buildRequeuePayload(
    updatedCoverageMatrix,
    selectiveDeepening.bundle.critical_flows,
    selectiveDeepening.bundle.flow_coverage,
    selectiveDeepening.bundle.external_analyzer_results,
  );
  // Fold pending requeue tasks into the dispatch task list so mandatory
  // coverage gaps produce actual dispatch packets. Enrich with line-count
  // hints and dedupe against existing tasks by task_id.
  const deepenedTasks = selectiveDeepening.bundle.audit_tasks ?? [];
  const lineIndex = lineIndexFromTasks(deepenedTasks);
  const sizeIndex = sizeIndexFromManifest(selectiveDeepening.bundle.repo_manifest);
  const existingTaskIds = new Set(deepenedTasks.map((t) => t.task_id));
  const pendingRequeueTasks = requeuePayload.tasks
    .filter((t) => t.status === "pending")
    .filter((t) => !existingTaskIds.has(t.task_id))
    .map((t) => ({
      ...t,
      file_line_counts: Object.fromEntries(
        t.file_paths
          .filter((p) => lineIndex[p] != null)
          .map((p) => [p, lineIndex[p]]),
      ),
    }));
  const allDispatchTasks = [...deepenedTasks, ...pendingRequeueTasks];
  const finalBundle: ArtifactBundle = {
    ...selectiveDeepening.bundle,
    requeue_tasks: requeuePayload.tasks,
    audit_plan_metrics: buildAuditPlanMetrics(allDispatchTasks, {
      graphBundle: selectiveDeepening.bundle.graph_bundle,
      lineIndex,
      sizeIndex,
    }),
    review_packets: buildReviewPackets(allDispatchTasks, {
      graphBundle: selectiveDeepening.bundle.graph_bundle,
      lineIndex,
      sizeIndex,
    }),
  };

  return {
    updated: finalBundle,
    artifacts_written: [
      "coverage_matrix.json",
      "flow_coverage.json",
      ...(runtimeValidationTasks ? ["runtime_validation_tasks.json"] : []),
      ...(runtimeValidationReport ? ["runtime_validation_report.json"] : []),
      "audit_results.jsonl",
      "audit_tasks.json",
      "audit_plan_metrics.json",
      "review_packets.json",
      "requeue_tasks.json",
    ],
    progress_summary:
      `Ingested ${results.length} audit result entries and refreshed dependent artifacts.` +
      selectiveDeepening.summarySuffix,
  };
}

export async function runRuntimeValidationExecutor(
  bundle: ArtifactBundle,
  root: string,
  options: { opentoken?: boolean } = {},
): Promise<ExecutorRunResult> {
  if (!bundle.runtime_validation_tasks) {
    throw new Error("Cannot execute runtime validation without runtime_validation_tasks");
  }

  const existing = bundle.runtime_validation_report ?? { results: [] };
  const byTaskId = new Map(existing.results.map((result) => [result.task_id, result]));
  const byCommand = new Map<string, Awaited<ReturnType<typeof runCommand>>>();
  let uniqueCommandsRun = 0;
  let deduplicatedHits = 0;

  for (const task of bundle.runtime_validation_tasks.tasks) {
    const prior = byTaskId.get(task.id);
    if (
      prior &&
      ["confirmed", "not_confirmed", "inconclusive", "not_required"].includes(
        prior.status,
      )
    ) {
      continue;
    }
    if (!task.command || task.command.length === 0) {
      byTaskId.set(task.id, {
        task_id: task.id,
        status: "not_required",
        summary: `No deterministic runtime command was available for ${task.id}.`,
        evidence: [],
        notes: ["Runtime validation was not planned for this task."],
      });
      continue;
    }

    const signature = task.command.join("\0");
    if (byCommand.has(signature)) {
      deduplicatedHits++;
    } else {
      uniqueCommandsRun++;
    }
    const outcome =
      byCommand.get(signature) ?? (await runCommand(task.command, root, { opentoken: options.opentoken }));
    byCommand.set(signature, outcome);
    byTaskId.set(task.id, {
      task_id: task.id,
      status: outcome.status,
      summary: outcome.summary,
      evidence: outcome.evidence,
      notes: [`Target paths: ${task.target_paths.join(", ")}`],
    });
  }

  const runtimeValidationReport: RuntimeValidationReport = {
    results: [...byTaskId.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)),
  };
  const baseUpdatedBundle: ArtifactBundle = {
    ...bundle,
    runtime_validation_report: runtimeValidationReport,
    audit_report: undefined,
  };
  const selectiveDeepening = applySelectiveDeepening({
    baseBundle: baseUpdatedBundle,
    results: bundle.audit_results ?? [],
    runtimeValidationReport,
  });

  return {
    updated: selectiveDeepening.bundle,
    artifacts_written: [
      "runtime_validation_report.json",
      ...selectiveDeepening.artifacts,
    ],
    progress_summary:
      `Executed deterministic runtime validation for ${bundle.runtime_validation_tasks.tasks.length} task(s) (${uniqueCommandsRun} unique command(s) run, ${deduplicatedHits} served from deduplication cache).` +
      selectiveDeepening.summarySuffix,
  };
}

export function runRuntimeValidationUpdateExecutor(
  bundle: ArtifactBundle,
  updates: RuntimeValidationReport,
): ExecutorRunResult {
  if (!bundle.runtime_validation_tasks) {
    throw new Error(
      "Cannot update runtime validation without runtime_validation_tasks",
    );
  }
  const existingReport =
    bundle.runtime_validation_report ?? { results: [] };
  const mergedReport = updateRuntimeValidationReport(
    bundle.runtime_validation_tasks,
    existingReport,
    updates,
  );
  const baseUpdatedBundle: ArtifactBundle = {
    ...bundle,
    runtime_validation_report: mergedReport,
    audit_report: undefined,
  };
  const selectiveDeepening = applySelectiveDeepening({
    baseBundle: baseUpdatedBundle,
    results: bundle.audit_results ?? [],
    runtimeValidationReport: mergedReport,
  });

  return {
    updated: selectiveDeepening.bundle,
    artifacts_written: [
      "runtime_validation_report.json",
      ...selectiveDeepening.artifacts,
    ],
    progress_summary:
      `Merged ${updates.results.length} runtime validation updates.` +
      selectiveDeepening.summarySuffix,
  };
}

export function runExternalAnalyzerImportExecutor(
  bundle: ArtifactBundle,
  externalResults: ExternalAnalyzerResults,
): ExecutorRunResult {
  const summary = `Imported ${externalResults.results.length} normalized findings from ${externalResults.tool}.`;
  return {
    updated: {
      ...bundle,
      external_analyzer_results: externalResults,
      coverage_matrix: undefined,
      flow_coverage: undefined,
      runtime_validation_tasks: undefined,
      runtime_validation_report: undefined,
      audit_tasks: undefined,
      audit_plan_metrics: undefined,
      review_packets: undefined,
      requeue_tasks: undefined,
      audit_report: undefined,
    },
    artifacts_written: ["external_analyzer_results.json"],
    progress_summary: summary,
  };
}
