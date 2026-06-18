import { randomUUID } from "node:crypto";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import { decideNextStep, findObligation } from "./nextStep.js";
import { deriveAuditState } from "./state.js";
import { computeArtifactMetadata } from "./artifactMetadata.js";
import { EXECUTOR_RUNNERS } from "./executorRunners.js";
import type { ExecutorRunResult } from "./executorResult.js";
import { AGENT_FEEDBACK_FILENAME, RunLogger } from "@audit-tools/shared";
import type { AdvanceAuditOptions, AdvanceAuditResult } from "./advanceTypes.js";

export type { AdvanceAuditOptions, AdvanceAuditResult } from "./advanceTypes.js";

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

  const executorStartedAt = Date.now();
  log.event({
    phase: "advance",
    kind: "executor_start",
    correlationId,
    obligation: selectedObligation ?? undefined,
    note: selectedExecutor,
  });

  const runner = EXECUTOR_RUNNERS[selectedExecutor];
  if (!runner) {
    // No deterministic runner. The host-delegation dispatch executors (`agent`,
    // `rolling_dispatch_executor`) are routed through host delegation before
    // reaching advanceAudit; dispatched directly they return a no-progress
    // "selected but not yet dispatched" handoff rather than throwing — the
    // absence of a runner is the single source of truth for "not deterministically
    // dispatchable" (replaces the old default-branch + registry⇄switch invariant).
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

  let run: ExecutorRunResult;
  try {
    run = await runner(bundle, {
      options,
      log,
      correlationId,
      obligation: selectedObligation,
    });
  } catch (error) {
    log.event({
      phase: "advance",
      kind: "error",
      correlationId,
      obligation: selectedObligation ?? undefined,
      note: `Executor ${selectedExecutor} threw: ${error instanceof Error ? error.message : String(error ?? "unknown error")}`,
    });
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
