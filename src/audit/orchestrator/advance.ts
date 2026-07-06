import { randomUUID } from "node:crypto";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import { decideNextStep, findObligation } from "./nextStep.js";
import { deriveAuditState } from "./state.js";
import { computeArtifactMetadata } from "./artifactMetadata.js";
import { EXECUTOR_RUNNERS } from "./executorRunners.js";
import { isHostDelegationExecutor } from "./executors.js";
import {
  computeStaleArtifacts,
  emitStalenessRecord,
  isMetadataMigrationStaleness,
} from "./staleness.js";
import type { ExecutorRunResult } from "./executorResult.js";
import { AGENT_FEEDBACK_FILENAME, RunLogger } from "audit-tools/shared";
import type { AdvanceAuditOptions, AdvanceAuditResult } from "./advanceTypes.js";

export type { AdvanceAuditOptions, AdvanceAuditResult } from "./advanceTypes.js";

/**
 * Hard ceiling on the internal drain loop. The regen frontier is finite (each
 * deterministic step satisfies at least one obligation and no deterministic
 * executor re-opens an upstream one), so the loop terminates naturally when the
 * next step is a host-delegation boundary / complete / no-runner. This bound is
 * a belt-and-braces guard against an unforeseen re-opening cycle — larger than
 * the deterministic obligation frontier can ever be, so it never trips on a
 * healthy run. Chain-length/index-agnostic: it caps iterations, not a fixed
 * executor index.
 */
const MAX_DRAIN_STEPS = 64;

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

/**
 * Execute exactly ONE bounded audit step: derive state, pick the highest-priority
 * obligation (or the forced `preferredExecutor`), dispatch its runner, recompute
 * metadata + state, and return the advance result WITHOUT persisting. All internal
 * state derivations run with `emitStaleness: false` — the caller (`advanceAudit`)
 * emits a single consolidated staleness record for the whole drain at the boundary.
 */
async function runSingleAdvanceStep(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions = {},
): Promise<AdvanceAuditResult> {
  const log = options.runLogger ?? RunLogger.disabled();
  const correlationId = createCorrelationId();
  const decision = decideNextStep(bundle, { emitStaleness: false });
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
    const state = deriveAuditState(bundle, { emitStaleness: false });
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
  const updatedState = deriveAuditState(metadataBundle, {
    emitStaleness: false,
  });
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

/**
 * True when the next step derived from `bundle` is a deterministic, runner-backed
 * regen step that the drain loop may resolve in-process — i.e. it has a runner in
 * EXECUTOR_RUNNERS AND is NOT a host-delegation boundary. Host-delegation steps
 * (LLM review, intent/charter checkpoints, dispatch handoffs) always return
 * control to the host, so the drain stops before them. Chain-length/index-agnostic:
 * the decision is derived fresh from re-running decideNextStep + the staleness pass,
 * never from a fixed executor index.
 */
function nextStepIsDrainableRegen(bundle: ArtifactBundle): boolean {
  const decision = decideNextStep(bundle, { emitStaleness: false });
  const executor = decision.selected_executor;
  if (!executor) return false;
  if (!EXECUTOR_RUNNERS[executor]) return false;
  if (isHostDelegationExecutor(executor)) return false;
  return true;
}

/**
 * Advance the audit by draining the dependency-ordered regen cascade within ONE
 * host round-trip. Runs the first bounded step, then — for the normal
 * (non-forced) path — keeps running consecutive deterministic runner-backed steps
 * (re-deriving decideNextStep + computeStaleArtifacts each iteration) until the
 * next step is a host-delegation boundary, a no-runner handoff, or the run is
 * complete. A whole staleness cascade (e.g. a schema-version migration that
 * re-stales every downstream artifact) thus resolves in a single call and emits a
 * single consolidated staleness stderr record at the boundary — instead of one
 * host round-trip (and one record) per regenerated artifact.
 *
 * A forced `preferredExecutor` still runs EXACTLY ONE step: an explicit executor
 * request is a targeted single action, never a drain trigger.
 */
export async function advanceAudit(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions = {},
): Promise<AdvanceAuditResult> {
  const forced = Boolean(options.preferredExecutor);
  let result = await runSingleAdvanceStep(bundle, options);

  if (!forced) {
    // Drain the deterministic regen frontier. Each drained step re-derives the
    // decision + staleness from the accumulated bundle, so the loop is agnostic
    // to how long the chain is or where in the priority order it sits.
    let iterations = 0;
    while (
      result.progress_made &&
      iterations < MAX_DRAIN_STEPS &&
      nextStepIsDrainableRegen(result.updated_bundle)
    ) {
      const previousArtifacts = result.artifacts_written;
      const previousSummary = result.progress_summary;
      const next = await runSingleAdvanceStep(result.updated_bundle, options);
      // A drained step that made no progress (e.g. a no-runner handoff slipped
      // past the guard) must not loop forever — stop and keep the prior result's
      // forward view rather than overwriting it with a no-progress step.
      if (!next.progress_made) break;
      // Accumulate the artifacts + summaries so the single returned result
      // reflects EVERY artifact the drain wrote, deduplicated in first-seen order.
      next.artifacts_written = dedupeInOrder([
        ...previousArtifacts,
        ...next.artifacts_written,
      ]);
      next.progress_summary = `${previousSummary}\n${next.progress_summary}`;
      result = next;
      iterations += 1;
    }
  }

  // Single consolidated staleness record for the whole round-trip: recompute the
  // final stale set (pure, emit-off) from the returned bundle and emit exactly
  // once. Every intermediate derivation ran emit-off, so this is the only record.
  const finalStale = computeStaleArtifacts(result.updated_bundle, {
    emit: false,
  });
  emitStalenessRecord(
    finalStale,
    isMetadataMigrationStaleness(result.updated_bundle)
      ? "metadata_schema_version_migration"
      : undefined,
  );

  return result;
}

/** Deduplicate a string array preserving first-seen order. */
function dedupeInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
