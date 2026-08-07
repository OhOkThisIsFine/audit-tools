/**
 * Rolling engine paused-state management (N-S09).
 *
 * Owns the `waiting_for_provider` resumable paused state that the rolling
 * engine enters when every eligible dispatch pool empties mid-run.
 *
 * Invariants enforced here:
 *   INV-S03 — settled dispatch-pool exclusions are never re-offered on
 *              re-discovery. `filterNewProviders` strips them from every
 *              re-discovery pass; `SettledExclusionSet` is never mutated.
 *   CE-003/CE-205 — no indefinite stall. After `LIVELOCK_PAUSE_LIMIT`
 *              consecutive pauses with zero net new capacity the engine
 *              transitions to `terminal/livelock` and yields the stranded
 *              subtree to the consumer-provided terminal handler (N-CE301).
 *   CP-NODE-3(a) — every transition OUT of `waiting_for_provider` (resume to
 *              `running`, or promotion to `terminal`) carries an EXPLICIT
 *              `clear_persisted_state: true` directive, rather than leaving
 *              the caller to infer "must clear" from `kind` alone. The
 *              consumer that derives `dispatch_capacity` from the mere
 *              PRESENCE of a persisted paused_state
 *              (audit-orchestrator-core, `src/audit/orchestrator/state.ts`)
 *              has no actionable obligation to clear it on its own, so an
 *              un-cleared paused_state would report top-level status
 *              "blocked" forever once capacity actually returns. This
 *              module PRODUCES the directive only, as a returned value —
 *              never as a filesystem write; the consumer (CP-NODE-6, the
 *              active-dispatch-state writer) owns applying it.
 *   CP-NODE-3(b) — `classifyProviderConstructionAttempt` classifies a
 *              SYNCHRONOUS provider-construction throw (a permanently
 *              misconfigured provider — missing required config, unknown
 *              provider name) as a TERMINAL configuration failure, never a
 *              retryable pause: incrementing `pause_count` or re-entering
 *              re-discovery on a construction failure would only busy-loop
 *              the same broken config. It classifies via the structured,
 *              non-retryable `ProviderLaunchOutcomeEnvelope`
 *              (`outcome: "construction_failed"`) that provider construction
 *              now throws — see `../providers/providerFactory.js`.
 *
 * This module is purely logic — zero runtime dependencies beyond Node
 * built-ins (the `ProviderLaunchOutcomeEnvelope` reference below is a
 * type-only import, erased at compile time — it adds no runtime dependency
 * on the providers layer). The consumer wires the terminal action after
 * receiving `{ kind: 'terminal', reason: 'livelock' | 'configuration', ... }`.
 */

import type { ProviderLaunchOutcomeEnvelope } from "../providers/providerFactory.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Top-level lifecycle state of the rolling dispatch engine.
 *
 * - `running`              — an eligible pool has capacity; dispatch proceeding.
 * - `waiting_for_provider` — all eligible pools emptied mid-run; engine is
 *                            explicitly paused and resumable.
 * - `terminal`             — engine is done (complete, livelock, or handed
 *                            off to the consumer terminal handler).
 */
export type RollingEngineLifecycleState =
  | {
      kind: "running";
      /**
       * CP-NODE-3(a): explicit directive — a persisted paused_state record
       * (if any) MUST be cleared. Always `true` on this variant; see the
       * module doc comment for why this must be explicit rather than
       * inferred from `kind`.
       */
      clear_persisted_state: true;
    }
  | {
      kind: "waiting_for_provider";
      /** ISO timestamp when the engine entered the paused state. */
      paused_at: string;
      /** Number of consecutive pauses with no net new provider capacity. */
      pause_count: number;
      /** Node IDs that are stranded waiting for a provider. */
      stranded_node_ids: string[];
      /**
       * CP-NODE-3(a): explicit directive companion. Never `true` on this
       * variant — the engine is still paused, so any persisted paused_state
       * record must be KEPT (updated with the new lifecycle), not cleared.
       * Optional (rather than required) so external constructors of this
       * persisted shape (the active-dispatch-state writer) that predate the
       * directive keep typechecking unchanged; this module always sets it
       * explicitly to `false` on every value it produces.
       */
      clear_persisted_state?: false;
    }
  | {
      kind: "terminal";
      reason: "livelock" | "consumer_terminal" | "complete" | "configuration";
      stranded_node_ids: string[];
      /**
       * CP-NODE-3(a): explicit directive — a persisted paused_state record
       * (if any) MUST be cleared; the run has left the resumable-pause cycle
       * entirely (livelock, consumer terminal, completion, or a
       * non-retryable configuration failure). Always `true` on this variant.
       */
      clear_persisted_state: true;
    };

/**
 * Opaque set of provider identifiers already settled by dispatch. Carried across
 * re-discovery rounds; never cleared.
 *
 * Use a `ReadonlySet<string>` so callers cannot accidentally mutate it.
 */
export type SettledExclusionSet = ReadonlySet<string>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default number of consecutive `waiting_for_provider` pauses (with zero net
 * new capacity) after which the engine transitions to `terminal/livelock`.
 */
export const LIVELOCK_PAUSE_LIMIT = 3;

// ---------------------------------------------------------------------------
// filterNewProviders
// ---------------------------------------------------------------------------

/**
 * Pure function: return only providers not present in `settled`.
 *
 * Guarantees that re-discovery never re-offers a settled
 * exclusion (INV-S03). The `settled` set is never mutated.
 *
 * @param discovered  Provider identifiers returned by the latest re-discovery pass.
 * @param settled     The accumulated exclusion set; immutable.
 * @returns           Only those identifiers not already in `settled`.
 */
export function filterNewProviders(
  discovered: string[],
  settled: SettledExclusionSet,
): string[] {
  return discovered.filter((id) => !settled.has(id));
}

// ---------------------------------------------------------------------------
// checkLivelockGuard
// ---------------------------------------------------------------------------

/**
 * Pure predicate: returns `true` when the no-progress livelock condition is met.
 *
 * Livelock is triggered when:
 *   - `pauseCount >= limit` (at or beyond the configured threshold), AND
 *   - `netNewCapacity === 0`  (no genuinely-new providers arrived this round).
 *
 * @param pauseCount      Number of consecutive pauses recorded so far (inclusive of the current one).
 * @param netNewCapacity  Count of genuinely-new providers surfaced this round.
 * @param limit           Pause threshold; defaults to `LIVELOCK_PAUSE_LIMIT`.
 */
export function checkLivelockGuard(
  pauseCount: number,
  netNewCapacity: number,
  limit: number = LIVELOCK_PAUSE_LIMIT,
): boolean {
  return pauseCount >= limit && netNewCapacity === 0;
}

// ---------------------------------------------------------------------------
// advancePausedState
// ---------------------------------------------------------------------------

/**
 * Options for `advancePausedState`.
 */
export interface AdvancePausedStateOptions {
  /** The current `waiting_for_provider` state. */
  current: Extract<RollingEngineLifecycleState, { kind: "waiting_for_provider" }>;
  /** Provider identifiers returned by the latest re-discovery probe. */
  rediscoveredProviders: string[];
  /** The accumulated settled-exclusion set (not mutated). */
  settledExclusions: SettledExclusionSet;
  /** Override for the livelock limit; defaults to `LIVELOCK_PAUSE_LIMIT`. */
  livelockLimit?: number;
}

/**
 * Single transition function for the `waiting_for_provider` paused state.
 *
 * Decision tree:
 *   1. Call `filterNewProviders` to surface only genuinely-new providers
 *      (strips settled exclusions — INV-S03).
 *   2. If `genuinelyNew.length > 0` → return `{ kind: 'running',
 *      clear_persisted_state: true }` (CP-NODE-3(a): resume always carries
 *      the explicit clear directive).
 *   3. Else increment `pause_count` and call `checkLivelockGuard`.
 *      a. Livelock triggered → return `{ kind: 'terminal', reason:
 *         'livelock', clear_persisted_state: true, ... }` (terminal
 *         promotion always carries the explicit clear directive).
 *      b. Below limit → return updated `waiting_for_provider` with bumped
 *         `pause_count` and `clear_persisted_state: false`; `paused_at` and
 *         `stranded_node_ids` are preserved.
 *
 * This function never mutates its inputs.
 */
export function advancePausedState(
  opts: AdvancePausedStateOptions,
): RollingEngineLifecycleState {
  const { current, rediscoveredProviders, settledExclusions, livelockLimit } = opts;

  const genuinelyNew = filterNewProviders(rediscoveredProviders, settledExclusions);

  // New capacity arrived — transition back to running. Resume always carries
  // the explicit clear-persisted-state directive (CP-NODE-3(a)).
  if (genuinelyNew.length > 0) {
    return { kind: "running", clear_persisted_state: true };
  }

  // No new capacity — increment pause count and check for livelock.
  const nextPauseCount = current.pause_count + 1;
  const livelock = checkLivelockGuard(nextPauseCount, 0, livelockLimit);

  if (livelock) {
    // Terminal promotion always carries the explicit clear directive
    // (CP-NODE-3(a)) — the run has left the resumable-pause cycle.
    return {
      kind: "terminal",
      reason: "livelock",
      stranded_node_ids: current.stranded_node_ids,
      clear_persisted_state: true,
    };
  }

  // Still waiting — bump pause count, preserve everything else. A
  // continued-pause transition never carries the clear directive
  // (CP-NODE-3(a)): the persisted record must be KEPT, not cleared.
  return {
    kind: "waiting_for_provider",
    paused_at: current.paused_at,
    pause_count: nextPauseCount,
    stranded_node_ids: current.stranded_node_ids,
    clear_persisted_state: false,
  };
}

// ---------------------------------------------------------------------------
// classifyProviderConstructionAttempt
// ---------------------------------------------------------------------------

/**
 * Classify a SYNCHRONOUS provider-construction attempt (CP-NODE-3(b)).
 *
 * Invokes `attemptConstruction` exactly once. A clean return means
 * construction succeeded — returns `null`, and the caller proceeds with the
 * ordinary `advancePausedState` pause/resume decision unchanged.
 *
 * A throw carrying CP-NODE-4's structured `ProviderLaunchOutcomeEnvelope`
 * (`.launchOutcome.outcome === "construction_failed"`, e.g. from
 * `ProviderConstructionError` — see `../providers/providerFactory.js`) is
 * classified here as a TERMINAL configuration failure and returned directly,
 * WITHOUT touching `pause_count` or re-discovery: this function takes no
 * `current` paused state and never calls `filterNewProviders` /
 * `checkLivelockGuard`, so a construction failure can never increment a
 * pause count or re-enter re-discovery, whether or not a pause was already
 * in progress. A permanently misconfigured provider (missing required
 * config, unrecognized provider name) cannot be fixed by waiting or
 * re-discovering — routing it through the ordinary retryable pause path
 * would only busy-loop the same broken config forever.
 *
 * A throw that does NOT carry a construction-failure envelope (an
 * unclassifiable error, or no `.launchOutcome` at all) propagates UNCHANGED
 * — this function only special-cases a positively-identified construction
 * failure; it never swallows an error it cannot classify.
 *
 * Still I/O-free: `attemptConstruction` is caller-injected (the actual
 * provider-construction call lives in the providers layer), so this module
 * gains no new runtime dependency — it only inspects the SHAPE of what
 * `attemptConstruction` throws.
 *
 * @param attemptConstruction  Zero-arg callback that performs (or simulates,
 *   in tests) a synchronous provider-construction attempt.
 * @param strandedNodeIds      Node IDs to carry onto the terminal state when
 *   classified as a construction failure.
 * @returns The terminal configuration-failure state, or `null` when
 *   construction succeeded (not a construction failure).
 */
export function classifyProviderConstructionAttempt(
  attemptConstruction: () => void,
  strandedNodeIds: string[],
): RollingEngineLifecycleState | null {
  try {
    attemptConstruction();
    return null;
  } catch (err) {
    const envelope = (err as { launchOutcome?: ProviderLaunchOutcomeEnvelope } | null | undefined)
      ?.launchOutcome;
    if (envelope?.outcome !== "construction_failed") {
      // Not a classifiable construction failure — do not swallow it.
      throw err;
    }
    return {
      kind: "terminal",
      reason: "configuration",
      stranded_node_ids: [...strandedNodeIds],
      clear_persisted_state: true,
    };
  }
}
