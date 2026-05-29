import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import type { AuditResult } from "../types.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import { decideNextStep, findObligation } from "./nextStep.js";
import { deriveAuditState } from "./state.js";
import { computeArtifactMetadata } from "./artifactMetadata.js";
import {
  runIntakeExecutor,
  runStructureExecutor,
  runPlanningExecutor,
  runResultIngestionExecutor,
  runRuntimeValidationExecutor,
  runRuntimeValidationUpdateExecutor,
  runSynthesisExecutor,
  runDesignAssessmentExecutor,
  runDesignReviewAutoComplete,
  runExternalAnalyzerImportExecutor,
} from "./internalExecutors.js";
import { runAutoFixExecutor } from "./autoFixExecutor.js";
import { runSyntaxResolutionExecutor } from "./syntaxResolutionExecutor.js";
import { RunLogger } from "@audit-tools/shared";

export interface AdvanceAuditOptions {
  root?: string;
  lineIndex?: Record<string, number>;
  /** Path → size_bytes (from the repo manifest); drives byte-based packet token sizing. */
  sizeIndex?: Record<string, number>;
  auditResults?: AuditResult[];
  runtimeValidationUpdates?: RuntimeValidationReport;
  externalAnalyzerResults?: ExternalAnalyzerResults;
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

export async function advanceAudit(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions = {},
): Promise<AdvanceAuditResult> {
  const log = options.runLogger ?? RunLogger.disabled();
  const decision = decideNextStep(bundle);
  const forcedExecutor = options.preferredExecutor ?? null;
  const selectedExecutor = forcedExecutor ?? decision.selected_executor;
  const selectedObligation = forcedExecutor
    ? `forced:${forcedExecutor}`
    : decision.selected_obligation;

  log.event({
    phase: "advance",
    kind: "obligation",
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
  const executorStartedAt = Date.now();
  log.event({
    phase: "advance",
    kind: "executor_start",
    obligation: selectedObligation ?? undefined,
    note: selectedExecutor,
  });
  try {
    switch (selectedExecutor) {
      case "intake_executor":
        if (!options.root)
          throw new Error("advanceAudit intake_executor requires root");
        run = await runIntakeExecutor(bundle, options.root);
        break;
      case "structure_executor":
        run = await runStructureExecutor(bundle, options.root);
        break;
      case "design_assessment_executor":
        run = runDesignAssessmentExecutor(bundle);
        break;
      case "design_review":
        run = runDesignReviewAutoComplete(bundle);
        break;
      case "planning_executor":
        if (!options.root)
          throw new Error("advanceAudit planning_executor requires root");
        run = await runPlanningExecutor(
          bundle,
          options.root,
          options.lineIndex ?? {},
          options.sizeIndex,
        );
        break;
      case "result_ingestion_executor":
        run = runResultIngestionExecutor(
          bundle,
          options.auditResults ?? bundle.audit_results ?? [],
        );
        break;
      case "runtime_validation_executor":
        if (!options.root)
          throw new Error(
            "advanceAudit runtime_validation_executor requires root",
          );
        run = await runRuntimeValidationExecutor(bundle, options.root, {
          opentoken: options.opentoken,
        });
        break;
      case "synthesis_executor":
        run = runSynthesisExecutor(bundle, options.auditResults);
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
      case "auto_fix_executor":
        if (!options.root)
          throw new Error("advanceAudit auto_fix_executor requires root");
        run = runAutoFixExecutor(bundle, options.root);
        break;
      case "syntax_resolution_executor":
        if (!options.root)
          throw new Error(
            "advanceAudit syntax_resolution_executor requires root",
          );
        run = runSyntaxResolutionExecutor(bundle, options.root);
        break;
      default: {
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
    obligation: selectedObligation ?? undefined,
    note: selectedExecutor,
    duration_ms: Date.now() - executorStartedAt,
  });
  for (const artifact of run.artifacts_written) {
    log.event({
      phase: "advance",
      kind: "artifact_write",
      obligation: selectedObligation ?? undefined,
      artifact,
    });
  }

  const metadata = computeArtifactMetadata(
    run.updated,
    bundle.artifact_metadata,
    [...run.artifacts_written, "tooling_manifest.json"],
  );
  const metadataBundle = {
    ...run.updated,
    tooling_manifest: bundle.tooling_manifest,
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
