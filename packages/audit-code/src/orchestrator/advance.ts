import { randomUUID } from "node:crypto";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import type { AuditResult } from "../types.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { decideNextStep, findObligation } from "./nextStep.js";
import { deriveAuditState } from "./state.js";
import { computeArtifactMetadata } from "./artifactMetadata.js";
import { runIntakeExecutor } from "./intakeExecutors.js";
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
import type { AuditScopeManifest } from "../types/auditScope.js";
import { AGENT_FEEDBACK_FILENAME, RunLogger } from "@audit-tools/shared";
import type { AnalyzerSetting, SynthesisNarrative } from "@audit-tools/shared";
import type { EdgeReasoningResults } from "./edgeReasoning.js";

export interface AdvanceAuditOptions {
  root?: string;
  lineIndex?: Record<string, number>;
  /** Path → size_bytes (from the repo manifest); drives byte-based packet token sizing. */
  sizeIndex?: Record<string, number>;
  auditResults?: AuditResult[];
  runtimeValidationUpdates?: RuntimeValidationReport;
  externalAnalyzerResults?: ExternalAnalyzerResults;
  /** Host/provider-supplied synthesis narrative; merged by synthesis_narrative_executor. */
  narrativeResults?: SynthesisNarrative;
  /** Per-analyzer resolution policy for the optional graph-enrichment pass. */
  analyzers?: Record<string, AnalyzerSetting>;
  /** Phase 4B gate (session-config `graph.llm_edge_reasoning`); default off. */
  graphLlmEdgeReasoning?: boolean;
  /** Phase 4B host-supplied reason rewrites for low-confidence graph edges. */
  edgeReasoningResults?: EdgeReasoningResults;
  /**
   * Git ref for Phase 3 delta mode (the `--since` flag). When set and resolvable
   * against a git repo, planning scopes coverage to the changed files and their
   * graph neighbours; otherwise the run is a full audit.
   */
  since?: string;
  preferredExecutor?: string;
  opentoken?: boolean;
  runLogger?: RunLogger;
}

export interface AdvanceAuditResult {
  audit_state: AuditState;
  selected_obligation: string | null;
  selected_executor: string | null;
  progress_made: boolean;
  artifacts_written: string[];
  progress_summary: string;
  next_likely_step: string | null;
  updated_bundle: ArtifactBundle;
}

/**
 * Narrow an optional root to a definite string for an executor that requires
 * it, throwing the canonical "advanceAudit <executor> requires root" error
 * otherwise. Replaces the guard previously copy-pasted across every
 * root-dependent executor branch below.
 */
function requireRoot(root: string | undefined, executorName: string): string {
  if (!root) {
    throw new Error(`advanceAudit ${executorName} requires root`);
  }
  return root;
}

function cloneState(state: AuditState): AuditState {
  return {
    ...state,
    blockers: [...(state.blockers ?? [])],
    obligations: state.obligations.map((obligation) => ({ ...obligation })),
  };
}

function formatExecutorFailure(
  selectedExecutor: string,
  selectedObligation: string | null,
  error: unknown,
): Error {
  const detail =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  return new Error(
    `advanceAudit ${selectedExecutor} failed while resolving ${selectedObligation ?? "the current obligation"}: ${detail}`,
    {
      cause: error instanceof Error ? error : undefined,
    },
  );
}

function createCorrelationId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 8);
}

export async function advanceAudit(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions = {},
): Promise<AdvanceAuditResult> {
  const log = options.runLogger ?? RunLogger.disabled();
  const correlationId = createCorrelationId();
  const decision = decideNextStep(bundle);
  const forcedExecutor = options.preferredExecutor ?? null;
  const selectedExecutor = forcedExecutor ?? decision.selected_executor;
  const selectedObligation = forcedExecutor
    ? `forced:${forcedExecutor}`
    : decision.selected_obligation;

  log.event({
    phase: "advance",
    kind: "obligation",
    correlationId,
    obligation: selectedObligation ?? undefined,
    note: decision.reason,
  });

  if (!selectedExecutor) {
    const state = cloneState(decision.state);
    state.last_executor = bundle.audit_state?.last_executor ?? state.last_executor;
    state.last_obligation =
      selectedObligation ??
      bundle.audit_state?.last_obligation ??
      state.last_obligation;
    return {
      audit_state: state,
      selected_obligation: selectedObligation,
      selected_executor: selectedExecutor,
      progress_made: false,
      artifacts_written: ["audit_state.json"],
      progress_summary: decision.reason,
      next_likely_step: null,
      updated_bundle: { ...bundle, audit_state: state },
    };
  }

  let run;
  let plannedScope: AuditScopeManifest | undefined;
  const executorStartedAt = Date.now();
  log.event({
    phase: "advance",
    kind: "executor_start",
    correlationId,
    obligation: selectedObligation ?? undefined,
    note: selectedExecutor,
  });
  try {
    switch (selectedExecutor) {
      case "intake_executor": {
        const root = requireRoot(options.root, "intake_executor");
        run = await runIntakeExecutor(bundle, root);
        break;
      }
      case "intent_checkpoint_executor": {
        const root = requireRoot(options.root, "intent_checkpoint_executor");
        run = runIntentCheckpointAutoComplete(bundle, root, options.since);
        break;
      }
      case "structure_executor":
        // root is intentionally optional: present → buildGraphBundleFromFs, absent → manifest-only buildGraphBundle
        run = await runStructureExecutor(bundle, options.root);
        break;
      case "graph_enrichment_executor":
        run = await runGraphEnrichmentExecutor(bundle, {
          root: options.root,
          analyzers: options.analyzers,
          llmEdgeReasoning: options.graphLlmEdgeReasoning,
          edgeReasoning: options.edgeReasoningResults,
        });
        break;
      case "design_assessment_executor":
        run = runDesignAssessmentExecutor(bundle);
        break;
      case "design_review":
        run = runDesignReviewAutoComplete(bundle);
        break;
      case "planning_executor": {
        const root = requireRoot(options.root, "planning_executor");
        plannedScope = resolveAuditScope({
          root,
          since: options.since,
          bundle,
        });
        run = await runPlanningExecutor(
          bundle,
          root,
          options.lineIndex ?? {},
          options.sizeIndex,
          plannedScope,
        );
        break;
      }
      case "result_ingestion_executor":
        run = runResultIngestionExecutor(
          bundle,
          options.auditResults ?? bundle.audit_results ?? [],
        );
        break;
      case "runtime_validation_executor": {
        const root = requireRoot(options.root, "runtime_validation_executor");
        run = await runRuntimeValidationExecutor(bundle, root, {
          opentoken: options.opentoken,
        });
        break;
      }
      case "synthesis_executor":
        run = runSynthesisExecutor(bundle, options.auditResults);
        break;
      case "synthesis_narrative_executor":
        run = runSynthesisNarrativeExecutor(bundle, options.narrativeResults);
        break;
      case "runtime_validation_update_executor":
        if (!options.runtimeValidationUpdates)
          throw new Error(
            "advanceAudit runtime_validation_update_executor requires runtimeValidationUpdates",
          );
        run = runRuntimeValidationUpdateExecutor(
          bundle,
          options.runtimeValidationUpdates,
        );
        break;
      case "external_analyzer_import_executor":
        if (!options.externalAnalyzerResults)
          throw new Error(
            "advanceAudit external_analyzer_import_executor requires externalAnalyzerResults",
          );
        run = runExternalAnalyzerImportExecutor(
          bundle,
          options.externalAnalyzerResults,
        );
        break;
      case "auto_fix_executor": {
        const root = requireRoot(options.root, "auto_fix_executor");
        run = await runAutoFixExecutor(bundle, root);
        break;
      }
      case "syntax_resolution_executor": {
        const root = requireRoot(options.root, "syntax_resolution_executor");
        run = runSyntaxResolutionExecutor(bundle, root);
        break;
      }
      // `agent` is a host-delegation executor: its review tasks are dispatched
      // to the active LLM agent (or a worker) and ingested via
      // result_ingestion_executor — advanceAudit cannot complete them
      // deterministically. Callers (next-step / run-to-completion) route it
      // through host delegation before reaching here; if it is dispatched into
      // advanceAudit directly it falls through to the default branch, which
      // returns a no-progress "selected but not yet dispatched" handoff rather
      // than throwing. An explicit case keeps the registry⇄switch invariant
      // (executor-registry-sync) honest about agent being handled here.
      case "agent":
      default: {
        log.event({
          phase: "advance",
          kind: "error",
          correlationId,
          obligation: selectedObligation ?? undefined,
          note: `Unrecognized executor: ${selectedExecutor}`,
        });
        log.event({
          phase: "advance",
          kind: "executor_end",
          correlationId,
          obligation: selectedObligation ?? undefined,
          note: selectedExecutor,
          duration_ms: Date.now() - executorStartedAt,
        });
        const state = deriveAuditState(bundle);
        state.last_executor = selectedExecutor;
        state.last_obligation = selectedObligation ?? undefined;
        return {
          audit_state: state,
          selected_obligation: selectedObligation,
          selected_executor: selectedExecutor,
          progress_made: false,
          artifacts_written: ["audit_state.json"],
          progress_summary: `Executor ${selectedExecutor} is selected but not yet dispatched through advance-audit.`,
          next_likely_step: selectedObligation,
          updated_bundle: { ...bundle, audit_state: state },
        };
      }
    }
  } catch (error) {
    throw formatExecutorFailure(selectedExecutor, selectedObligation, error);
  }

  log.event({
    phase: "advance",
    kind: "executor_end",
    correlationId,
    obligation: selectedObligation ?? undefined,
    note: selectedExecutor,
    duration_ms: Date.now() - executorStartedAt,
  });
  if (plannedScope) {
    log.event({
      phase: "advance",
      kind: "scope",
      correlationId,
      obligation: selectedObligation ?? undefined,
      note:
        plannedScope.mode === "delta"
          ? `delta since ${plannedScope.since}: ${plannedScope.seed_files.length} changed + ${plannedScope.expanded_files.length} neighbors; full audit advised before release`
          : "full audit scope",
    });
  }
  for (const artifact of run.artifacts_written) {
    log.event({
      phase: "advance",
      kind: "artifact_write",
      correlationId,
      obligation: selectedObligation ?? undefined,
      artifact,
    });
  }

  // tooling_manifest.json and agent-feedback.jsonl are produced outside the
  // executor loop (environment probe / worker appends), so no executor ever
  // lists them in artifacts_written. Treat both as always-updated: their
  // metadata entries are recomputed from live content each advance — unchanged
  // content keeps its revision (no churn), changed content bumps it so
  // dependents re-stale exactly once instead of perpetually mismatching a
  // carried-forward stale hash.
  const metadata = computeArtifactMetadata(
    run.updated,
    bundle.artifact_metadata,
    [...run.artifacts_written, "tooling_manifest.json", AGENT_FEEDBACK_FILENAME],
  );
  const metadataBundle = {
    ...run.updated,
    tooling_manifest: bundle.tooling_manifest,
    agent_reflections: bundle.agent_reflections,
    artifact_metadata: metadata,
  };
  const updatedState = deriveAuditState(metadataBundle);
  updatedState.last_executor = selectedExecutor;
  updatedState.last_obligation = selectedObligation ?? undefined;
  const finalizedBundle = { ...metadataBundle, audit_state: updatedState };
  const nextObligation = findObligation(updatedState.obligations);

  return {
    audit_state: updatedState,
    selected_obligation: selectedObligation,
    selected_executor: selectedExecutor,
    progress_made: true,
    artifacts_written: [
      ...run.artifacts_written,
      "artifact_metadata.json",
      "audit_state.json",
    ],
    progress_summary: run.progress_summary,
    next_likely_step: nextObligation?.id ?? null,
    updated_bundle: finalizedBundle,
  };
}
