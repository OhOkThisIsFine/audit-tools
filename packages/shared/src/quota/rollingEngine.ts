/**
 * Rolling engine — provider-pool-change semantics (drop + re-route).
 *
 * Manages a mutable active provider pool across a dispatch run. When a provider
 * signals quota exhaustion or disappears, the engine drops it from the active
 * routing set, re-queues any in-flight packets that had been assigned to it, and
 * re-routes those packets to the remaining active providers.
 *
 * NOTE: The empty-pool terminal (active_pools reaches zero → waiting_for_provider)
 * is NOT handled here — that is N-S09's responsibility. When dropProvider is
 * called on the last active pool it returns a state with active_pools: [] and
 * the caller's engine loop detects and handles the empty-pool condition.
 */

import type { SessionConfig } from "../types/sessionConfig.js";
import type { CapacityPool, PartialCompletionTerminal } from "./capacity.js";
import type { FreshSessionProvider } from "../providers/types.js";
import { computeDispatchCapacity, buildEmptyPoolTerminal } from "./capacity.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Reason a provider was removed from the active pool. */
export type ProviderPoolEventKind = "exhausted" | "unavailable";

/**
 * A recorded pool-change event: a provider was removed from active routing.
 * - `exhausted`: quota/rate-limit exhaustion (detectRateLimitError returned a hit).
 * - `unavailable`: spawn failed with a non-retryable error.
 */
export interface ProviderPoolEvent {
  kind: ProviderPoolEventKind;
  provider_id: string;
  timestamp: string;
  in_flight_count: number;
  requeued_count: number;
}

/**
 * An active pool entry: the capacity descriptor plus its provider instance.
 */
export interface RollingEnginePoolEntry {
  pool: CapacityPool;
  provider: FreshSessionProvider;
}

/**
 * Input to the rolling engine: the set of pools available at dispatch start.
 */
export type RollingEnginePool = RollingEnginePoolEntry[];

/**
 * A packet token tracked by the rolling engine.
 * The engine is payload-agnostic; only the id and pool assignment matter here.
 */
export interface EnginePacketToken {
  /** Stable unique id for this packet. */
  id: string;
  /** The pool_id this packet was assigned to (in-flight or pending). */
  assigned_pool_id: string;
  /** Estimated input tokens for this packet. */
  estimated_tokens: number;
}

/**
 * Mutable state managed by the rolling engine.
 *
 * - `active_pools`: providers currently eligible for dispatch.
 * - `exhausted_pools`: providers removed due to quota/unavailability.
 * - `in_flight_tokens`: packets currently dispatched and awaiting a result.
 * - `pending_tokens`: packets queued but not yet dispatched (includes requeued).
 * - `event_log`: ordered record of pool-change events.
 */
export interface RollingEnginePoolState {
  active_pools: RollingEnginePoolEntry[];
  exhausted_pools: RollingEnginePoolEntry[];
  in_flight_tokens: EnginePacketToken[];
  pending_tokens: EnginePacketToken[];
  event_log: ProviderPoolEvent[];
}

// ---------------------------------------------------------------------------
// dropProvider
// ---------------------------------------------------------------------------

/**
 * Pure function: remove a provider from the active routing set.
 *
 * Given the current engine state and a pool_id to drop:
 * 1. Moves the named pool from `active_pools` to `exhausted_pools`.
 * 2. Identifies all in-flight packets assigned to the dropped pool.
 * 3. Removes those packets from `in_flight_tokens`.
 * 4. Appends those packets to `pending_tokens` (re-queued for re-routing).
 * 5. Appends a `ProviderPoolEvent` to `event_log`.
 *
 * Returns a new `RollingEnginePoolState` — the input state is never mutated.
 *
 * When `active_pools` is already empty or the pool_id is not found in
 * `active_pools`, the state is returned unchanged (idempotent).
 *
 * When this call reduces `active_pools` to `[]`, the caller (N-S09's engine
 * loop) is responsible for detecting the empty-pool condition.
 */
export function dropProvider(
  state: RollingEnginePoolState,
  pool_id: string,
  kind: ProviderPoolEventKind,
): RollingEnginePoolState {
  const poolIndex = state.active_pools.findIndex((e) => e.pool.id === pool_id);
  if (poolIndex === -1) {
    // Pool not in active set — idempotent, return unchanged.
    return state;
  }

  const dropped = state.active_pools[poolIndex]!;

  // Identify in-flight packets assigned to the dropped pool.
  const requeued = state.in_flight_tokens.filter(
    (t) => t.assigned_pool_id === pool_id,
  );
  const stillInFlight = state.in_flight_tokens.filter(
    (t) => t.assigned_pool_id !== pool_id,
  );

  const event: ProviderPoolEvent = {
    kind,
    provider_id: pool_id,
    timestamp: new Date().toISOString(),
    in_flight_count: requeued.length,
    requeued_count: requeued.length,
  };

  // Structured observability for pool drops/rerouting (OBS-d81a55ab). Emitted on
  // its own line and wrapped so a logging failure can never abort a dispatch run.
  try {
    process.stderr.write(
      JSON.stringify({
        ts: event.timestamp,
        kind: "rolling_engine_drop_provider",
        provider_id: pool_id,
        drop_kind: kind,
        in_flight_count: event.in_flight_count,
        requeued_count: event.requeued_count,
      }) + "\n",
    );
  } catch {
    // Observability must never abort a run.
  }

  return {
    active_pools: [
      ...state.active_pools.slice(0, poolIndex),
      ...state.active_pools.slice(poolIndex + 1),
    ],
    exhausted_pools: [...state.exhausted_pools, dropped],
    in_flight_tokens: stillInFlight,
    pending_tokens: [...state.pending_tokens, ...requeued],
    event_log: [...state.event_log, event],
  };
}

// ---------------------------------------------------------------------------
// reroutePackets
// ---------------------------------------------------------------------------

/** Result of {@link reroutePackets}. */
export interface ReroutePacketsResult {
  state: RollingEnginePoolState;
  /** Dispatch allocation computed over the surviving active pools, or null. */
  allocation: ReturnType<typeof computeDispatchCapacity> | null;
  /**
   * Set when surplus pending packets could not be reassigned to any surviving
   * active pool — either because no active pool remains, or because pending
   * demand exceeds the survivors' combined slot capacity. The stranded packet
   * ids are surfaced here (and removed from `state.pending_tokens`) so the
   * caller routes them through its consumer-specific terminal handler. `null`
   * when every pending packet found a surviving active pool. (INV-QD-13)
   */
  terminal: PartialCompletionTerminal | null;
}

/**
 * Re-route pending packet tokens across the remaining active pools.
 *
 * The no-stranding guarantee (INV-QD-13 / SEAM-rolling-stranding): after ANY
 * `dropProvider` — including simultaneous multi-pool drops where pending demand
 * exceeds the survivors' slot capacity — this function leaves ZERO
 * `pending_tokens` whose `assigned_pool_id` points at a dropped/exhausted (i.e.
 * non-active) pool. Every pending packet is either reassigned to a pool still in
 * `active_pools`, or removed from `pending_tokens` and surfaced in
 * `terminal.stranded_ids`. `reroutePackets` is the SINGLE owner of this
 * guarantee; consumers (audit-cli-commands, remediate-steps-dispatch) only
 * consume `stranded_ids` and never implement their own reroute.
 *
 * Behaviour:
 * - No pending tokens → state unchanged, `allocation` and `terminal` null.
 * - `active_pools` empty but pending tokens exist → every pending packet is
 *   stranded (state pending cleared) and an `empty_pool` terminal is returned.
 * - Otherwise → `computeDispatchCapacity` sizes the surviving pools; the largest
 *   pending packets are assigned to the surviving pools up to their slot counts,
 *   and any surplus that does not fit is stranded.
 *
 * Also returns the `DispatchCapacity` computed by `computeDispatchCapacity` so
 * callers can inspect the allocation without re-computing it.
 */
export function reroutePackets(
  state: RollingEnginePoolState,
  sessionConfig: SessionConfig,
): ReroutePacketsResult {
  if (state.pending_tokens.length === 0) {
    return { state, allocation: null, terminal: null };
  }

  // No surviving pool: every pending packet is stranded. Clearing pending here
  // is what guarantees ZERO pending_tokens remain pointed at a dead pool.
  if (state.active_pools.length === 0) {
    const strandedIds = state.pending_tokens.map((t) => t.id);
    return {
      state: { ...state, pending_tokens: [] },
      allocation: null,
      terminal: buildEmptyPoolTerminal(strandedIds),
    };
  }

  const pendingItemTokens = state.pending_tokens.map((t) => t.estimated_tokens);
  const pools = state.active_pools.map((e) => e.pool);
  const activePoolIds = new Set(pools.map((p) => p.id));

  const allocation = computeDispatchCapacity({ pools, sessionConfig, pendingItemTokens });

  // Order pending packets largest-first so the survivors' slots carry the most
  // expensive work, mirroring computeDispatchCapacity's own descending layout.
  const ordered = [...state.pending_tokens].sort(
    (a, b) => b.estimated_tokens - a.estimated_tokens,
  );

  // Re-assign pending tokens to surviving pools based on slot counts.
  const reassigned: EnginePacketToken[] = [];
  let tokenCursor = 0;

  for (const poolAlloc of allocation.pools) {
    // Defensive: never assign to a pool that is not in the active set.
    if (!activePoolIds.has(poolAlloc.pool_id)) continue;
    const assignCount = Math.min(poolAlloc.slots, ordered.length - tokenCursor);
    for (let i = 0; i < assignCount; i++) {
      const original = ordered[tokenCursor + i]!;
      reassigned.push({ ...original, assigned_pool_id: poolAlloc.pool_id });
    }
    tokenCursor += assignCount;
    if (tokenCursor >= ordered.length) break;
  }

  // Any packet beyond the survivors' combined slot capacity cannot be placed on
  // an active pool. It MUST NOT stay assigned to a dropped/exhausted pool — it is
  // removed from pending_tokens and surfaced as stranded (INV-QD-13).
  const stranded = ordered.slice(tokenCursor);
  const terminal =
    stranded.length > 0
      ? buildEmptyPoolTerminal(stranded.map((t) => t.id))
      : null;

  return {
    state: { ...state, pending_tokens: reassigned },
    allocation,
    terminal,
  };
}
