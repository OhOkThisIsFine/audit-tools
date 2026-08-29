import { randomUUID } from "node:crypto";
import type { ArtifactBundle } from "../io/artifacts.js";
import type { AuditState } from "../types/auditState.js";
import { decideNextStep, findObligation, PRIORITY } from "./nextStep.js";
import { deriveAuditState } from "./state.js";
import { computeArtifactMetadata } from "./artifactMetadata.js";
import { EXECUTOR_RUNNERS } from "./executorRunners.js";
import { EXECUTOR_BY_OBLIGATION } from "./executors.js";
import {
  classifyObligationBranch,
  type ObligationPolicyInputs,
} from "./obligationPolicy.js";
import {
  computeStaleArtifacts,
  emitStalenessRecord,
  isMetadataMigrationStaleness,
  resetStalenessDedup,
} from "./staleness.js";
import { DEPENDENCY_SLICE_PROJECTIONS } from "./dependencySlices.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  AGENT_FEEDBACK_FILENAME,
  RunLogger,
  advance as advanceObligations,
  describeStoppedFold,
  deriveEngineBound,
  type ObligationDef,
  type ObligationOutcome,
} from "audit-tools/shared";
import type { AdvanceAuditOptions, AdvanceAuditResult } from "./advanceTypes.js";

export type { AdvanceAuditOptions, AdvanceAuditResult } from "./advanceTypes.js";

/**
 * The per-invocation pacing cap on the ONE audit drain. Its unit is CHARGED
 * OBLIGATION EXECUTIONS — every `execute` the shared engine dispatches spends
 * one, whether it is a deterministic executor dispatch or a policy body that
 * only transitions (CX-02 landing 5 superseded the older "dispatch slots"
 * reading: charging only dispatches let uncharged policy transitions spend
 * engine budget and invert the derived-bound ordering).
 *
 * The regen frontier is finite (each deterministic step satisfies at least one
 * obligation and no deterministic executor re-opens an upstream one), so the
 * fold terminates naturally at a host boundary / completion; this cap is
 * belt-and-braces pacing, never correctness — the fold suspends resumably at
 * it. Enforced by the engine's `maxExecutions` budget (spend-before-dispatch,
 * structured `stopped: "budget"`), with `engineMaxTransitions()` as the
 * derived outer backstop: transitions <= charged executions by construction,
 * so the backstop can never fire first.
 */
export const MAX_DRAIN_STEPS = 64;

/**
 * The engine bound, DERIVED from the graceful cap rather than written as a
 * literal at the call site. Raising `MAX_DRAIN_STEPS` therefore can never
 * silently move the fold past the bound — there is no second number to
 * remember to re-derive.
 *
 * The derivation itself (the headroom, and the rule that the bound is the cap
 * plus it) lives in the shared obligation engine, which owns the bounded-call
 * invariant for BOTH orchestrators. This function is the audit draw of that one
 * statement, not a second copy of it.
 */
export function engineMaxTransitions(cap: number = MAX_DRAIN_STEPS): number {
  return deriveEngineBound(cap);
}

// ── The PRIORITY-ordering guarantee (owned here, as a caller precondition) ────
//
// The staleness pass DEFERS a downstream whose edge from a stale-and-pending
// upstream is guarded by a dependency-slice projection: the decision is
// postponed until the upstream has actually re-derived and the per-edge slice
// compare can run. That deferral is only safe because of something the
// staleness pass does not control and deliberately does not police — the ORDER
// this module drains obligations in. The precondition is therefore stated,
// owned and tested HERE, on the caller side of that edge:
//
//   for every registered slice-projected edge, EVERY obligation that can
//   (re)write the upstream artifact is scheduled — and its artifact_metadata
//   persisted — strictly BEFORE the first obligation that can write the
//   downstream; and the drain re-derives obligation state after every step
//   (see deriveObligationState: the memo is keyed on bundle IDENTITY, which
//   changes at every transition), so a slice moved by the upstream's
//   re-derivation still fires the per-edge compare while the deferred set is
//   non-empty, rather than after the downstream has already been selected.

/**
 * Every PRIORITY obligation whose executor can (re)write an artifact that takes
 * part in a registered dependency-slice projection.
 *
 * DECLARED DATA, RECONCILED — not a general artifact→obligation map and not a
 * list anyone is asked to remember to update: `findPriorityOrderingViolations`
 * REPORTS a projection participant that has no entry here, so registering a new
 * slice-projected edge without declaring its producers is a loud failure rather
 * than a silent hole in the guarantee.
 */
const SLICE_PARTICIPANT_PRODUCERS: Readonly<Record<string, readonly string[]>> = {
  // Written by the extraction pass and again by the independent delta-miner.
  "charter_register.json": ["charter_extraction_current", "charter_delta_current"],
  "structure_decomposition.json": ["structure_decomposition_current"],
  "repo_manifest.json": ["repo_manifest"],
  // Written by the structure pass and again by graph enrichment.
  "graph_bundle.json": ["structure_artifacts", "graph_enrichment_current"],
};

export interface PriorityOrderingViolation {
  /** The slice-projected downstream artifact. */
  downstream: string;
  /** The upstream artifact whose edge into it is slice-projected. */
  upstream: string;
  reason: string;
}

/**
 * Check the ordering guarantee above against a priority order. Empty ⇒ the
 * guarantee holds. Defaults to the live `PRIORITY`; a caller may pass a
 * candidate order (which is how the guarantee is red-green validated: an order
 * that puts a downstream's obligation ahead of its slice-projected upstream's
 * must come back non-empty).
 */
export function findPriorityOrderingViolations(
  priority: readonly string[] = PRIORITY,
): PriorityOrderingViolation[] {
  const violations: PriorityOrderingViolation[] = [];
  const positions = (artifact: string): number[] | string => {
    const producers = SLICE_PARTICIPANT_PRODUCERS[artifact];
    if (!producers) {
      return `no producing obligation is declared for ${artifact} in SLICE_PARTICIPANT_PRODUCERS`;
    }
    const indexes: number[] = [];
    for (const producer of producers) {
      const index = priority.indexOf(producer);
      if (index < 0) {
        return `producing obligation "${producer}" of ${artifact} is absent from the priority order`;
      }
      indexes.push(index);
    }
    return indexes;
  };

  for (const [downstream, upstreams] of Object.entries(
    DEPENDENCY_SLICE_PROJECTIONS,
  )) {
    const downstreamPositions = positions(downstream);
    for (const upstream of Object.keys(upstreams ?? {})) {
      const upstreamPositions = positions(upstream);
      if (typeof downstreamPositions === "string") {
        violations.push({ downstream, upstream, reason: downstreamPositions });
        continue;
      }
      if (typeof upstreamPositions === "string") {
        violations.push({ downstream, upstream, reason: upstreamPositions });
        continue;
      }
      const lastUpstream = Math.max(...upstreamPositions);
      const firstDownstream = Math.min(...downstreamPositions);
      if (lastUpstream >= firstDownstream) {
        violations.push({
          downstream,
          upstream,
          reason: `the slice-projected upstream ${upstream} is regenerated at priority index ${lastUpstream}, at or after the downstream ${downstream} at index ${firstDownstream} — the deferred staleness decision would never fire before the downstream is selected`,
        });
      }
    }
  }
  return violations;
}

/**
 * Load-time enforcement, mirroring the executor-registry coverage assertion the
 * priority scan itself carries: a priority order that breaks the guarantee
 * throws loudly at import rather than silently under-staling a downstream at
 * runtime.
 */
function assertPriorityOrderingGuarantee(): void {
  const violations = findPriorityOrderingViolations();
  if (violations.length === 0) return;
  throw new Error(
    `PRIORITY ordering violates the dependency-slice deferral precondition:\n` +
      violations
        .map((v) => `  - ${v.downstream} <- ${v.upstream}: ${v.reason}`)
        .join("\n"),
  );
}

assertPriorityOrderingGuarantee();

function cloneState(state: AuditState): AuditState {
  return {
    ...state,
    blockers: [...(state.blockers ?? [])],
    obligations: state.obligations.map((obligation) => ({ ...obligation })),
  };
}

/**
 * The ONE {phase:"advance", kind:"obligation"} event. Both the dispatching path
 * and the zero-dispatch path emit exactly this shape, and they emit it from
 * here — a second hand-written copy is what let the two drift apart in the
 * first place.
 */
function logObligationSelection(
  log: RunLogger,
  correlationId: string,
  obligation: string | null,
  reason: string,
): void {
  log.event({
    phase: "advance",
    kind: "obligation",
    correlationId,
    obligation: obligation ?? undefined,
    note: reason,
  });
}

/**
 * The ONE construction of the zero-dispatch "no actionable obligation" result.
 *
 * Two independently-editable copies used to exist — the early return inside a
 * single bounded step and the post-engine reconstruction for a drain where no
 * `execute` ever ran. They were semantically equal by inspection only: nothing
 * made a field added to `AdvanceAuditResult` reach both. One constructor makes
 * the equality structural, so "both paths agree" is not a property anyone has
 * to re-verify.
 */
function noActionableObligationResult(params: {
  bundle: ArtifactBundle;
  decision: ReturnType<typeof decideNextStep>;
  selectedObligation: string | null;
  selectedExecutor: string | null;
}): AdvanceAuditResult {
  const { bundle, decision } = params;
  const state = cloneState(decision.state);
  state.last_executor = bundle.audit_state?.last_executor ?? state.last_executor;
  state.last_obligation =
    params.selectedObligation ??
    bundle.audit_state?.last_obligation ??
    state.last_obligation;
  return {
    audit_state: state,
    selected_obligation: params.selectedObligation,
    selected_executor: params.selectedExecutor,
    progress_made: false,
    artifacts_written: ["audit_state.json"],
    progress_summary: decision.reason,
    next_likely_step: null,
    updated_bundle: { ...bundle, audit_state: state },
  };
}

/**
 * The identity of the executor that ACTUALLY threw, carried ON the error.
 *
 * `advanceAudit` DRAINS — one call folds through successive obligations — so a
 * caller that re-derives the failing identity from its own pre-drain
 * `decideNextStep` selection names the drain's FIRST obligation no matter which
 * fold step failed. That misattribution is not hypothetical: a
 * `synthesis_executor` blowup was recorded against `runtime_validation_executor`
 * (which had already succeeded), and sent the investigation to the wrong file.
 * The fix is structural — the identity travels with the error instead of being
 * reconstructed by a caller that cannot know it.
 */
export class ExecutorFailure extends Error {
  /** The executor whose runner threw. */
  readonly executor: string;
  /** The obligation it was resolving (`forced:<executor>` for a forced dispatch). */
  readonly obligation: string | null;

  constructor(
    message: string,
    params: { executor: string; obligation: string | null; cause?: Error },
  ) {
    super(message, params.cause ? { cause: params.cause } : undefined);
    this.name = "ExecutorFailure";
    this.executor = params.executor;
    this.obligation = params.obligation;
  }
}

/**
 * Find the failing-executor identity on `error` or anywhere down its `cause`
 * chain. Chain-walking (rather than a bare `instanceof` on the outermost error)
 * so an intermediate wrapper added later cannot silently reinstate the
 * misattribution it replaced.
 */
export function findExecutorFailure(
  error: unknown,
): ExecutorFailure | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof ExecutorFailure) return current;
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

function formatExecutorFailure(
  selectedExecutor: string,
  selectedObligation: string | null,
  error: unknown,
): Error {
  const detail =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  return new ExecutorFailure(
    `advanceAudit ${selectedExecutor} failed while resolving ${selectedObligation ?? "the current obligation"}: ${detail}`,
    {
      executor: selectedExecutor,
      obligation: selectedObligation,
      ...(error instanceof Error ? { cause: error } : {}),
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
/**
 * au-4 (2026-08-05 friction): a long next-step derivation (>120s observed,
 * >300s on the 2026-08-06 re-test) emitted no progress signal, silently blowing
 * caller timeouts — same class as the silent stale-artifact re-extraction
 * entry. One bounded-interval stderr JSONL heartbeat per `advanceAudit` call
 * names the obligation currently executing, so any caller sees liveness.
 * Unref'd — never holds the process open.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface AdvanceHeartbeat {
  /** Update the phase label the next beat reports (the selected obligation). */
  setLabel: (label: string) => void;
  stop: () => void;
}

export function startAdvanceHeartbeat(
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): AdvanceHeartbeat {
  const startedAt = Date.now();
  // Closure-scoped label — one per heartbeat, so concurrent advanceAudit calls
  // (parallel tests, embedded callers) can never cross-talk through module state.
  let label = "derive";
  const timer = setInterval(() => {
    process.stderr.write(
      JSON.stringify({
        kind: "progress_heartbeat",
        phase: label,
        elapsed_ms: Date.now() - startedAt,
        ts: new Date().toISOString(),
      }) + "\n",
    );
  }, intervalMs);
  timer.unref?.();
  return {
    setLabel: (l) => {
      label = l;
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * Exported as the FORCED SINGLE-STEP primitive (CX-02): the unified `next-step`
 * fold dispatches exactly one bounded step per obligation execution through
 * this, and every submission-apply forces one executor through it. It never
 * drains, never locks, never persists — the caller owns hold and commit.
 */
export async function runSingleAdvanceStep(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions = {},
): Promise<AdvanceAuditResult> {
  const log = options.runLogger ?? RunLogger.disabled();
  const correlationId = createCorrelationId();
  const decision = decideNextStep(bundle, {
    emitStaleness: false,
  });
  const forcedExecutor = options.preferredExecutor ?? null;
  const selectedExecutor = forcedExecutor ?? decision.selected_executor;
  const selectedObligation = forcedExecutor
    ? `forced:${forcedExecutor}`
    : decision.selected_obligation;
  options.heartbeat?.setLabel(selectedObligation ?? "derive");

  logObligationSelection(log, correlationId, selectedObligation, decision.reason);

  if (!selectedExecutor) {
    return noActionableObligationResult({
      bundle,
      decision,
      selectedObligation,
      selectedExecutor,
    });
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
    // No deterministic runner. Host-delegation executors (including
    // `semantic_review_executor`) are routed through the host before
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
    const state = deriveAuditState(bundle, {
      emitStaleness: false,
    });
    state.last_executor = selectedExecutor;
    state.last_obligation = selectedObligation ?? undefined;
    return {
      audit_state: state,
      selected_obligation: selectedObligation,
      selected_executor: selectedExecutor,
      progress_made: false,
      artifacts_written: ["audit_state.json"],
      progress_summary: `Executor ${selectedExecutor} is selected and requires its bound host step.`,
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

// ── The PLAN DRAW over the one obligation registry (CX-02) ────────────────────
//
// `PRIORITY` (single-sourced in nextStep.ts) is bound to the shared engine's
// `advance()`: one `ObligationDef` per PRIORITY id, `derive` the memoized
// holistic lookup below, `execute` a CLASSIFY-then-dispatch step. This is the
// deterministic-only DRAW over the one registry — the policy that decides
// where the host boundary sits lives in `obligationPolicy.ts` and is shared
// verbatim with the full `next-step` fold's consuming bodies, so the two draws
// cannot disagree on WHERE the pipeline pauses.
//
// Under `plan` (and any bare unforced `advanceAudit`), a boundary is HALTED AT,
// never consumed: a pending lane submission, an owed operator offer, or a
// host-delegation executor stops the fold before any dispatch could run past
// it. Deterministic arms of hybrid obligations (the omit/assemble/settle
// paths) still run — the refuted alternative, a blanket halt at every bespoke
// id, would stop `plan` at boundaries that do not exist on the live branch.
//
// The pacing cap is the engine's own `maxExecutions` budget (see
// MAX_DRAIN_STEPS); the `engineMaxTransitions()` backstop is DERIVED from the
// same constant, so no second number exists to keep in step.

/**
 * Per-call bookkeeping threaded to every plan-draw obligation's `execute`:
 * the artifacts/summary accumulators the drain merges after every dispatch,
 * and the last merged result — which is both the mid-drain boundary payload
 * (output shape 1: the accumulated last deterministic result) and the budget
 * stop's resumable halt payload.
 */
interface DrainCtx {
  options: AdvanceAuditOptions;
  policyInputs: ObligationPolicyInputs;
  /** First-seen-order-deduplicated artifact list accumulated across the whole drain. */
  artifactsAcc: { value: string[] };
  /** Each dispatched step's own `progress_summary`, joined with "\n" at merge time. */
  summaryAcc: { value: string[] };
  /** The last merged dispatch result; null until the first dispatch lands. */
  lastMergedRef: { value: AdvanceAuditResult | null };
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
export function deriveObligationState(
  id: string,
  cache: WeakMap<ArtifactBundle, AuditState>,
): (bundle: ArtifactBundle) => "missing" | "stale" | "satisfied" {
  return (bundle) => {
    if (bundle.audit_state?.status === "complete") return "satisfied";
    let state = cache.get(bundle);
    if (!state) {
      // The memo is keyed on bundle IDENTITY, which changes at every transition
      // (`runSingleAdvanceStep` builds a fresh `finalizedBundle`) — and the gate can
      // only change via a promotion, which is itself a transition. So a cache entry
      // can never outlive the delta it was derived under.
      state = deriveAuditState(bundle, {
        emitStaleness: false,
      });
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
 * The "Executor <id> is selected and requires its bound host step." result —
 * the plan draw's ENTRY-at-a-boundary output (output shape 2). Byte-compatible
 * with the no-runner branch of `runSingleAdvanceStep`, which produces the same
 * shape for a boundary whose executor has no deterministic runner; this
 * constructor exists for the CORRECTED case — a boundary whose executor HAS a
 * runner (a hybrid's live host branch), where HEAD used to dispatch that
 * runner once before detecting the pause, and the classified draw halts
 * BEFORE the dispatch instead.
 */
function hostBoundaryHandoffResult(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions,
  selectedExecutor: string,
  selectedObligation: string,
  reason: string,
): AdvanceAuditResult {
  const log = options.runLogger ?? RunLogger.disabled();
  logObligationSelection(log, createCorrelationId(), selectedObligation, reason);
  const state = deriveAuditState(bundle, { emitStaleness: false });
  state.last_executor = selectedExecutor;
  state.last_obligation = selectedObligation;
  return {
    audit_state: state,
    selected_obligation: selectedObligation,
    selected_executor: selectedExecutor,
    progress_made: false,
    artifacts_written: ["audit_state.json"],
    progress_summary: `Executor ${selectedExecutor} is selected and requires its bound host step.`,
    next_likely_step: selectedObligation,
    updated_bundle: { ...bundle, audit_state: state },
  };
}

/**
 * One plan-draw step for the obligation the engine scan selected: classify the
 * boundary first, dispatch only a deterministic arm.
 *
 * - deterministic → ONE `runSingleAdvanceStep`, merged into the accumulators;
 *   `transition` on its in-memory `updated_bundle` (fresh identity by
 *   construction — the drain never reloads from disk).
 * - a boundary reached MID-drain → emit the accumulated last result (HEAD's
 *   pause-before-dispatch behavior, output shape 1).
 * - a boundary ENTERED at:
 *   - executor with no runner → dispatch once; `runSingleAdvanceStep`'s own
 *     no-runner branch produces output shape 2 with its unchanged log stream
 *     (nothing can run, so the dispatch is construction, not execution);
 *   - executor WITH a runner (a hybrid's live host branch, or a pending
 *     submission the plan must not consume) → the constructed shape-2 halt,
 *     with NO dispatch. HEAD ran the runner once here; the classified draw
 *     corrects that (recorded decision, CX-02 landing 4 latitude).
 */
async function runPlanDrawStep(
  id: string,
  bundle: ArtifactBundle,
  ctx: DrainCtx,
): Promise<DrainOutcome> {
  const branch = await classifyObligationBranch(
    id,
    bundle,
    ctx.policyInputs,
    advanceHasRunner,
  );
  if (branch.branch !== "deterministic") {
    if (ctx.lastMergedRef.value) {
      return { kind: "emit", step: ctx.lastMergedRef.value };
    }
    const executor = EXECUTOR_BY_OBLIGATION.get(id);
    if (executor && advanceHasRunner(executor.id)) {
      const halt = hostBoundaryHandoffResult(
        bundle,
        ctx.options,
        executor.id,
        id,
        branch.reason,
      );
      return { kind: "emit", step: mergeDrainStep(halt, ctx) };
    }
    const result = await runSingleAdvanceStep(bundle, ctx.options);
    return { kind: "emit", step: mergeDrainStep(result, ctx) };
  }
  const result = await runSingleAdvanceStep(bundle, ctx.options);
  const merged = mergeDrainStep(result, ctx);
  ctx.lastMergedRef.value = merged;
  if (!result.progress_made) {
    return { kind: "emit", step: merged };
  }
  return { kind: "transition", state: result.updated_bundle };
}

/**
 * One `ObligationDef` per PRIORITY id — the registry's membership and order
 * are DERIVED from `PRIORITY`, never a second hand-enumerated list, so an id
 * cannot be in the scan and absent from the registry (this derivation is what
 * dissolved the fold-array⇄PRIORITY sync tests). `cache` is the per-call
 * derivation memo threaded into every `derive` — see `deriveObligationState`.
 */
function buildPlanDrawObligations(
  cache: WeakMap<ArtifactBundle, AuditState>,
): DrainObligation[] {
  return PRIORITY.map((id) => ({
    id,
    derive: deriveObligationState(id, cache),
    execute: (bundle: ArtifactBundle, ctx: DrainCtx) =>
      runPlanDrawStep(id, bundle, ctx),
  }));
}

/**
 * The unforced PLAN DRAW over the ONE audit obligation registry (CX-02): drain
 * the deterministic frontier in memory — classify each engine-selected
 * obligation's host boundary first (`obligationPolicy.ts`), dispatch only
 * deterministic arms, and HALT at the first boundary that needs host work or
 * would consume or persist host input. A whole staleness cascade (e.g. a
 * schema-version migration that re-stales every downstream artifact) resolves
 * in one call with one consolidated staleness stderr record at the boundary.
 *
 * This is the deterministic-only draw `audit-code plan` runs (through the
 * locking `runAuditStep`) and the in-memory primitive tests drive bare. The
 * FULL `next-step` fold does NOT nest this: its driver runs the same engine
 * over the same registry with the consuming policy bodies, dispatching
 * `runSingleAdvanceStep` per obligation execution.
 *
 * A forced `preferredExecutor` still runs EXACTLY ONE step: an explicit
 * executor request is a targeted single action, never a drain trigger — it
 * bypasses the shared engine entirely (the PRIORITY scan is irrelevant to a
 * forced dispatch), which is the single-action contract every submission-apply
 * caller depends on.
 */
export async function advanceAudit(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions = {},
): Promise<AdvanceAuditResult> {
  // Liveness heartbeat for the WHOLE call (drain, executors, staleness recompute)
  // — see startAdvanceHeartbeat. Per-emit staleness dedupe also resets here so
  // dedupe scopes to ONE call (the observed spam was within single next-steps);
  // a later call re-reporting the same stale set still emits.
  resetStalenessDedup();
  const heartbeat = startAdvanceHeartbeat();
  try {
    return await advanceAuditInner(bundle, { ...options, heartbeat });
  } finally {
    heartbeat.stop();
  }
}

async function advanceAuditInner(
  bundle: ArtifactBundle,
  options: AdvanceAuditOptions,
): Promise<AdvanceAuditResult> {
  const forced = Boolean(options.preferredExecutor);
  let result: AdvanceAuditResult;

  if (forced) {
    result = await runSingleAdvanceStep(bundle, options);
  } else {
    const ctx: DrainCtx = {
      options,
      policyInputs: {
        root: options.root,
        analyzers: options.analyzers,
        graphLlmEdgeReasoning: options.graphLlmEdgeReasoning,
        externalAcquisitionEnabled: options.externalAcquisition?.enabled,
        analyzerConsent: options.externalAcquisition?.analyzerConsent,
        // The grant rides through TYPED (AnalyzerConsentTokenGrant): the pause
        // predicate reads its per-candidate scope, never a run-wide string.
        acquisitionConsentToken: options.externalAcquisition?.consentToken,
        narrativeEnabled: options.narrativeEnabled,
        submissionProbe: options.submissionProbe,
      },
      artifactsAcc: { value: [] },
      summaryAcc: { value: [] },
      lastMergedRef: { value: null },
    };
    // Per-call derivation memo (see deriveObligationState) — created fresh here
    // so no state can leak across advanceAudit calls.
    const deriveCache = new WeakMap<ArtifactBundle, AuditState>();
    const outcome = await advanceObligations(
      { priority: PRIORITY, obligations: buildPlanDrawObligations(deriveCache) },
      bundle,
      ctx,
      // INVARIANT: the graceful execution budget (maxExecutions, charged by the
      // engine spend-before-dispatch) must always fire strictly before the
      // maxTransitions backstop. The backstop is DERIVED from the same constant
      // (see engineMaxTransitions), never written as a literal here, and
      // transitions <= charged executions holds by construction — so raising
      // MAX_DRAIN_STEPS can never silently move the stop out to the coarser one.
      {
        maxTransitions: engineMaxTransitions(),
        maxExecutions: MAX_DRAIN_STEPS,
      },
    );
    if (outcome.step) {
      result = outcome.step;
    } else if (outcome.stopped === "budget" && ctx.lastMergedRef.value) {
      // The pacing cap: resumable, never non-convergence. The accumulated last
      // result is the halt payload — the same value the pre-CX-02 drain emitted
      // when its slot counter reached the cap.
      result = ctx.lastMergedRef.value;
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
      logObligationSelection(
        log,
        correlationId,
        decision.selected_obligation,
        decision.reason,
      );
      result = noActionableObligationResult({
        bundle: outcome.state,
        decision,
        selectedObligation: decision.selected_obligation,
        selectedExecutor: decision.selected_executor,
      });
      // A non-convergent stop reaches this same branch — no step, nothing
      // actionable — but it is NOT completion, and a summary reading like a
      // finished drain would describe a spinning fold as a healthy one.
      //
      // Reported through the summary and the run log rather than a new result
      // field: those two already have readers, and the drain's own
      // MAX_DRAIN_STEPS cap emits strictly before the engine bound (see the
      // INVARIANT above), so this branch is a backstop on a broken invariant,
      // not a state the host is expected to route on.
      // The description is built by the engine's own `describeStoppedFold`, not
      // here: four folds across the two draws can stop non-convergently, and
      // hand-rolling the cause at each is how they diverged. Returning null on a
      // converged outcome also makes the null-check itself the branch, so this
      // consumer cannot report a wedged fold as a finished one.
      const stalled = describeStoppedFold(outcome, { bound: engineMaxTransitions() });
      if (stalled) {
        log.event({
          kind: "error",
          note: "obligation_fold_did_not_converge",
          stopped: stalled.stopped,
          obligation: stalled.spinning,
        } as never);
        result = {
          ...result,
          progress_summary:
            `Obligation fold did not converge: it ${stalled.cause} ` +
            `(${stalled.spinning}). The drain's own dispatch cap should have ` +
            "stopped it first, so this is a backstop firing — re-run next-step to resume.",
        };
      }
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
