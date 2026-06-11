/**
 * Rolling engine paused-state management (N-S09).
 *
 * Owns the `waiting_for_provider` resumable paused state that the rolling
 * engine enters when the confirmed provider pool empties mid-run.
 *
 * Invariants enforced here:
 *   INV-S03 — settled Gate-0/Gate-1 exclusions are never re-offered on
 *              re-discovery. `filterNewProviders` strips them from every
 *              re-discovery pass; `SettledExclusionSet` is never mutated.
 *   CE-003/CE-205 — no indefinite stall. After `LIVELOCK_PAUSE_LIMIT`
 *              consecutive pauses with zero net new capacity the engine
 *              transitions to `terminal/livelock` and yields the stranded
 *              subtree to the consumer-provided terminal handler (N-CE301).
 *
 * This module is purely logic — zero runtime dependencies beyond Node
 * built-ins. The consumer wires the terminal action after receiving
 * `{ kind: 'terminal', reason: 'livelock' }`.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Top-level lifecycle state of the rolling dispatch engine.
 *
 * - `running`              — confirmed pool has capacity; dispatch proceeding.
 * - `waiting_for_provider` — confirmed pool emptied mid-run; engine is
 *                            explicitly paused and resumable.
 * - `terminal`             — engine is done (complete, livelock, or handed
 *                            off to the consumer terminal handler).
 */
export type RollingEngineLifecycleState =
  | { kind: "running" }
  | {
      kind: "waiting_for_provider";
      /** ISO timestamp when the engine entered the paused state. */
      paused_at: string;
      /** Number of consecutive pauses with no net new provider capacity. */
      pause_count: number;
      /** Node IDs that are stranded waiting for a provider. */
      stranded_node_ids: string[];
    }
  | {
      kind: "terminal";
      reason: "livelock" | "consumer_terminal" | "complete";
      stranded_node_ids: string[];
    };

/**
 * Opaque set of provider identifiers that a Gate-0/Gate-1 user has
 * explicitly excluded. Carried across re-discovery rounds; never cleared.
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
 * Guarantees that re-discovery never re-offers a Gate-0/Gate-1 settled
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
 *   2. If `genuinelyNew.length > 0` → return `{ kind: 'running' }`.
 *   3. Else increment `pause_count` and call `checkLivelockGuard`.
 *      a. Livelock triggered → return `{ kind: 'terminal', reason: 'livelock', ... }`.
 *      b. Below limit → return updated `waiting_for_provider` with bumped
 *         `pause_count`; `paused_at` and `stranded_node_ids` are preserved.
 *
 * This function never mutates its inputs.
 */
export function advancePausedState(
  opts: AdvancePausedStateOptions,
): RollingEngineLifecycleState {
  const { current, rediscoveredProviders, settledExclusions, livelockLimit } = opts;

  const genuinelyNew = filterNewProviders(rediscoveredProviders, settledExclusions);

  // New capacity arrived — transition back to running.
  if (genuinelyNew.length > 0) {
    return { kind: "running" };
  }

  // No new capacity — increment pause count and check for livelock.
  const nextPauseCount = current.pause_count + 1;
  const livelock = checkLivelockGuard(nextPauseCount, 0, livelockLimit);

  if (livelock) {
    return {
      kind: "terminal",
      reason: "livelock",
      stranded_node_ids: current.stranded_node_ids,
    };
  }

  // Still waiting — bump pause count, preserve everything else.
  return {
    kind: "waiting_for_provider",
    paused_at: current.paused_at,
    pause_count: nextPauseCount,
    stranded_node_ids: current.stranded_node_ids,
  };
}
