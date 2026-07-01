import { z } from "zod";
import type { ResolvedProviderName, SessionConfig, DispatchableSource } from "../types/sessionConfig.js";
import type { DispatchModelTier } from "../types/stepContract.js";
import { DispatchModelTierSchema } from "../types/stepContract.js";
import type {
  HostConcurrencyLimit,
  QuotaStateEntry,
  WaveBindingCap,
  WaveSchedule,
} from "./types.js";
import {
  HostConcurrencyLimitSchema,
  LimitConfidenceSchema,
  LimitSourceSchema,
  ResolvedLimitsSchema,
  WaveBindingCapSchema,
} from "./types.js";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import { QuotaUsageSnapshotSchema } from "./quotaSource.js";
import type { QuotaCoverageStatus } from "./coverage.js";
import { QuotaCoverageStatusSchema } from "./coverage.js";
import { scheduleWave, type DiscoveredRateLimitsInput } from "./scheduler.js";

/**
 * Reason a partial-completion terminal fired on the dispatch engine.
 * - `empty_pool`: no capacity pools are available (pool list is empty or every
 *   pool reports zero slots) and the engine cannot dispatch remaining items.
 * - `livelock_guard`: N consecutive waves passed with zero progress (all items
 *   remain undispatchable despite pools being present) and the guard tripped.
 * - `quota_paused`: every remaining item's pool is paused until a stated host
 *   session-limit reset (a "resets 1:50pm"-style wall), and nothing is in flight.
 *   Distinct from `empty_pool` / `livelock_guard`: the strand is RETRYABLE — a
 *   later step (after the earliest reset) redispatches the stranded items clean,
 *   so the consumer must keep them PENDING, never mark them blocked/failed.
 */
export type PartialCompletionReason = "empty_pool" | "livelock_guard" | "quota_paused";

/**
 * Consumer-neutral signal that the dispatch engine reached a terminal it cannot
 * recover from on its own. The caller must route stranded items through a
 * consumer-specific handler (e.g. audit marks them uncovered and proceeds to
 * synthesis; remediate marks them blocked and proceeds to close).
 *
 * Produced by {@link detectLivelock} and persisted on the active-dispatch
 * artifact so both the audit and remediation orchestrators can inspect it in
 * their state-derivation logic.
 */
export interface PartialCompletionTerminal {
  reason: PartialCompletionReason;
  /** task/unit IDs the engine could not dispatch. */
  stranded_ids: string[];
  /**
   * Only set for `reason: "quota_paused"`: the ISO timestamp of the EARLIEST
   * pool reset across the stranded items' paused pools. A later step scheduled
   * at/after this instant can redispatch the stranded items — they redo clean.
   */
  earliest_reset_at?: string;
}

/**
 * Detect a livelock or empty-pool condition after a series of no-progress waves
 * and return a {@link PartialCompletionTerminal} if one is found.
 *
 * Call this after each dispatch wave where no items were dispatched. When
 * `consecutiveNoProgressWaves` reaches or exceeds `noProgressLimit` (default
 * 3), the engine is declared livelocked and a terminal is returned. If
 * `pendingIds` is empty the terminal reason is `empty_pool` regardless of the
 * wave count (no work remains to stall on). Returns `null` when the condition
 * has not yet been reached.
 *
 * The caller is responsible for persisting the returned terminal and routing
 * stranded items through its consumer-specific handler.
 */
export function detectLivelock(options: {
  pendingIds: string[];
  consecutiveNoProgressWaves: number;
  noProgressLimit?: number;
}): PartialCompletionTerminal | null {
  const { pendingIds, consecutiveNoProgressWaves, noProgressLimit = 3 } = options;

  if (pendingIds.length === 0) {
    return null; // nothing stranded — no terminal needed
  }

  if (consecutiveNoProgressWaves >= noProgressLimit) {
    return {
      reason: "livelock_guard",
      stranded_ids: [...pendingIds],
    };
  }

  return null;
}

/**
 * Produce an `empty_pool` {@link PartialCompletionTerminal} for the given IDs.
 * Call this when `computeDispatchCapacity` would throw because no pools are
 * available, so the caller can record the terminal and route stranded items
 * without crashing.
 */
export function buildEmptyPoolTerminal(strandedIds: string[]): PartialCompletionTerminal {
  return {
    reason: "empty_pool",
    stranded_ids: [...strandedIds],
  };
}

/**
 * Produce a `quota_paused` {@link PartialCompletionTerminal}: the stranded items'
 * pools are all paused until a stated host session-limit reset, and nothing is in
 * flight. `earliestResetAt` (ISO) is the soonest reset a resuming step should wait
 * for. The consumer keeps these items PENDING/re-dispatchable — they are NOT a
 * failure, unlike the empty-pool / livelock terminals.
 */
export function buildQuotaPausedTerminal(
  strandedIds: string[],
  earliestResetAt: string | null,
): PartialCompletionTerminal {
  return {
    reason: "quota_paused",
    stranded_ids: [...strandedIds],
    ...(earliestResetAt ? { earliest_reset_at: earliestResetAt } : {}),
  };
}

/**
 * A dispatch capacity pool: one backend (a provider + host model) that runs
 * review/worker subagents in parallel, each in its own fresh session with its
 * own context window. The conversation host's own subagents are one pool; a
 * different IDE model, another CLI provider, or another host lane is another.
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
   * Relative rank this pool serves when the host reported a model roster at
   * the handshake (aligned with `DispatchModelHint.tier`). Absent for the
   * single-window handshake.
   */
  rank?: DispatchModelTier;
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
  /**
   * Tokens already in flight against this pool (sum of estimated tokens for
   * dispatched-but-not-yet-completed packets). Threaded into {@link scheduleWave}
   * so the token-budget gate never over-subscribes the remaining window across
   * concurrent dispatch. Defaults to 0 when absent.
   */
  inFlightTokens?: number;
  /**
   * Explicit silent-degrade marker: true when this pool's proactive quota source
   * was queried and degraded to no snapshot (missing/expired creds, 401/5xx,
   * network error, unmappable payload) — i.e. a live reading was EXPECTED but
   * lost, which a bare `quotaSourceSnapshot: null` cannot distinguish from "no
   * source applies here". This is a RAW per-pool signal for observability and the
   * downstream fold; it is deliberately NOT pre-folded into a slot count here (the
   * byte-estimate × safety-margin floor-1 degrade lives in `scheduleWave`, S4).
   */
  quotaSignalDegraded?: boolean;
  /**
   * Proactive-quota coverage for this pool's provider: whether a source is wired in
   * code (`established`), the provider is reactive-only by nature (`reactive_only`),
   * or the environment is unsupported (`unestablished`). The last drives the
   * host-agent nudge instead of silently degrading to reactive 429. See
   * {@link classifyQuotaCoverage}.
   */
  quotaCoverage?: QuotaCoverageStatus;
  /**
   * The generic dispatchable source this pool was built from, when it is a
   * configured backend source (not the conversation host's own pool). The dispatch
   * worker rebuilds the provider from THIS source's `{endpoint, model, parameters}`
   * rather than the global per-provider config block — which is what lets two
   * sources of the same provider (e.g. two NIM endpoints) launch distinctly.
   */
  source?: DispatchableSource;
}

/** One pool's slice of the overall dispatch capacity. */
export interface PoolDispatchAllocation {
  pool_id: string;
  /** Relative rank this pool serves, when the host reported a roster. */
  rank?: DispatchModelTier;
  /** Concurrent dispatch slots this pool can sustain right now. */
  slots: number;
  /** Full wave schedule for this pool (resolved limits, binding cap, cooldown). */
  schedule: WaveSchedule;
  /**
   * Echo of {@link CapacityPool.quotaSignalDegraded} — the pool's proactive quota
   * source was queried and silently degraded. Carried through unfolded so the
   * summary/observability can surface it; never affects slot math here.
   */
  quotaSignalDegraded?: boolean;
  /** Echo of {@link CapacityPool.quotaCoverage} — proactive-quota coverage for this pool. */
  quotaCoverage?: QuotaCoverageStatus;
}

/** Compact, serializable view of one pool allocation for dispatch-quota files. */
export const DispatchCapacityPoolSummarySchema = z
  .object({
    pool_id: z.string().min(1),
    rank: DispatchModelTierSchema.optional(),
    slots: z.number().int().min(1),
    model: z.string().nullable(),
    confidence: LimitConfidenceSchema,
    source: LimitSourceSchema,
    resolved_limits: ResolvedLimitsSchema,
    host_concurrency_limit: HostConcurrencyLimitSchema.nullable(),
    cooldown_until: z.string().nullable(),
    estimated_wave_tokens: z.number().int().min(0),
    binding_cap: WaveBindingCapSchema,
    /**
     * Per-target token-budget view surfaced to the orchestrating host so it sees
     * the real constraints, not just an opaque slot count: the remaining token
     * budget the gate spent against (MIN across the pool's own windows; null when
     * no live snapshot / cold start) and the tokens already in flight against it.
     * `remaining_pct` / `reset_at` come from `quota_source_snapshot`.
     */
    remaining_token_budget: z.number().nullable().optional(),
    in_flight_tokens: z.number().int().min(0).optional(),
    quota_source_snapshot: QuotaUsageSnapshotSchema.nullable().optional(),
    /** Raw silent-degrade marker for this pool (see CapacityPool.quotaSignalDegraded). */
    quota_signal_degraded: z.boolean().optional(),
    /** Proactive-quota coverage status for this pool's provider (see classifyQuotaCoverage). */
    quota_coverage: QuotaCoverageStatusSchema.optional(),
  })
  .strict();
export type DispatchCapacityPoolSummary = z.infer<
  typeof DispatchCapacityPoolSummarySchema
>;

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
  /** Non-empty set of dispatch pools available to this invocation. */
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
  token_budget: 5,
  tpm: 4,
  rpm: 3,
  learned: 2,
  none: 0,
};

/**
 * Derive the global host-concurrency budget that applies across ALL pools, when
 * the pools are routing through the SAME conversation host.
 *
 * A host concurrency limit (`--host-max-active-subagents`, `AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS`,
 * or `parallel_workers` in session-config) constrains the TOTAL number of simultaneously
 * active subagents the conversation host can sustain — not a per-pool ceiling. When
 * multiple pools (e.g. small/standard/deep ranks) are all dispatching through the same
 * host, their combined slot usage must stay within this shared global limit.
 *
 * Detection heuristic: if ALL pools that carry a host concurrency limit report the
 * SAME `{active_subagents, source}` pair, they are sharing the same host signal.
 * In this case the shared value is returned as the global budget. When pools carry
 * DIFFERENT limits (indicating independent backends with their own concurrency
 * envelopes), `null` is returned so each pool's limit applies independently.
 *
 * A single-pool setup is unaffected: the pool's own `hostConcurrencyLimit` already
 * applies at `scheduleWave` time.
 */
function deriveGlobalHostBudget(pools: CapacityPool[]): number | null {
  if (pools.length <= 1) return null;
  const limitsWithLimit = pools.filter((p) => p.hostConcurrencyLimit !== null);
  if (limitsWithLimit.length === 0) return null;
  // All pools with limits must report the same active_subagents AND source to be
  // treated as a shared global limit from the same conversation host.
  const first = limitsWithLimit[0]!.hostConcurrencyLimit!;
  const allSame = limitsWithLimit.every(
    (p) =>
      p.hostConcurrencyLimit!.active_subagents === first.active_subagents &&
      p.hostConcurrencyLimit!.source === first.source,
  );
  if (!allSame) return null;
  // Only apply global budget when ALL pools (including those without limits) are
  // covered. If some pools lack a limit, they are independent backends that can
  // exceed the shared budget — so we don't enforce a global cap.
  if (limitsWithLimit.length !== pools.length) return null;
  return first.active_subagents;
}

/**
 * Compute just-in-time dispatch capacity across the available pools.
 *
 * The pending layout is partitioned across pools in caller order, with each pool
 * receiving the largest remaining item estimates that fit in its current wave.
 * Each pool is then scheduled independently, so RPM, TPM, learned limits, cooldowns,
 * and real-time quota snapshots remain per-backend.
 *
 * The host concurrency limit (e.g. `--host-max-active-subagents`) is GLOBAL: it
 * constrains the total across all pools, not each pool independently. When multiple
 * pools share the same conversation host, a global budget is derived from their
 * host limits and enforced as a ceiling on cumulative slot allocation so the host is
 * never over-subscribed. Independent backends with distinct pool IDs are treated as
 * separate lanes; each backend's per-backend limits remain per-pool.
 */
export function computeDispatchCapacity(
  input: ComputeDispatchCapacityInput,
): DispatchCapacity {
  if (input.pools.length === 0) {
    throw new TypeError("computeDispatchCapacity requires at least one capacity pool.");
  }

  const pendingTokens = [...input.pendingItemTokens]
    .map((n) => Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0)
    .sort((a, b) => b - a);

  // Global host-concurrency budget: when multiple pools share the same conversation
  // host, the total slots across all pools must not exceed this limit.
  const globalHostBudget = deriveGlobalHostBudget(input.pools);
  let remainingGlobalBudget = globalHostBudget;

  const allocations: PoolDispatchAllocation[] = [];
  if (pendingTokens.length === 0) {
    allocations.push(schedulePool(input.pools[0]!, input.sessionConfig, []));
  } else {
    let cursor = 0;
    for (const pool of input.pools) {
      if (cursor >= pendingTokens.length) break;
      if (remainingGlobalBudget !== null && remainingGlobalBudget <= 0) break;

      const remaining = pendingTokens.slice(cursor);
      const allocation = schedulePoolConverging(
        pool,
        input.sessionConfig,
        remaining,
        remainingGlobalBudget,
      );

      allocations.push(allocation);
      cursor += allocation.slots;
      if (remainingGlobalBudget !== null) {
        remainingGlobalBudget -= allocation.slots;
      }
    }
  }

  const total = allocations.reduce((sum, a) => sum + a.slots, 0);
  // When a global host budget was in effect, ensure the aggregate total never
  // exceeds it (the loop above already enforces this, but guard defensively).
  const effectiveTotal = globalHostBudget !== null
    ? Math.min(total, globalHostBudget)
    : total;
  const primary = choosePrimaryAllocation(allocations);
  const bindingCap = allocations.reduce<WaveBindingCap>((worst, a) => {
    const cap = a.schedule.binding_cap ?? "none";
    return CAP_PRIORITY[cap] > CAP_PRIORITY[worst] ? cap : worst;
  }, "none");
  // When the global budget is the binding constraint, record it.
  const effectiveBindingCap: WaveBindingCap =
    globalHostBudget !== null && effectiveTotal < total && effectiveTotal === globalHostBudget
      ? "host_concurrency"
      : bindingCap;
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
    total_slots: Math.max(1, effectiveTotal),
    pools: allocations,
    primary,
    binding_cap: effectiveBindingCap,
    cooldown_until: cooldownUntil,
    estimated_wave_tokens: estimatedWaveTokens,
  };
}

/**
 * Schedule a single pool against the items it has been allocated, converging on
 * a consistent slot count via a three-pass algorithm:
 *
 *  1. **Exploratory pass** — call `schedulePool` over ALL remaining items to get
 *     an unconstrained slot estimate and the full binding-cap attribution (RPM,
 *     TPM, learned, etc.). Using the full remaining set lets the TPM budget see
 *     the realistic token landscape rather than only the items already assigned.
 *
 *  2. **Initial assigned-slice pass** — narrow the token list to `assignedCount`
 *     items (clamped by the exploratory result and the global host budget) and
 *     re-schedule. Scheduling only the assigned slice can be MORE restrictive than
 *     the exploratory pass, because the TPM cap iterates over the actual slot costs.
 *
 *  3. **Convergence loop** — if the second pass returns fewer slots than items
 *     assigned (the assigned slice was still over-budget), trim to the returned
 *     slot count and re-schedule until assignment and slots agree. Each iteration
 *     removes at least one item, so the loop always terminates.
 *
 * The binding cap from the exploratory pass is preserved on the final allocation
 * when the narrowed slice loses its cap signal (e.g. the slice is so small that
 * it fits within any limit).
 */
function schedulePoolConverging(
  pool: CapacityPool,
  sessionConfig: SessionConfig,
  remaining: number[],
  remainingGlobalBudget: number | null,
): PoolDispatchAllocation {
  // Pass 1: exploratory — full remaining set for cap attribution.
  const exploratory = schedulePool(pool, sessionConfig, remaining);
  let assignedCount = Math.max(1, Math.min(exploratory.slots, remaining.length));
  // Clamp to the remaining global host budget before narrowing with the pool schedule.
  if (remainingGlobalBudget !== null) {
    assignedCount = Math.min(assignedCount, remainingGlobalBudget);
  }

  // Pass 2: initial assigned-slice.
  let assignedTokens = remaining.slice(0, assignedCount);
  let allocation = schedulePool(pool, sessionConfig, assignedTokens);

  // Pass 3: convergence — trim until assignment and slots agree.
  while (assignedTokens.length > 1 && allocation.slots < assignedTokens.length) {
    assignedCount = allocation.slots;
    assignedTokens = assignedTokens.slice(0, assignedCount);
    allocation = schedulePool(pool, sessionConfig, assignedTokens);
  }

  // Preserve the exploratory binding cap when the narrowed slice lost its cap signal.
  if (
    (allocation.schedule.binding_cap ?? "none") === "none" &&
    (exploratory.schedule.binding_cap ?? "none") !== "none"
  ) {
    allocation = {
      ...allocation,
      schedule: {
        ...allocation.schedule,
        binding_cap: exploratory.schedule.binding_cap,
      },
    };
  }

  return allocation;
}

function schedulePool(
  pool: CapacityPool,
  sessionConfig: SessionConfig,
  itemTokens: number[],
): PoolDispatchAllocation {
  const schedule = scheduleWave({
    providerName: pool.providerName,
    sessionConfig,
    hostModel: pool.hostModel,
    requestedConcurrency: Math.max(1, itemTokens.length),
    estimatedSlotTokens: itemTokens,
    quotaStateEntry: pool.quotaStateEntry ?? null,
    hostConcurrencyLimit: pool.hostConcurrencyLimit,
    discoveredLimits: pool.discoveredLimits ?? null,
    quotaSourceSnapshot: pool.quotaSourceSnapshot ?? null,
    inFlightTokens: pool.inFlightTokens ?? 0,
  });
  return {
    pool_id: pool.id,
    ...(pool.rank ? { rank: pool.rank } : {}),
    slots: itemTokens.length > 0
      ? Math.min(schedule.max_concurrent, itemTokens.length)
      : schedule.max_concurrent,
    schedule,
    // Raw signal carried through unfolded — does not enter the slot math above.
    ...(pool.quotaSignalDegraded ? { quotaSignalDegraded: true } : {}),
    ...(pool.quotaCoverage ? { quotaCoverage: pool.quotaCoverage } : {}),
  };
}

function choosePrimaryAllocation(
  allocations: PoolDispatchAllocation[],
): PoolDispatchAllocation {
  return allocations.reduce((best, candidate) => {
    if (candidate.slots !== best.slots) {
      return candidate.slots > best.slots ? candidate : best;
    }
    const candidateContext = candidate.schedule.resolved_limits.context_tokens;
    const bestContext = best.schedule.resolved_limits.context_tokens;
    if (candidateContext !== bestContext) {
      return candidateContext > bestContext ? candidate : best;
    }
    return candidate.pool_id < best.pool_id ? candidate : best;
  }, allocations[0]!);
}

export function summarizeDispatchCapacityPools(
  capacity: DispatchCapacity,
): DispatchCapacityPoolSummary[] {
  return capacity.pools.map((allocation) => ({
    pool_id: allocation.pool_id,
    ...(allocation.rank ? { rank: allocation.rank } : {}),
    slots: allocation.slots,
    model: allocation.schedule.model,
    confidence: allocation.schedule.confidence,
    source: allocation.schedule.source,
    resolved_limits: allocation.schedule.resolved_limits,
    host_concurrency_limit: allocation.schedule.host_concurrency_limit,
    cooldown_until: allocation.schedule.cooldown_until,
    estimated_wave_tokens: allocation.schedule.estimated_wave_tokens,
    binding_cap: allocation.schedule.binding_cap ?? "none",
    remaining_token_budget: allocation.schedule.remaining_token_budget ?? null,
    in_flight_tokens: allocation.schedule.in_flight_tokens ?? 0,
    quota_source_snapshot: allocation.schedule.quota_source_snapshot ?? null,
    ...(allocation.quotaSignalDegraded ? { quota_signal_degraded: true } : {}),
    ...(allocation.quotaCoverage ? { quota_coverage: allocation.quotaCoverage } : {}),
  }));
}
