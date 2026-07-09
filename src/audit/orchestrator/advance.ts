import { randomUUID } from "node:crypto";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import { decideNextStep, findObligation, PRIORITY } from "./nextStep.js";
import { deriveAuditState } from "./state.js";
import { computeArtifactMetadata } from "./artifactMetadata.js";
import { EXECUTOR_RUNNERS } from "./executorRunners.js";
import {
  nextStepIsDrainableRegen,
  type HostInputPauseInputs,
} from "./hostInputPause.js";
import {
  computeStaleArtifacts,
  emitStalenessRecord,
  isMetadataMigrationStaleness,
} from "./staleness.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  AGENT_FEEDBACK_FILENAME,
  RunLogger,
  advance as advanceObligations,
  type ObligationDef,
  type ObligationOutcome,
} from "audit-tools/shared";
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
 *
 * Kept as a LOCAL cap enforced from inside the drain obligations' `execute`
 * (see `runDrainStep` below) rather than threaded through the shared engine's
 * `advance(..., { maxTransitions })` — that option THROWS once exceeded, while
 * this cap has always been a graceful "stop and hand back the last good
 * result" backstop (the caller simply resumes the drain on its next
 * `next-step` call). Mirrors the CLI fold's (`nextStepHelpers.ts`) established
 * precedent of keeping cycle/step-count bookkeeping in the local `Ctx` rather
 * than in the engine's own transition counter.
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
 * Runner presence for the shared drainable-regen predicate: `advanceAudit` drains
 * only steps that have a deterministic runner in EXECUTOR_RUNNERS.
 */
function advanceHasRunner(executor: string): boolean {
  return Boolean(EXECUTOR_RUNNERS[executor]);
}

// ── Shared obligation-engine drain (replaces the hand-rolled while loop) ───────
//
// `PRIORITY` (single-sourced in nextStep.ts) is bound to the shared engine's
// `advance()` exactly as the CLI `next-step` fold already does
// (`src/audit/cli/nextStepHelpers.ts` → `runDeterministicForNextStep`, the
// proven engine consumer this mirrors): one `ObligationDef` per PRIORITY id,
// `derive` a plain state-only lookup off `deriveAuditState` (agnostic to
// executor kind / pause-worthiness — each layer keeps its own trivial copy of
// this lookup rather than sharing one across the cli/orchestrator boundary,
// matching the CLI fold's `deriveObligationState`), `execute` the SAME
// `runDrainStep` for every id (this layer's dispatch is fully homogeneous: it
// always re-decides via `decideNextStep` and runs whatever that selects,
// regardless of which def's `derive` made it actionable — the established
// precedent for this is `runDeterministicExecutor` in the CLI fold, which
// re-decides rather than trusting the closed-over id).
//
// The engine's own `advance(..., opts.maxTransitions)` throw-on-exceeded
// backstop is set explicitly to MAX_DRAIN_STEPS + 2 at the call site (never
// the engine default) so the coupling is self-maintaining: `runDrainStep`
// enforces the tighter graceful MAX_DRAIN_STEPS cap itself (see the constant's
// doc comment) and always stops the fold strictly before the engine's throwing
// counter could trip, no matter what value MAX_DRAIN_STEPS is raised to.
//
// Semantics preserved vs the hand-rolled loop (adversarially reviewed):
//   - zero-dispatch path (nothing actionable on entry): the reconstruction
//     branch in `advanceAudit` emits the SAME single {kind:"obligation"}
//     RunLogger event the old unconditional first `runSingleAdvanceStep`
//     emitted, so the event stream is unchanged;
//   - the graceful-vs-throwing cap coupling is explicit (above);
//   - the per-scan derivation cost is memoized back to one full
//     `deriveAuditState` per fold iteration (see `deriveObligationState`) —
//     pure memoization, not a behavior change.

/**
 * Per-call bookkeeping threaded to every drain obligation's `execute`. Mirrors
 * the CLI fold's `AuditNextStepCtx` refs pattern: mutable state the hand-rolled
 * `while` loop kept in closures (the running step-count, and the
 * artifacts/summary accumulators the loop merged after every iteration).
 */
interface DrainCtx {
  options: AdvanceAuditOptions;
  pauseInputs: HostInputPauseInputs;
  /** Total steps actually dispatched this `advanceAudit` call (bounds MAX_DRAIN_STEPS). */
  stepsRun: { value: number };
  /** First-seen-order-deduplicated artifact list accumulated across the whole drain. */
  artifactsAcc: { value: string[] };
  /** Each dispatched step's own `progress_summary`, joined with "\n" at merge time. */
  summaryAcc: { value: string[] };
}

type DrainObligation = ObligationDef<ArtifactBundle, DrainCtx, AdvanceAuditResult>;
type DrainOutcome = ObligationOutcome<ArtifactBundle, AdvanceAuditResult>;

/**
 * `derive` for one PRIORITY id: the same holistic `deriveAuditState` scan
 * `decideNextStep` runs, narrowed to this id's own missing/stale/satisfied
 * state. A pruned/absent obligation (e.g. `friction_capture_current`, which
 * `deriveAuditState` never emits — see `executorRunners.ts`) is satisfied, so
 * the scan can never select it — preserving today's "unreachable" behavior.
 *
 * MEMOIZED per bundle object identity: `findNextObligation` calls every def's
 * `derive` on the SAME bundle each scan (one scan per fold iteration), and
 * `deriveAuditState` runs the full `computeStaleArtifacts` content-hash pass —
 * without the cache each scan would recompute it |PRIORITY| times (~8-9x the
 * hand loop's per-iteration derivation count). The cache is a per-`advanceAudit`
 * -call `WeakMap` created in `advanceAudit` (never module-level, so a caller
 * that mutates a bundle in place between calls can never observe a stale
 * entry); bundle identity changes exactly at each `transition`
 * (`runSingleAdvanceStep` builds a fresh `finalizedBundle`), so the memo
 * yields exactly one derivation per scanned bundle. Pure memoization — WHAT is
 * derived is unchanged, and `deriveAuditState` itself is deterministic in the
 * bundle (no time/randomness inputs).
 */
function deriveObligationState(
  id: string,
  cache: WeakMap<ArtifactBundle, AuditState>,
): (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied" {
  return (bundle) => {
    if (bundle.audit_state?.status === "complete") return "satisfied";
    let state = cache.get(bundle);
    if (!state) {
      state = deriveAuditState(bundle, { emitStaleness: false });
      cache.set(bundle, state);
    }
    const found = state.obligations.find((o) => o.id === id);
    if (!found) return "satisfied";
    return found.state === "missing" || found.state === "stale"
      ? found.state
      : "satisfied";
  };
}

/**
 * Merge one step's outputs into the running drain accumulators — artifacts
 * deduplicated in first-seen order, summaries joined with "\n" — exactly
 * reproducing the hand loop's per-iteration merge, and return the merged
 * `AdvanceAuditResult`.
 */
function mergeDrainStep(
  result: AdvanceAuditResult,
  ctx: DrainCtx,
): AdvanceAuditResult {
  ctx.artifactsAcc.value = dedupeInOrder([
    ...ctx.artifactsAcc.value,
    ...result.artifacts_written,
  ]);
  ctx.summaryAcc.value.push(result.progress_summary);
  return {
    ...result,
    artifacts_written: ctx.artifactsAcc.value,
    progress_summary: ctx.summaryAcc.value.join("\n"),
  };
}

/**
 * Every PRIORITY id's `execute`: dispatch ONE bounded step (`runSingleAdvanceStep`
 * unconditionally re-decides + runs whatever `decideNextStep` selects from
 * `bundle` — the identical id the engine's scan just picked, by construction),
 * merge it into the drain accumulators, then decide `transition` (keep folding)
 * vs `emit` (hand back to the host) using the SAME single-sourced
 * `nextStepIsDrainableRegen` predicate the hand loop's `while` condition used —
 * so a host-input pause (registry-level or the graph-enrichment fold-level
 * cases) or a natural "nothing left" halts the fold exactly where it did
 * before. `!result.progress_made` (no obligation selected, or the selected one
 * has no deterministic runner — a host-delegation dispatch point like
 * `rolling_dispatch_executor`/`agent`) always emits immediately, mirroring the
 * hand loop's unconditional first call.
 */
async function runDrainStep(
  bundle: ArtifactBundle,
  ctx: DrainCtx,
): Promise<DrainOutcome> {
  const result = await runSingleAdvanceStep(bundle, ctx.options);
  const merged = mergeDrainStep(result, ctx);
  if (!result.progress_made) {
    return { kind: "emit", step: merged };
  }
  ctx.stepsRun.value += 1;
  if (ctx.stepsRun.value > MAX_DRAIN_STEPS) {
    // Belt-and-braces cap (see MAX_DRAIN_STEPS doc) — never trips on a healthy
    // run; stop gracefully and hand back the last good result rather than
    // throwing, so the host simply resumes the drain on its next call.
    return { kind: "emit", step: merged };
  }
  if (!nextStepIsDrainableRegen(result.updated_bundle, advanceHasRunner, ctx.pauseInputs)) {
    return { kind: "emit", step: merged };
  }
  return { kind: "transition", state: result.updated_bundle };
}

/**
 * One `ObligationDef` per PRIORITY id, all sharing `runDrainStep` (see above).
 * `cache` is the per-call derivation memo threaded into every `derive` — see
 * `deriveObligationState`.
 */
function buildDrainObligations(
  cache: WeakMap<ArtifactBundle, AuditState>,
): DrainObligation[] {
  return PRIORITY.map((id) => ({
    id,
    derive: deriveObligationState(id, cache),
    execute: runDrainStep,
  }));
}

/**
 * Advance the audit by ONE bounded step, then SAFELY DRAIN the deterministic
 * regen frontier within the SAME call: run the first bounded step, then keep
 * running consecutive deterministic runner-backed steps (re-deriving
 * decideNextStep + computeStaleArtifacts each iteration) until the next step is a
 * host-input pause, a no-runner handoff, or the run is complete. A whole staleness
 * cascade (e.g. a schema-version migration that re-stales every downstream
 * artifact) thus resolves in a single call and emits a single consolidated
 * staleness stderr record at the boundary — instead of one host round-trip (and
 * one record) per regenerated artifact.
 *
 * The drain is the DEFAULT (there is no opt-in flag). It is FOLD-AWARE: the stop
 * predicate is the single-sourced `nextStepPausesForHostInput` (via
 * `nextStepIsDrainableRegen`), consumed by BOTH this loop and the `next-step`
 * fold, so the drain halts at EVERY operator-interactive pause — including the
 * fold-level ones a registry-only `isHostDelegationExecutor` gate is blind to: the
 * analyzer-install consent fold and the low-confidence edge-reasoning fold (both
 * surfaced by the `graph_enrichment_executor`, which is registered deterministic).
 *
 * A forced `preferredExecutor` still runs EXACTLY ONE step: an explicit executor
 * request is a targeted single action, never a drain trigger — it bypasses the
 * shared engine entirely (the PRIORITY scan is irrelevant to a forced dispatch),
 * mirroring how the CLI fold's `runOmittableGate` handlers also dispatch a forced
 * executor directly rather than routing it through `advance()`.
 */
export async function advanceAudit(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions = {},
): Promise<AdvanceAuditResult> {
  const forced = Boolean(options.preferredExecutor);
  let result: AdvanceAuditResult;

  if (forced) {
    result = await runSingleAdvanceStep(bundle, options);
  } else {
    const ctx: DrainCtx = {
      options,
      pauseInputs: {
        root: options.root,
        analyzers: options.analyzers,
        graphLlmEdgeReasoning: options.graphLlmEdgeReasoning,
      },
      stepsRun: { value: 0 },
      artifactsAcc: { value: [] },
      summaryAcc: { value: [] },
    };
    // Per-call derivation memo (see deriveObligationState) — created fresh here
    // so no state can leak across advanceAudit calls.
    const deriveCache = new WeakMap<ArtifactBundle, AuditState>();
    const outcome = await advanceObligations(
      { priority: PRIORITY, obligations: buildDrainObligations(deriveCache) },
      bundle,
      ctx,
      // INVARIANT: the local graceful cap (MAX_DRAIN_STEPS, enforced inside
      // runDrainStep) must always fire strictly before the engine's THROWING
      // maxTransitions backstop. Deriving the engine bound from the same
      // constant (+2 headroom: the cap emits on the step whose stepsRun first
      // exceeds MAX_DRAIN_STEPS, so the engine sees at most MAX_DRAIN_STEPS
      // transitions) keeps the coupling self-maintaining — raising
      // MAX_DRAIN_STEPS can never silently convert the graceful stop into an
      // engine throw.
      { maxTransitions: MAX_DRAIN_STEPS + 2 },
    );
    if (outcome.step) {
      result = outcome.step;
    } else {
      // Every PRIORITY obligation was already satisfied on entry (e.g. a fully
      // complete bundle, or nothing missing/stale) — no `execute` ever ran, so
      // `outcome.state` is the untouched input `bundle`. Construct the SAME
      // "no actionable obligation" result `runSingleAdvanceStep`'s own
      // defensive branch returns for this case (mirrors the CLI fold's
      // post-`advance` terminal fallback in `runDeterministicForNextStep`) —
      // INCLUDING the one `{phase:"advance", kind:"obligation"}` log event the
      // old unconditional first `runSingleAdvanceStep` call emitted before its
      // `!selectedExecutor` early-return, so the RunLogger event stream is
      // unchanged on the zero-dispatch path.
      const log = options.runLogger ?? RunLogger.disabled();
      const correlationId = createCorrelationId();
      const decision = decideNextStep(outcome.state, { emitStaleness: false });
      log.event({
        phase: "advance",
        kind: "obligation",
        correlationId,
        obligation: decision.selected_obligation ?? undefined,
        note: decision.reason,
      });
      const state = cloneState(decision.state);
      state.last_executor =
        outcome.state.audit_state?.last_executor ?? state.last_executor;
      state.last_obligation =
        decision.selected_obligation ??
        outcome.state.audit_state?.last_obligation ??
        state.last_obligation;
      result = {
        audit_state: state,
        selected_obligation: decision.selected_obligation,
        selected_executor: decision.selected_executor,
        progress_made: false,
        artifacts_written: ["audit_state.json"],
        progress_summary: decision.reason,
        next_likely_step: null,
        updated_bundle: { ...outcome.state, audit_state: state },
      };
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
