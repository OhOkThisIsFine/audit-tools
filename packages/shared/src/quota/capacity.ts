import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type {
  HostConcurrencyLimit,
  QuotaStateEntry,
  WaveBindingCap,
  WaveSchedule,
} from "./types.js";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import { scheduleWave, type DiscoveredRateLimitsInput } from "./scheduler.js";

/**
 * A dispatch capacity pool: one backend (a provider + host model) that runs
 * review/worker subagents in parallel, each in its own fresh session with its
 * own context window. Today every dispatch has exactly one pool — the
 * conversation host's own subagents — but this shape is the extension point for
 * heterogeneous dispatch: when a second backend becomes available (a different
 * IDE model, another CLI provider) it is simply another pool, and
 * {@link computeDispatchCapacity} allocates the pending work across all of them.
 * A pool carries everything {@link scheduleWave} needs to size that one backend,
 * so per-pool limits never have to be threaded separately at the call site.
 */
export interface CapacityPool {
  /** Stable identifier, e.g. the provider/model key. */
  id: string;
  providerName: ResolvedProviderName;
  hostModel: string | null;
  /**
   * Hard ceiling on simultaneously active subagents for this pool, if the host
   * reported one (e.g. `--host-max-active-subagents`, or `parallel_workers` from
   * session-config). null leaves only the rate / learned / first-contact caps.
   */
  hostConcurrencyLimit: HostConcurrencyLimit | null;
  /** Learned quota-state entry for this pool's provider/model key, if any. */
  quotaStateEntry?: QuotaStateEntry | null;
  /** RPM/TPM discovered for this pool (provider query or response headers). */
  discoveredLimits?: DiscoveredRateLimitsInput | null;
  /** Real-time usage snapshot for this pool, if available. */
  quotaSourceSnapshot?: QuotaUsageSnapshot | null;
}

/** One pool's slice of the overall dispatch capacity. */
export interface PoolDispatchAllocation {
  pool_id: string;
  /** Concurrent dispatch slots this pool can sustain right now. */
  slots: number;
  /** Full wave schedule for this pool (resolved limits, binding cap, cooldown). */
  schedule: WaveSchedule;
}

/**
 * The just-in-time dispatch capacity: how many pending items can be dispatched
 * concurrently right now, across all available pools, given each pool's current
 * quota / rate limits and the projected token cost of the pending work. It is
 * computed immediately before a dispatch and is never persisted as a fixed plan
 * — recomputing it each step is what lets a run be picked up by a different host
 * (other models, other providers) without inheriting a stale wave size.
 */
export interface DispatchCapacity {
  /** Total concurrent dispatch slots across every pool. */
  total_slots: number;
  /** Per-pool allocation. One entry today; one per backend under multi-dispatch. */
  pools: PoolDispatchAllocation[];
  /**
   * The pool whose resolved limits summarize the dispatch at the contract level.
   * Single pool today; under multi-dispatch this is the primary/most-capable pool
   * and the lean contract still summarizes from it until the contract grows a
   * per-pool view.
   */
  primary: PoolDispatchAllocation;
  /** Most-constraining cap across pools, for attribution. */
  binding_cap: WaveBindingCap;
  /** Earliest cooldown across pools, if any pool is throttled. */
  cooldown_until: string | null;
  /** Estimated input tokens for one wave at the resolved capacity (summed across pools). */
  estimated_wave_tokens: number;
}

export interface ComputeDispatchCapacityInput {
  /** Available dispatch pools. Must be non-empty. */
  pools: CapacityPool[];
  sessionConfig: SessionConfig;
  /**
   * Projected per-item input-token cost for the pending work — one entry per
   * dispatchable item (packet/task). This is "all the pending tasks laid out with
   * their token costs": capacity is computed against this layout rather than
   * against a preset wave size, so the answer reflects the actual work waiting and
   * the tools currently available.
   */
  pendingItemTokens: number[];
}

/** Higher number = more constraining; used to pick the binding cap across pools. */
const CAP_PRIORITY: Record<WaveBindingCap, number> = {
  cooldown: 6,
  host_concurrency: 5,
  tpm: 4,
  rpm: 3,
  learned: 2,
  first_contact: 1,
  fallback: 1,
  none: 0,
};

/**
 * Compute just-in-time dispatch capacity across the available pools.
 *
 * Single-pool today: the one pool is offered the entire pending layout as its
 * ambition, and {@link scheduleWave} reduces that to what the pool's host
 * concurrency, RPM, TPM, learned, and real-time quota limits allow. Multi-pool is
 * the natural extension — partition `pendingItemTokens` across pools (by cost or
 * affinity), schedule each pool against its slice, and sum the slots — without
 * changing any call site, because they all already speak in pools and item costs.
 */
export function computeDispatchCapacity(
  input: ComputeDispatchCapacityInput,
): DispatchCapacity {
  if (input.pools.length === 0) {
    throw new Error("computeDispatchCapacity requires at least one capacity pool.");
  }
  if (input.pools.length > 1) {
    // The shape is multi-pool-ready, but real multi-pool dispatch needs to
    // PARTITION pendingItemTokens across pools — not hand the full layout to each
    // and sum the result, which would over-allocate capacity and double-count
    // tokens. Until that allocation exists, fail fast so no caller ships the
    // wrong sum. Remove this guard together with the partitioning logic when a
    // second backend is wired in.
    throw new Error(
      `computeDispatchCapacity received ${input.pools.length} pools, but multi-pool ` +
        `dispatch is not implemented yet (pendingItemTokens must be partitioned across pools first).`,
    );
  }

  const allocations: PoolDispatchAllocation[] = input.pools.map((pool) => {
    const schedule = scheduleWave({
      providerName: pool.providerName,
      sessionConfig: input.sessionConfig,
      hostModel: pool.hostModel,
      // The ambition is the full pending layout, not a fixed `parallel_workers`
      // config; scheduleWave reduces it to this pool's real capacity.
      requestedConcurrency: Math.max(1, input.pendingItemTokens.length),
      estimatedSlotTokens: input.pendingItemTokens,
      quotaStateEntry: pool.quotaStateEntry ?? null,
      hostConcurrencyLimit: pool.hostConcurrencyLimit,
      discoveredLimits: pool.discoveredLimits ?? null,
      quotaSourceSnapshot: pool.quotaSourceSnapshot ?? null,
    });
    return { pool_id: pool.id, slots: schedule.wave_size, schedule };
  });

  const total = allocations.reduce((sum, a) => sum + a.slots, 0);
  const primary = allocations[0]!;
  const bindingCap = allocations.reduce<WaveBindingCap>((worst, a) => {
    const cap = a.schedule.binding_cap ?? "none";
    return CAP_PRIORITY[cap] > CAP_PRIORITY[worst] ? cap : worst;
  }, "none");
  const cooldownUntil =
    allocations
      .map((a) => a.schedule.cooldown_until)
      .filter((c): c is string => c != null)
      .sort()[0] ?? null;
  const estimatedWaveTokens = allocations.reduce(
    (sum, a) => sum + a.schedule.estimated_wave_tokens,
    0,
  );

  return {
    total_slots: Math.max(1, total),
    pools: allocations,
    primary,
    binding_cap: bindingCap,
    cooldown_until: cooldownUntil,
    estimated_wave_tokens: estimatedWaveTokens,
  };
}
