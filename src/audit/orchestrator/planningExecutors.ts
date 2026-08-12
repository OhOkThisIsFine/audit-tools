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
  sizeIndexFromManifest,
} from "./reviewPackets.js";
import { taskContentTokens } from "./reviewPacketSizing.js";
import { computeRiskEstimate } from "./auditTaskUtils.js";
import { buildTaskAffinityGraph } from "./taskAffinityGraph.js";
import { resolveIntentLensSelection } from "./lensSelection.js";
import { foldPendingRequeueTasks } from "./requeueFold.js";
import { autoCompleteTrivialCoverage } from "./trivialAudit.js";
import {
  applyContentAddressedPreservation,
  coverageContentSignature,
  readCoverageElementBaselines,
  recordCoverageElementBaselines,
  withCoverageElementBaselines,
} from "./coverageElementBaseline.js";
import { interpretFreeFormIntentForAudit } from "./intentInterpreter.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { AuditTask, Lens } from "../types.js";
import { canonicalizeAuditTasks } from "../../shared/affinityArtifacts.js";

// ---------------------------------------------------------------------------
// Free-form intent interpreter (keyword → lens boost, deterministic, no LLM)
// ---------------------------------------------------------------------------

/**
 * Interpret a free-form intent string into lenses to priority-boost.
 *
 * Single authority: this delegates to the shared clause-aware interpreter via
 * `interpretFreeFormIntentForAudit` (→ `audit-tools/shared` `interpretIntent`).
 * There is exactly one keyword/lens map in the codebase — the shared
 * `LENS_KEYWORD_MAP`. Lens boosts are derived from the `lens_weight` encoded
 * clauses; unencodable clauses are NOT silently dropped here — they are gated
 * upstream as blocking checkpoint questions (see `state.ts`
 * `intent_checkpoint_current` and `confirmIntentStep.ts`).
 *
 * Deterministic — no LLM call.
 * INV-S04: the verbatim intent string never appears in output fields.
 */
export function interpretFreeFormIntent(text: string): Lens[] {
  if (!text || text.trim().length === 0) return [];
  const interpretation = interpretFreeFormIntentForAudit(text);
  const boosts = new Set<Lens>();
  for (const clause of interpretation.encoded_clauses) {
    if (clause.kind === "lens_weight" && clause.lens) {
      boosts.add(clause.lens);
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
  // included; resolveIntentLensSelection enforces this invariant and is the same
  // resolution the ingestion draw's requeue fold reads).
  const effectiveLenses = resolveIntentLensSelection(
    bundle.intent_checkpoint?.lens_selection,
  );

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
  // T5 #12 content-addressed GRANULAR staleness: preserve prior completion for
  // files whose audit inputs (content signal + required lenses + unit membership)
  // are unchanged from the recorded baseline, so a re-plan triggered by an
  // unrelated upstream change doesn't re-audit files that didn't move. First plan
  // (no baseline) preserves nothing → identical to prior behavior. Then re-record
  // the per-element baselines for THIS coverage so the next re-plan can compare.
  const coverageContentSig = coverageContentSignature(bundle.repo_manifest);
  const preservedCount = applyContentAddressedPreservation(
    coverage,
    bundle.coverage_matrix,
    readCoverageElementBaselines(bundle.artifact_metadata),
    coverageContentSig,
  );
  const refreshedCoverageBaselines = recordCoverageElementBaselines(
    coverage,
    coverageContentSig,
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
  // Interpret free_form_intent into lens priority boosts via the single shared
  // clause-aware authority (deterministic, no LLM). Unencodable clauses are NOT
  // dropped here — they are gated upstream as a blocking checkpoint question
  // (state.ts intent_checkpoint_current), so by the time planning runs every
  // clause is either an encoded signal or an explicitly host-answered constraint.
  const freeFormIntent = bundle.intent_checkpoint?.free_form_intent ?? "";
  const intentBoostLenses = interpretFreeFormIntent(freeFormIntent);
  if (freeFormIntent.trim().length > 0) {
    const interpretation = interpretFreeFormIntentForAudit(freeFormIntent);
    // INV-S04: derived signal only — never the verbatim free_form_intent. Each
    // encoded clause's `detail` is a generated description, not the raw input.
    const encodedSignals = interpretation.encoded_clauses.map(
      (c) => `${c.kind}${c.lens ? `:${c.lens}` : ""}`,
    );
    process.stderr.write(
      JSON.stringify({
        kind: "intent_keyword_interpretation",
        boosted_lenses: intentBoostLenses,
        encoded_signals: encodedSignals,
        ts: new Date().toISOString(),
      }) + "\n",
    );
  }

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
  // Fold pending requeue tasks into the review set so mandatory coverage gaps
  // produce host work items — through the SHARED fold (`foldPendingRequeueTasks`),
  // whose dedupe is COVERAGE-based: a requeue task whose (path × lens) an
  // existing audit task already covers is a duplicate of planned work (the fresh
  // -plan requeue payload mirrors the whole pending set under different ids), so
  // only genuinely-uncovered gaps survive — and those ARE persisted below
  // (INV-PLAN-PERSIST-COMPLETE).
  const pendingRequeueTasks = foldPendingRequeueTasks({
    requeueTasks: requeuePayload.tasks,
    auditTasks: taggedAuditTasks,
    lineIndex,
    effectiveLenses,
  });
  // Freeze local estimates on every review task: a byte-based token estimate and
  // a deterministic risk seed. These persist as descriptive host-workload
  // metadata; the estimate-review step may later refine them.
  const freezeEstimates = (task: AuditTask): AuditTask => ({
    ...task,
    token_estimate:
      task.token_estimate ??
      taskContentTokens(task, resolvedSizeIndex, lineIndex),
    risk_estimate: task.risk_estimate ?? computeRiskEstimate(task),
  });
  const enrichedAuditTasks = taggedAuditTasks.map(freezeEstimates);
  const allReviewTasks = canonicalizeAuditTasks([
    ...enrichedAuditTasks,
    ...pendingRequeueTasks.map(freezeEstimates),
  ]);

  // Persist frozen task nodes and their soft affinity edges; the host workload
  // later projects canonical coherence groups from this graph.
  const taskAffinityGraph = buildTaskAffinityGraph(allReviewTasks, {
    graphBundle: bundle.graph_bundle,
  });
  const auditPlanMetrics = buildAuditPlanMetrics(allReviewTasks, {
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
      // INV-PLAN-PERSIST-COMPLETE: the persisted review set is the whole merged
      // list. An omitted task would be a phantom described by the affinity graph
      // and metrics but absent from the emitted workload. Estimates on every
      // entry are frozen (INV-PLAN-FROZEN-ESTIMATES).
      audit_tasks: allReviewTasks,
      audit_plan_metrics: auditPlanMetrics,
      task_affinity_graph: taskAffinityGraph,
      requeue_tasks: requeuePayload.tasks,
      audit_report: undefined,
      artifact_metadata: withCoverageElementBaselines(
        bundle.artifact_metadata,
        refreshedCoverageBaselines,
      ),
    },
    artifacts_written: [
      "scope.json",
      "coverage_matrix.json",
      "flow_coverage.json",
      "runtime_validation_tasks.json",
      ...(runtimeValidationReport ? ["runtime_validation_report.json"] : []),
      "audit_tasks.json",
      "audit_plan_metrics.json",
      "task_affinity_graph.json",
      "requeue_tasks.json",
    ],
    progress_summary:
      `Built planning artifacts; generated ${taggedAuditTasks.length} review tasks and ${requeuePayload.task_count} requeue tasks.` +
      scopeSummary +
      (skippedTrivialPaths.length > 0
        ? ` Skipped ${skippedTrivialPaths.length} trivial path${skippedTrivialPaths.length === 1 ? "" : "s"} from semantic review.`
        : "") +
      (preservedCount > 0
        ? ` Preserved prior completion for ${preservedCount} unchanged file${preservedCount === 1 ? "" : "s"} (content-addressed staleness).`
        : "") +
      (intentExcludedPaths.length > 0
        ? ` Excluded ${intentExcludedPaths.length} path${intentExcludedPaths.length === 1 ? "" : "s"} per the intent checkpoint.`
        : "") +
      (runtimeCommand
        ? ` Runtime validation will use: ${runtimeCommand.join(" ")}.`
        : " No deterministic runtime validation command was discovered."),
  };
}
