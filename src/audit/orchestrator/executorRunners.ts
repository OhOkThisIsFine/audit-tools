import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { AdvanceAuditOptions } from "./advanceTypes.js";
import { RunLogger } from "audit-tools/shared";
import { runIntakeExecutor, runProviderConfirmationAutoComplete } from "./intakeExecutors.js";
import { runIntentCheckpointAutoComplete } from "./intentCheckpointExecutor.js";
import {
  runStructureExecutor,
  runDesignAssessmentExecutor,
  runDesignReviewAutoComplete,
} from "./structureExecutors.js";
import { runPlanningExecutor } from "./planningExecutors.js";
import {
  runResultIngestionExecutor,
  runRuntimeValidationExecutor,
  runRuntimeValidationUpdateExecutor,
  runExternalAnalyzerImportExecutor,
} from "./ingestionExecutors.js";
import {
  runSynthesisExecutor,
  runSynthesisNarrativeExecutor,
} from "./synthesisExecutors.js";
import { runAutoFixExecutor } from "./autoFixExecutor.js";
import { runSyntaxResolutionExecutor } from "./syntaxResolutionExecutor.js";
import { runGraphEnrichmentExecutor } from "./graphEnrichmentExecutor.js";
import { resolveAuditScope } from "./scope.js";

/**
 * Per-dispatch execution context threaded to every executor runner. Carries the
 * advance options (root, line/size indexes, incoming host results, analyzer
 * policy, …) plus the run logger + correlation id so a runner that emits its own
 * structured events (planning's scope event) can do so. The engine stays agnostic;
 * audit-code picks its own `Ctx` shape (cf. remediate-code's `RemediateCtx`).
 */
export interface AuditExecutorCtx {
  options: AdvanceAuditOptions;
  log: RunLogger;
  correlationId: string;
  obligation: string | null;
}

/** A single audit executor: bundle + ctx → the uniform run result. */
export type AuditExecutorRunner = (
  bundle: ArtifactBundle,
  ctx: AuditExecutorCtx,
) => Promise<ExecutorRunResult>;

/**
 * Narrow an optional root to a definite string for a runner that requires it,
 * throwing the canonical "advanceAudit <executor> requires root" error otherwise.
 */
function requireRoot(root: string | undefined, executorName: string): string {
  if (!root) {
    throw new Error(`advanceAudit ${executorName} requires root`);
  }
  return root;
}

/**
 * Executor-id → runner. The single source of dispatch (A3 step 4 slice 2a):
 * `advanceAudit`'s scan path and its `preferredExecutor` forced path both dispatch
 * through this map, replacing the hand `switch` and the registry⇄switch sync
 * invariant. Each runner co-locates the per-executor argument adaptation the
 * switch arm used to do. Slice 2b reuses these same runners inside the obligation
 * `execute` closures that drive the `advance` fold.
 *
 * Executors absent here are the host-delegation *dispatch* points (`agent`,
 * `rolling_dispatch_executor`): routed through host delegation before reaching
 * `advanceAudit`, they produce a no-progress handoff (the "no runner" branch)
 * rather than a deterministic run.
 */
export const EXECUTOR_RUNNERS: Record<string, AuditExecutorRunner> = {
  provider_confirmation_executor: async (bundle) =>
    runProviderConfirmationAutoComplete(bundle),
  intake_executor: async (bundle, { options }) =>
    runIntakeExecutor(bundle, requireRoot(options.root, "intake_executor")),
  intent_checkpoint_executor: async (bundle, { options }) =>
    runIntentCheckpointAutoComplete(
      bundle,
      requireRoot(options.root, "intent_checkpoint_executor"),
      options.since,
    ),
  // root is intentionally optional: present → buildGraphBundleFromFs, absent →
  // manifest-only buildGraphBundle.
  structure_executor: async (bundle, { options }) =>
    runStructureExecutor(bundle, options.root),
  graph_enrichment_executor: async (bundle, { options }) =>
    runGraphEnrichmentExecutor(bundle, {
      root: options.root,
      analyzers: options.analyzers,
      llmEdgeReasoning: options.graphLlmEdgeReasoning,
      edgeReasoning: options.edgeReasoningResults,
    }),
  design_assessment_executor: async (bundle) =>
    runDesignAssessmentExecutor(bundle),
  design_review_contract: async (bundle) =>
    runDesignReviewAutoComplete(bundle, "contract"),
  design_review_conceptual: async (bundle) =>
    runDesignReviewAutoComplete(bundle, "conceptual"),
  // Legacy: auto-complete both passes.
  design_review: async (bundle) => runDesignReviewAutoComplete(bundle, "both"),
  planning_executor: async (bundle, { options, log, correlationId, obligation }) => {
    const root = requireRoot(options.root, "planning_executor");
    const plannedScope = resolveAuditScope({ root, since: options.since, bundle });
    log.event({
      phase: "advance",
      kind: "scope",
      correlationId,
      obligation: obligation ?? undefined,
      note:
        plannedScope.mode === "delta"
          ? `delta since ${plannedScope.since}: ${plannedScope.seed_files.length} changed + ${plannedScope.expanded_files.length} neighbors; full audit advised before release`
          : "full audit scope",
    });
    return runPlanningExecutor(
      bundle,
      root,
      options.lineIndex ?? {},
      options.sizeIndex,
      plannedScope,
    );
  },
  result_ingestion_executor: async (bundle, { options }) =>
    runResultIngestionExecutor(
      bundle,
      options.auditResults ?? bundle.audit_results ?? [],
    ),
  runtime_validation_executor: async (bundle, { options }) =>
    runRuntimeValidationExecutor(
      bundle,
      requireRoot(options.root, "runtime_validation_executor"),
    ),
  synthesis_executor: async (bundle, { options }) =>
    runSynthesisExecutor(bundle, options.auditResults),
  synthesis_narrative_executor: async (bundle, { options }) =>
    runSynthesisNarrativeExecutor(bundle, options.narrativeResults),
  runtime_validation_update_executor: async (bundle, { options }) => {
    if (!options.runtimeValidationUpdates) {
      throw new Error(
        "advanceAudit runtime_validation_update_executor requires runtimeValidationUpdates",
      );
    }
    return runRuntimeValidationUpdateExecutor(
      bundle,
      options.runtimeValidationUpdates,
    );
  },
  external_analyzer_import_executor: async (bundle, { options }) => {
    if (!options.externalAnalyzerResults) {
      throw new Error(
        "advanceAudit external_analyzer_import_executor requires externalAnalyzerResults",
      );
    }
    return runExternalAnalyzerImportExecutor(
      bundle,
      options.externalAnalyzerResults,
    );
  },
  auto_fix_executor: async (bundle, { options }) =>
    runAutoFixExecutor(bundle, requireRoot(options.root, "auto_fix_executor")),
  syntax_resolution_executor: async (bundle, { options }) =>
    runSyntaxResolutionExecutor(
      bundle,
      requireRoot(options.root, "syntax_resolution_executor"),
    ),
};
