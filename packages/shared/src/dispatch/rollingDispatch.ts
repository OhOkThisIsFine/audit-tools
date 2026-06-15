/**
 * Rolling dispatch engine — packet-type-agnostic.
 *
 * Key design invariants:
 * - No max_concurrent in the public API; quota headroom from `scheduleWave` is the
 *   sole throttle (INV-S05 / INV-QD-11). `InFlightTokenTracker` is the sole source
 *   of in-flight token accounting; no external concurrency cap is honoured unless
 *   `options.maxConcurrentPerPool` is explicitly passed.
 * - TPacket is fully opaque; the engine never inspects packet payload.
 * - Terminal hooks (synthesis, ingestion) are NOT inline — consumers supply an
 *   `onResult` callback and own any terminal logic after `run()` returns.
 * - `recordWaveOutcome` requires `setQuotaStateDir()` to be called before
 *   `run()` (existing shared quota contract).
 * - Transient-exhaustion recovery (INV-QD-07 / ARC-d81a55ab): a `rate_limited`
 *   result records a `rate_limited` quota outcome (backoff + cooldown), drops the
 *   exhausted pool from the active routing set, and RE-QUEUES the packet so the
 *   next pass re-selects a pool still within headroom — a transient 429 never
 *   permanently strands a packet. Only when NO active pool survives does the
 *   engine stop and surface a `PartialCompletionTerminal{reason:'empty_pool',
 *   stranded_ids}` (read via `getTerminal()`); the consumer routes the stranded
 *   ids (audit → synthesis/uncovered, remediate → blocked → close). Dispatch
 *   callbacks always resolve, never reject.
 */

import type { SessionConfig } from "../types/sessionConfig.js";
import type { CapacityPool, PartialCompletionTerminal } from "../quota/capacity.js";
import type { QuotaStateEntry, QuotaState } from "../quota/types.js";
import {
  scheduleWave,
  buildProviderModelKey,
  DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
} from "../quota/scheduler.js";
import { recordWaveOutcome, readQuotaState } from "../quota/state.js";
import { buildEmptyPoolTerminal } from "../quota/capacity.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A dispatchable unit of work. TPacket is opaque to the engine. */
export interface RollingDispatchPacket<TPacket> {
  /** Stable, unique identifier for this packet within a run. */
  id: string;
  /** Consumer-defined payload — never inspected by the engine. */
  payload: TPacket;
  /**
   * Estimated token cost (input tokens) for this packet.
   * Used for quota headroom checks; over-estimates are safe.
   */
  estimatedTokens: number;
  /**
   * Complexity score in [0, 1].
   * 1 = highest complexity — routed to the most-capable pool first.
   * 0 = lowest complexity — routed to the least-capable pool first.
   */
  complexity: number;
}

/** Outcome of dispatching a single packet. */
export interface RollingDispatchResult<TPacket> {
  packet: RollingDispatchPacket<TPacket>;
  outcome: "success" | "rate_limited" | "timeout" | "error";
  /** Actual tokens consumed, if the provider reports it. */
  actualTokens?: number;
  error?: unknown;
}

/** Identity of the provider/model pool selected for a dispatch. */
export interface ProviderSlot {
  providerName: string;
  hostModel: string | null;
  poolId: string;
}

/** In-flight tracking entry for a dispatched packet. */
export interface InFlightEntry<TPacket> {
  slotId: string;
  packet: RollingDispatchPacket<TPacket>;
  providerSlot: ProviderSlot;
  startedAt: number;
  estimatedTokens: number;
  promise: Promise<RollingDispatchResult<TPacket>>;
}

/** Mutable state of the rolling dispatcher. */
export interface RollingDispatchState<TPacket> {
  pendingQueue: RollingDispatchPacket<TPacket>[];
  inFlight: Map<string, InFlightEntry<TPacket>>;
  completedIds: Set<string>;
  /**
   * Pool ids dropped from the active routing set after a `rate_limited`/
   * exhaustion result. Monotonic within a run — a pool is never re-added — which
   * is what bounds the transient-429 re-queue loop (every retry either succeeds
   * elsewhere or shrinks the active set toward empty).
   */
  exhaustedPoolIds: Set<string>;
  /**
   * Packet ids that could not be dispatched because every pool was exhausted.
   * Surfaced via {@link RollingDispatcher.getTerminal} as an `empty_pool`
   * PartialCompletionTerminal (INV-QD-07).
   */
  strandedIds: Set<string>;
}

/** Consumer-provided configuration for the rolling dispatcher. */
export interface RollingDispatchConfig<TPacket> {
  /** Confirmed provider pools, in preference order. */
  confirmedPools: CapacityPool[];
  sessionConfig: SessionConfig;
  /**
   * Dispatch a single packet to the given provider slot.
   * Must resolve (never reject) with a RollingDispatchResult.
   */
  dispatchPacket: (
    packet: RollingDispatchPacket<TPacket>,
    slot: ProviderSlot,
  ) => Promise<RollingDispatchResult<TPacket>>;
  /** Called synchronously after each packet completes (before the next enqueue pass). */
  onResult?: (result: RollingDispatchResult<TPacket>) => void;
  /**
   * Half-life for decaying empirical quota evidence (hours).
   * Defaults to DEFAULT_EMPIRICAL_HALF_LIFE_HOURS.
   */
  halfLifeHours?: number;
}

/** Options for tuning the dispatcher (intentionally minimal per INV-S05). */
export interface RollingDispatchOptions {
  /**
   * Optional cap on concurrent dispatches per pool.
   * Omit to let quota headroom from scheduleWave be the only throttle (INV-S05).
   * When set, this acts as an additional hard ceiling AFTER quota calculations.
   */
  maxConcurrentPerPool?: number;
}

/** Public interface returned by createRollingDispatcher. */
export interface RollingDispatcher<TPacket> {
  /**
   * Add packets to the pending queue.
   * Safe to call while `run()` is active — newly enqueued packets are picked
   * up on the next dispatch pass.
   */
  enqueue(packets: RollingDispatchPacket<TPacket>[]): void;
  /**
   * Drive dispatch to completion.
   * Resolves once every packet (including those enqueued mid-run) has either
   * completed or been stranded because no pool survived to dispatch it.
   */
  run(): Promise<RollingDispatchResult<TPacket>[]>;
  /** Read-only snapshot of current dispatcher state. */
  getState(): Readonly<RollingDispatchState<TPacket>>;
  /**
   * After {@link run} resolves, returns an `empty_pool` PartialCompletionTerminal
   * naming any packets that could not be dispatched because every pool exhausted
   * (INV-QD-07). Returns `null` when every packet completed. The consumer owns
   * routing the stranded ids through its terminal handler.
   */
  getTerminal(): PartialCompletionTerminal | null;
}

// ---------------------------------------------------------------------------
// InFlightTokenTracker
// ---------------------------------------------------------------------------

/**
 * Tracks the sum of estimated tokens for all in-flight packets per pool.
 * Used to subtract from quota headroom before each dispatch decision.
 */
export class InFlightTokenTracker {
  private readonly _tokens: Map<string, number> = new Map();

  recordDispatched(poolId: string, tokens: number): void {
    const current = this._tokens.get(poolId) ?? 0;
    this._tokens.set(poolId, current + Math.max(0, tokens));
  }

  recordCompleted(poolId: string, tokens: number): void {
    const current = this._tokens.get(poolId) ?? 0;
    this._tokens.set(poolId, Math.max(0, current - Math.max(0, tokens)));
  }

  getInFlightTokens(poolId: string): number {
    return this._tokens.get(poolId) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// scorePacketComplexity
// ---------------------------------------------------------------------------

/** Extract the complexity score from a packet (passthrough of the field). */
export function scorePacketComplexity<TPacket>(
  packet: RollingDispatchPacket<TPacket>,
): number {
  return packet.complexity;
}

// ---------------------------------------------------------------------------
// Capability tier ordering
// ---------------------------------------------------------------------------

/**
 * Numeric rank for a pool's declared DispatchModelTier.
 *
 * INV-shared-core-02: pool routing rank must be derived from the pool's
 * declared `rank` (set at the scheduler handshake from discovered roster
 * data), never from a hardcoded provider-name → tier lookup table. Absent
 * rank falls back to the middle tier ("standard"), not to a provider-name
 * switch, so new providers are neutral rather than silently mis-classified.
 */
const DISPATCH_TIER_RANK: Record<string, number> = {
  deep: 3,
  standard: 2,
  small: 1,
};

function poolCapabilityRank(pool: CapacityPool): number {
  if (pool.rank != null) {
    return DISPATCH_TIER_RANK[pool.rank] ?? 2;
  }
  // No roster rank declared — treat as standard (neutral).
  return DISPATCH_TIER_RANK["standard"]!;
}

// ---------------------------------------------------------------------------
// selectProvider
// ---------------------------------------------------------------------------

/**
 * Select the best available provider slot for a packet.
 *
 * High-complexity packets (complexity >= 0.5) prefer the most-capable pool;
 * low-complexity packets prefer the least-capable pool (preserving expensive
 * capacity for harder work).
 *
 * Pools whose id is in `exhaustedPoolIds` are skipped — this is how the
 * transient-429 recovery re-routes a re-queued packet to a pool still within
 * headroom (INV-QD-07): the pool that rate-limited is excluded on the next pass.
 *
 * Returns null if no eligible pool currently has quota headroom.
 */
export function selectProvider<TPacket>(
  packet: RollingDispatchPacket<TPacket>,
  confirmedPools: CapacityPool[],
  inFlightTracker: InFlightTokenTracker,
  quotaStateEntries: Record<string, QuotaStateEntry>,
  sessionConfig: SessionConfig,
  exhaustedPoolIds: ReadonlySet<string> = new Set(),
): ProviderSlot | null {
  const complexity = scorePacketComplexity(packet);
  const highComplexity = complexity >= 0.5;

  // Sort pools by capability rank: high-complexity → descending, low-complexity → ascending.
  const sorted = [...confirmedPools]
    .filter((p) => !exhaustedPoolIds.has(p.id))
    .sort((a, b) => {
      const diff = poolCapabilityRank(b) - poolCapabilityRank(a);
      return highComplexity ? diff : -diff;
    });

  for (const pool of sorted) {
    const poolKey = buildProviderModelKey(pool.providerName, pool.hostModel);
    const quotaStateEntry = pool.quotaStateEntry ?? quotaStateEntries[poolKey] ?? null;
    const inFlightTokens = inFlightTracker.getInFlightTokens(pool.id);

    // Ask scheduleWave whether this pool can accept one more slot, accounting
    // for in-flight tokens as additional estimated slot cost.
    const schedule = scheduleWave({
      providerName: pool.providerName,
      sessionConfig,
      hostModel: pool.hostModel,
      requestedConcurrency: 1,
      estimatedSlotTokens: [packet.estimatedTokens + inFlightTokens],
      quotaStateEntry,
      hostConcurrencyLimit: pool.hostConcurrencyLimit,
      discoveredLimits: pool.discoveredLimits ?? null,
      quotaSourceSnapshot: pool.quotaSourceSnapshot ?? null,
    });

    if (schedule.max_concurrent > 0) {
      return {
        providerName: pool.providerName,
        hostModel: pool.hostModel,
        poolId: pool.id,
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// createRollingDispatcher
// ---------------------------------------------------------------------------

/**
 * Create a rolling dispatcher for the given configuration.
 *
 * The returned dispatcher drives all packets to completion, dispatching each
 * packet as soon as quota headroom is available — no wave batching, no
 * separate concurrency cap unless `options.maxConcurrentPerPool` is set.
 */
export function createRollingDispatcher<TPacket>(
  config: RollingDispatchConfig<TPacket>,
  options: RollingDispatchOptions = {},
): RollingDispatcher<TPacket> {
  const {
    confirmedPools,
    sessionConfig,
    dispatchPacket,
    onResult,
    halfLifeHours = DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
  } = config;

  const state: RollingDispatchState<TPacket> = {
    pendingQueue: [],
    inFlight: new Map(),
    completedIds: new Set(),
    exhaustedPoolIds: new Set(),
    strandedIds: new Set(),
  };

  const inFlightTracker = new InFlightTokenTracker();
  const allResults: RollingDispatchResult<TPacket>[] = [];
  // Per-pool in-flight count for optional maxConcurrentPerPool cap.
  const inFlightPerPool: Map<string, number> = new Map();

  // Quota state cache — refreshed before each dispatch pass.
  let quotaStateCache: QuotaState = { version: 2, entries: {} };
  let quotaStateCacheDirty = true;

  async function refreshQuotaStateIfNeeded(): Promise<void> {
    if (quotaStateCacheDirty) {
      try {
        quotaStateCache = await readQuotaState();
      } catch {
        // Non-fatal: fall back to empty state
        quotaStateCache = { version: 2, entries: {} };
      }
      quotaStateCacheDirty = false;
    }
  }

  function getDispatchablePackets(): RollingDispatchPacket<TPacket>[] {
    // Return pending queue items not yet in flight (by id).
    return state.pendingQueue.filter(
      (p) => !state.inFlight.has(p.id) && !state.completedIds.has(p.id),
    );
  }

  function dispatchOnePacket(
    packet: RollingDispatchPacket<TPacket>,
    slot: ProviderSlot,
  ): void {
    // Remove from pending queue.
    state.pendingQueue = state.pendingQueue.filter((p) => p.id !== packet.id);

    inFlightTracker.recordDispatched(slot.poolId, packet.estimatedTokens);
    inFlightPerPool.set(slot.poolId, (inFlightPerPool.get(slot.poolId) ?? 0) + 1);

    const slotId = `${packet.id}@${slot.poolId}`;
    const startedAt = Date.now();

    const promise = dispatchPacket(packet, slot).then((result) => result).catch((err): RollingDispatchResult<TPacket> => ({
      packet,
      outcome: "error" as const,
      error: err,
    }));

    const entry: InFlightEntry<TPacket> = {
      slotId,
      packet,
      providerSlot: slot,
      startedAt,
      estimatedTokens: packet.estimatedTokens,
      promise,
    };

    state.inFlight.set(packet.id, entry);
  }

  async function handleResult(
    packetId: string,
    result: RollingDispatchResult<TPacket>,
  ): Promise<void> {
    const entry = state.inFlight.get(packetId);
    if (!entry) return;

    const { providerSlot, estimatedTokens, packet } = entry;

    // Update in-flight tracking (drains the token accounting regardless of
    // outcome so headroom reflects the freed slot on the next pass).
    inFlightTracker.recordCompleted(providerSlot.poolId, estimatedTokens);
    inFlightPerPool.set(
      providerSlot.poolId,
      Math.max(0, (inFlightPerPool.get(providerSlot.poolId) ?? 1) - 1),
    );

    state.inFlight.delete(packetId);

    // Record quota outcome. 'error' is a distinct quota outcome (non-quota
    // failure — no cooldown, only failure weight); 'rate_limited' applies the
    // backoff cooldown that throttles the exhausted pool's learned limits.
    const providerModelKey = buildProviderModelKey(providerSlot.providerName, providerSlot.hostModel);
    const quotaOutcome = result.outcome === "success" ? "success"
      : result.outcome === "rate_limited" ? "rate_limited"
      : result.outcome === "error" ? "error"
      : "timeout" as const;

    try {
      await recordWaveOutcome(
        providerModelKey,
        {
          concurrency: 1,
          estimated_tokens: estimatedTokens,
          outcome: quotaOutcome,
        },
        halfLifeHours,
      );
    } catch {
      // Non-fatal: quota recording failure should not abort dispatch.
    }

    quotaStateCacheDirty = true;

    // Transient-exhaustion recovery (INV-QD-07 / ARC-d81a55ab): a rate_limited
    // result is NOT a terminal completion. Drop the exhausted pool from the
    // active routing set and re-queue the packet so the next dispatch pass
    // re-selects a pool still within headroom. The packet is therefore neither
    // marked completed nor recorded as a result — it remains live work.
    if (result.outcome === "rate_limited") {
      state.exhaustedPoolIds.add(providerSlot.poolId);
      // Re-queue at the front so the displaced packet is retried before fresh
      // pending work (avoids starving an already-attempted packet).
      if (!state.completedIds.has(packet.id) && !state.pendingQueue.some((q) => q.id === packet.id)) {
        state.pendingQueue.unshift(packet);
      }
      // Observability: a single structured line per exhaustion re-queue.
      try {
        process.stderr.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            kind: "rolling_dispatch_requeue_rate_limited",
            packet_id: packet.id,
            exhausted_pool_id: providerSlot.poolId,
          }) + "\n",
        );
      } catch {
        // Observability must never abort a run.
      }
      return;
    }

    // Terminal completion (success / timeout / error): mark done, store result.
    state.completedIds.add(packetId);
    allResults.push(result);
    onResult?.(result);
  }

  function enqueue(packets: RollingDispatchPacket<TPacket>[]): void {
    for (const p of packets) {
      if (!state.completedIds.has(p.id) && !state.inFlight.has(p.id)) {
        // Avoid duplicate enqueue.
        if (!state.pendingQueue.some((q) => q.id === p.id)) {
          state.pendingQueue.push(p);
        }
      }
    }
  }

  /**
   * True when no confirmed pool is eligible to dispatch (every pool has been
   * dropped into `exhaustedPoolIds`). Waiting cannot help — the remaining
   * pending work must be stranded (INV-QD-07 empty-pool terminal).
   */
  function allPoolsExhausted(): boolean {
    return confirmedPools.every((p) => state.exhaustedPoolIds.has(p.id));
  }

  /** Move every still-pending packet into the stranded set and clear the queue. */
  function strandPending(): void {
    for (const packet of state.pendingQueue) {
      if (!state.completedIds.has(packet.id)) state.strandedIds.add(packet.id);
    }
    state.pendingQueue = [];
  }

  async function run(): Promise<RollingDispatchResult<TPacket>[]> {
    while (state.pendingQueue.length > 0 || state.inFlight.size > 0) {
      // Dispatch pass: fill quota headroom with pending packets.
      await refreshQuotaStateIfNeeded();

      let dispatched = 0;
      const dispatchable = getDispatchablePackets();

      for (const packet of dispatchable) {
        // selectProvider skips pools in exhaustedPoolIds, so a re-queued packet
        // re-routes to a surviving pool (INV-QD-07).
        const slot = selectProvider(
          packet,
          confirmedPools,
          inFlightTracker,
          quotaStateCache.entries,
          sessionConfig,
          state.exhaustedPoolIds,
        );

        if (slot === null) continue;

        // Apply optional maxConcurrentPerPool cap.
        if (
          options.maxConcurrentPerPool !== undefined &&
          (inFlightPerPool.get(slot.poolId) ?? 0) >= options.maxConcurrentPerPool
        ) {
          continue;
        }

        dispatchOnePacket(packet, slot);
        dispatched++;
      }

      // If nothing is in flight and nothing was dispatched but pending work
      // remains, decide whether to wait or strand:
      //  - All pools exhausted → waiting cannot help; strand the remainder and
      //    surface an empty_pool terminal (INV-QD-07 / SEAM-rolling-stranding).
      //  - Otherwise this is a transient quota cooldown; yield briefly and retry.
      if (state.inFlight.size === 0 && dispatched === 0 && state.pendingQueue.length > 0) {
        if (allPoolsExhausted()) {
          strandPending();
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        continue;
      }

      // If nothing is in flight after the dispatch pass, we're done.
      if (state.inFlight.size === 0) {
        break;
      }

      // Await the earliest in-flight completion (race all in-flight promises).
      const inFlightEntries = [...state.inFlight.entries()];
      const firstResult = await Promise.race(
        inFlightEntries.map(async ([packetId, entry]) => {
          const result = await entry.promise;
          return { packetId, result };
        }),
      );

      await handleResult(firstResult.packetId, firstResult.result);
      // Loop immediately to re-run the dispatch pass.
    }

    return allResults;
  }

  function getState(): Readonly<RollingDispatchState<TPacket>> {
    return state;
  }

  function getTerminal(): PartialCompletionTerminal | null {
    if (state.strandedIds.size === 0) return null;
    return buildEmptyPoolTerminal([...state.strandedIds]);
  }

  return { enqueue, run, getState, getTerminal };
}
