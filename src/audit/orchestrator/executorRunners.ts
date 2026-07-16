import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { AdvanceAuditOptions } from "./advanceTypes.js";
import { RunLogger, auditArtifactsDir } from "audit-tools/shared";
import { decideAuditFrictionCloseout } from "./nextStep.js";
import { runIntakeExecutor, runProviderConfirmationAutoComplete } from "./intakeExecutors.js";
import { runIntentCheckpointAutoComplete } from "./intentCheckpointExecutor.js";
import {
  runStructureExecutor,
  runDesignAssessmentExecutor,
  runStructureDecompositionExecutor,
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
import { runCriticalFlowFallbackExecutor } from "./criticalFlowFallbackExecutor.js";
import { runCharterExtractionExecutor } from "./charterExtractionExecutor.js";
import { runCharterDeltaExecutor } from "./charterDeltaExecutor.js";
import { runCharterClarificationExecutor } from "./charterClarificationExecutor.js";
import { runSystemicChallengeExecutor } from "./systemicChallengeExecutor.js";
import { runAutoFixExecutor } from "./autoFixExecutor.js";
import { runSyntaxResolutionExecutor } from "./syntaxResolutionExecutor.js";
import { runGraphEnrichmentExecutor } from "./graphEnrichmentExecutor.js";
import { runExternalAnalyzerAcquisitionExecutor } from "./acquisitionExecutor.js";
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
  provider_confirmation_executor: async (bundle, { options }) =>
    runProviderConfirmationAutoComplete(
      bundle,
      options.root,
      options.artifactsDir,
      // 2a-ii: the effective dispatch config (handshake inventory) — so the confirmed
      // pool is built/persisted from the per-auditor inventory, never a re-read of the
      // repo config that would re-leak another auditor's backends into the routed pool.
      options.sessionConfig,
    ),
  intake_executor: async (bundle, { options }) =>
    runIntakeExecutor(
      bundle,
      requireRoot(options.root, "intake_executor"),
      options.artifactsDir,
    ),
  intent_checkpoint_executor: async (bundle, { options }) =>
    runIntentCheckpointAutoComplete(
      bundle,
      requireRoot(options.root, "intent_checkpoint_executor"),
      options.since,
    ),
  // root is intentionally optional: present → buildGraphBundleFromFs, absent →
  // manifest-only buildGraphBundle.
  external_analyzer_acquisition_executor: async (bundle, { options }) =>
    runExternalAnalyzerAcquisitionExecutor(
      bundle,
      options.root,
      options.externalAcquisition,
    ),
  structure_executor: async (bundle, { options }) =>
    runStructureExecutor(bundle, options.root),
  critical_flow_fallback_executor: async (bundle, { options }) =>
    runCriticalFlowFallbackExecutor(bundle, options.criticalFlowFallbackResults),
  graph_enrichment_executor: async (bundle, { options }) =>
    runGraphEnrichmentExecutor(bundle, {
      root: options.root,
      analyzers: options.analyzers,
      llmEdgeReasoning: options.graphLlmEdgeReasoning,
      edgeReasoning: options.edgeReasoningResults,
    }),
  design_assessment_executor: async (bundle) =>
    runDesignAssessmentExecutor(bundle),
  structure_decomposition_executor: async (bundle, { options }) =>
    runStructureDecompositionExecutor(bundle, options.root),
  charter_extraction_executor: async (bundle, { options }) =>
    runCharterExtractionExecutor(bundle, options.charterSubmission),
  charter_delta_executor: async (bundle, { options }) =>
    runCharterDeltaExecutor(bundle, options.charterDeltaSubmission),
  charter_clarification_executor: async (bundle, { options }) =>
    runCharterClarificationExecutor(bundle, options.clarificationAnswers),
  systemic_challenge_executor: async (bundle, { options }) =>
    runSystemicChallengeExecutor(bundle, options.systemicChallenge),
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
  // friction_capture_executor is retained for schema compatibility but is unreachable:
  // the friction_capture_current obligation is not in deriveAuditState, so the engine
  // never selects it. The triage now fires in the present_report terminal step
  // (nextStepHelpers.ts / nextStepCommand.ts) via decideAuditFrictionCloseout.
  friction_capture_executor: async (bundle, { options }) => {
    const artifactsDir =
      options.artifactsDir ??
      auditArtifactsDir(requireRoot(options.root, "friction_capture_executor"));
    const decision = await decideAuditFrictionCloseout(artifactsDir, "run");
    return {
      updated: bundle,
      artifacts_written: ["friction/run.json"],
      progress_summary:
        decision.action === "disposed"
          ? "Friction triage disposed."
          : `Friction triage pending: ${decision.pending.length} item(s), needs_open_observations=${decision.needs_open_observations}.`,
    };
  },
};
