/**
 * Rolling dispatch engine — packet-type-agnostic.
 *
 * Key design invariants:
 * - No max_concurrent in the public API; quota headroom from `scheduleWave` is the
 *   sole throttle (INV-S05).
 * - TPacket is fully opaque; the engine never inspects packet payload.
 * - Terminal hooks (synthesis, ingestion) are NOT inline — consumers supply an
 *   `onResult` callback and own any terminal logic after `run()` returns.
 * - `recordWaveOutcome` requires `setQuotaStateDir()` to be called before
 *   `run()` (existing shared quota contract).
 */

import type { SessionConfig } from "../types/sessionConfig.js";
import type { CapacityPool } from "../quota/capacity.js";
import type { QuotaStateEntry, QuotaState } from "../quota/types.js";
import {
  scheduleWave,
  buildProviderModelKey,
  DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
} from "../quota/scheduler.js";
import { recordWaveOutcome, readQuotaState } from "../quota/state.js";

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
   * Resolves once every packet (including those enqueued mid-run) has been
   * dispatched and its result recorded.
   */
  run(): Promise<RollingDispatchResult<TPacket>[]>;
  /** Read-only snapshot of current dispatcher state. */
  getState(): Readonly<RollingDispatchState<TPacket>>;
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

const TIER_RANK: Record<string, number> = {
  frontier: 3,
  capable: 2,
  fast: 1,
  unknown: 0,
};

function poolCapabilityRank(pool: CapacityPool): number {
  // CapacityPool doesn't carry capabilityTier directly; derive from providerName.
  // claude-code = frontier (3), all others default to capable (2).
  switch (pool.providerName) {
    case "claude-code": return TIER_RANK["frontier"]!;
    case "opencode":
    case "codex":
    case "subprocess-template":
    case "vscode-task":
    case "antigravity":
      return TIER_RANK["capable"]!;
    default: return TIER_RANK["unknown"]!;
  }
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
 * Returns null if no pool currently has quota headroom.
 */
export function selectProvider<TPacket>(
  packet: RollingDispatchPacket<TPacket>,
  confirmedPools: CapacityPool[],
  inFlightTracker: InFlightTokenTracker,
  quotaStateEntries: Record<string, QuotaStateEntry>,
  sessionConfig: SessionConfig,
): ProviderSlot | null {
  const complexity = scorePacketComplexity(packet);
  const highComplexity = complexity >= 0.5;

  // Sort pools by capability rank: high-complexity → descending, low-complexity → ascending.
  const sorted = [...confirmedPools].sort((a, b) => {
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

    const { providerSlot, estimatedTokens } = entry;

    // Update in-flight tracking.
    inFlightTracker.recordCompleted(providerSlot.poolId, estimatedTokens);
    inFlightPerPool.set(
      providerSlot.poolId,
      Math.max(0, (inFlightPerPool.get(providerSlot.poolId) ?? 1) - 1),
    );

    // Move to completed.
    state.inFlight.delete(packetId);
    state.completedIds.add(packetId);

    // Record quota outcome.
    const providerModelKey = buildProviderModelKey(providerSlot.providerName, providerSlot.hostModel);
    const quotaOutcome = result.outcome === "success" ? "success"
      : result.outcome === "rate_limited" ? "rate_limited"
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

    // Store result and call consumer hook.
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

  async function run(): Promise<RollingDispatchResult<TPacket>[]> {
    while (state.pendingQueue.length > 0 || state.inFlight.size > 0) {
      // Dispatch pass: fill quota headroom with pending packets.
      await refreshQuotaStateIfNeeded();

      let dispatched = 0;
      const dispatchable = getDispatchablePackets();

      for (const packet of dispatchable) {
        // Check optional per-pool cap.
        // We'll find a slot first, then check the cap.
        const slot = selectProvider(
          packet,
          confirmedPools,
          inFlightTracker,
          quotaStateCache.entries,
          sessionConfig,
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

      // If nothing is in flight and nothing was dispatched, but there's still
      // pending work, yield briefly to avoid a tight loop (quota cooldown case).
      if (state.inFlight.size === 0 && dispatched === 0 && state.pendingQueue.length > 0) {
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

  return { enqueue, run, getState };
}
