import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditScopeManifest } from "../types/auditScope.js";
import { initializeCoverageFromPlan } from "./planning.js";
import {
  applyIntentExclusionsToCoverage,
  applyScopeToCoverage,
  fullAuditScope,
} from "./scope.js";
import { buildFlowCoverage } from "./flowCoverage.js";
import { buildRequeuePayload } from "./requeueCommand.js";
import {
  buildRuntimeValidationTasks,
  discoverRuntimeValidationCommand,
  mergeRuntimeValidationReport,
} from "./runtimeValidation.js";
import {
  buildChunkedAuditTasks,
} from "./taskBuilder.js";
import {
  buildAuditPlanMetrics,
  buildReviewPackets,
  sizeIndexFromManifest,
} from "./reviewPackets.js";
import { resolveEffectiveLenses } from "./lensSelection.js";
import { autoCompleteTrivialCoverage } from "./trivialAudit.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { Lens } from "../types.js";

// ---------------------------------------------------------------------------
// Free-form intent interpreter (keyword → lens boost, deterministic, no LLM)
// ---------------------------------------------------------------------------

const KEYWORD_LENS_MAP: Array<{ keywords: string[]; lens: Lens }> = [
  { keywords: ["security", "auth", "authentication", "authorization", "secrets", "credentials"], lens: "security" },
  { keywords: ["data", "integrity", "validation", "validate", "schema"], lens: "data_integrity" },
  { keywords: ["perf", "performance", "speed", "latency", "throughput"], lens: "performance" },
  { keywords: ["test", "tests", "testing", "coverage"], lens: "tests" },
  { keywords: ["reliability", "resilience", "fault", "retry", "failover"], lens: "reliability" },
  { keywords: ["observability", "logging", "metrics", "tracing", "monitoring"], lens: "observability" },
  { keywords: ["config", "configuration", "deployment", "deploy", "environment"], lens: "config_deployment" },
  { keywords: ["architecture", "design", "structure", "coupling", "dependency", "dependencies"], lens: "architecture" },
  { keywords: ["maintainability", "maintainable", "readability", "readable", "lint", "style"], lens: "maintainability" },
  { keywords: ["correctness", "bug", "bugs", "logic", "errors"], lens: "correctness" },
];

/**
 * Interpret a free-form intent string into lenses to priority-boost.
 * Deterministic keyword scan — no LLM call.
 * INV-S04: the verbatim intent string never appears in output fields.
 */
export function interpretFreeFormIntent(text: string): Lens[] {
  if (!text || text.trim().length === 0) return [];
  const lower = text.toLowerCase();
  const boosts = new Set<Lens>();
  for (const { keywords, lens } of KEYWORD_LENS_MAP) {
    if (keywords.some((kw) => lower.includes(kw))) {
      boosts.add(lens);
    }
  }
  return [...boosts];
}

export async function runPlanningExecutor(
  bundle: ArtifactBundle,
  root: string,
  lineIndex: Record<string, number> = {},
  sizeIndex?: Record<string, number>,
  scope?: AuditScopeManifest,
): Promise<ExecutorRunResult> {
  if (!bundle.repo_manifest) {
    throw new Error("Cannot run planning executor without repo_manifest");
  }
  const resolvedSizeIndex = sizeIndex ?? sizeIndexFromManifest(bundle.repo_manifest);
  if (
    !bundle.file_disposition ||
    !bundle.unit_manifest ||
    !bundle.surface_manifest ||
    !bundle.critical_flows ||
    !bundle.risk_register
  ) {
    throw new Error(
      "Cannot run planning executor without current structure artifacts",
    );
  }

  const resolvedScope = scope ?? fullAuditScope();
  const externalAnalyzerResults = bundle.external_analyzer_results;

  // Apply disposition_overrides before coverage initialization so overridden
  // files never enter coverage at all (not just filtered after).
  // Supports exact path match and prefix match (entry.path or entry.path + '/').
  const dispositionOverrides = bundle.intent_checkpoint?.disposition_overrides;
  let effectiveFileDisposition = bundle.file_disposition;
  if (dispositionOverrides && dispositionOverrides.length > 0) {
    effectiveFileDisposition = {
      ...bundle.file_disposition,
      files: bundle.file_disposition.files.map((f) => {
        for (const override of dispositionOverrides) {
          if (
            f.path === override.path ||
            f.path.startsWith(override.path + "/")
          ) {
            return { ...f, status: override.status, reason: override.reason };
          }
        }
        return f;
      }),
    };
  }

  // Resolve effective lenses from lens_selection (mandatory lenses always
  // included; resolveEffectiveLenses enforces this invariant).
  const lensSelectionInclude = bundle.intent_checkpoint?.lens_selection?.include;
  const lensSelectionExclude = bundle.intent_checkpoint?.lens_selection?.exclude;
  let effectiveLenses: Lens[] | undefined;
  if (lensSelectionInclude !== undefined || lensSelectionExclude !== undefined) {
    // Build a selected set: start from include (or all), subtract exclude
    const baseSelected = lensSelectionInclude ?? undefined;
    const resolved = resolveEffectiveLenses(baseSelected ?? null);
    if (lensSelectionExclude && lensSelectionExclude.length > 0) {
      const excludeSet = new Set(lensSelectionExclude);
      // resolveEffectiveLenses already enforces mandatory lenses; we just
      // need to apply the exclude filter after re-resolving
      const afterExclude = resolved.filter((l) => !excludeSet.has(l));
      // resolveEffectiveLenses ensures mandatory lenses are always present —
      // call again with afterExclude so mandatory lenses are re-unioned in
      effectiveLenses = resolveEffectiveLenses(afterExclude);
    } else {
      effectiveLenses = resolved;
    }
  }

  const coverage = initializeCoverageFromPlan(
    bundle.repo_manifest,
    bundle.unit_manifest,
    effectiveFileDisposition,
    externalAnalyzerResults,
  );
  const skippedTrivialPaths = autoCompleteTrivialCoverage(
    coverage,
    lineIndex,
    externalAnalyzerResults,
  );
  // Delta scope: only seed + expanded files stay pending; the rest inherit prior
  // completion or are excluded from this run. Full scope is a no-op.
  applyScopeToCoverage(coverage, resolvedScope, bundle.coverage_matrix);
  // Layer the host-confirmed intent exclusions on top of disposition + scope so
  // user-pruned scope pollution never becomes an audit task.
  const intentExcludedPaths = applyIntentExclusionsToCoverage(
    coverage,
    bundle.intent_checkpoint?.excluded_scope,
  );
  const flowCoverage = buildFlowCoverage(bundle.critical_flows, coverage);
  const runtimeCommand = await discoverRuntimeValidationCommand(root);
  const runtimeValidationTasks = buildRuntimeValidationTasks({
    unitManifest: bundle.unit_manifest,
    criticalFlows: bundle.critical_flows,
    flowCoverage,
    command: runtimeCommand,
  });
  const runtimeValidationReport = runtimeValidationTasks.tasks.length > 0
    ? mergeRuntimeValidationReport(
        runtimeValidationTasks,
        bundle.runtime_validation_report,
      )
    : undefined;
  // Interpret free_form_intent into lens priority boosts (deterministic, no LLM).
  const intentBoostLenses = interpretFreeFormIntent(
    bundle.intent_checkpoint?.free_form_intent ?? "",
  );

  const auditTasks = buildChunkedAuditTasks(coverage, lineIndex, {
    external_analyzer_results: externalAnalyzerResults,
    critical_flows: bundle.critical_flows,
    ...(effectiveLenses !== undefined ? { limit_lenses: effectiveLenses } : {}),
    ...(intentBoostLenses.length > 0 ? { intent_priority_boost: intentBoostLenses } : {}),
  });
  const taggedAuditTasks = auditTasks.map((task) => ({
    ...task,
    status: task.status ?? ("pending" as const),
  }));
  const requeuePayload = buildRequeuePayload(
    coverage,
    bundle.critical_flows,
    flowCoverage,
    externalAnalyzerResults,
  );
  // Fold pending requeue tasks into the dispatch task list so mandatory coverage
  // gaps produce actual dispatch packets. Enrich with line-count hints from the
  // index and dedupe against existing audit tasks by task_id so each task
  // appears exactly once in the merged list.
  const existingTaskIds = new Set(taggedAuditTasks.map((t) => t.task_id));
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
  const allDispatchTasks = [...taggedAuditTasks, ...pendingRequeueTasks];

  const reviewPackets = buildReviewPackets(allDispatchTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex: resolvedSizeIndex,
  });
  const auditPlanMetrics = buildAuditPlanMetrics(allDispatchTasks, {
    graphBundle: bundle.graph_bundle,
    lineIndex,
    sizeIndex: resolvedSizeIndex,
  });

  const scopeSummary =
    resolvedScope.mode === "delta"
      ? ` Delta scope since ${resolvedScope.since}: ${resolvedScope.seed_files.length} changed file(s) + ${resolvedScope.expanded_files.length} graph neighbour(s) queued; a full audit is advised before release.`
      : "";

  return {
    updated: {
      ...bundle,
      scope: resolvedScope,
      coverage_matrix: coverage,
      flow_coverage: flowCoverage,
      runtime_validation_tasks: runtimeValidationTasks,
      runtime_validation_report: runtimeValidationReport,
      audit_tasks: taggedAuditTasks,
      audit_plan_metrics: auditPlanMetrics,
      review_packets: reviewPackets,
      requeue_tasks: requeuePayload.tasks,
      audit_report: undefined,
    },
    artifacts_written: [
      "scope.json",
      "coverage_matrix.json",
      "flow_coverage.json",
      "runtime_validation_tasks.json",
      ...(runtimeValidationReport ? ["runtime_validation_report.json"] : []),
      "audit_tasks.json",
      "audit_plan_metrics.json",
      "review_packets.json",
      "requeue_tasks.json",
    ],
    progress_summary:
      `Built planning artifacts; generated ${taggedAuditTasks.length} review tasks in ${reviewPackets.length} packet(s) and ${requeuePayload.task_count} requeue tasks.` +
      scopeSummary +
      (skippedTrivialPaths.length > 0
        ? ` Skipped ${skippedTrivialPaths.length} trivial path${skippedTrivialPaths.length === 1 ? "" : "s"} from semantic review.`
        : "") +
      (intentExcludedPaths.length > 0
        ? ` Excluded ${intentExcludedPaths.length} path${intentExcludedPaths.length === 1 ? "" : "s"} per the intent checkpoint.`
        : "") +
      (runtimeCommand
        ? ` Runtime validation will use: ${runtimeCommand.join(" ")}.`
        : " No deterministic runtime validation command was discovered."),
  };
}
