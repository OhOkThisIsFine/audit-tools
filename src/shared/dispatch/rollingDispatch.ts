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
 * - Proactive cross-pool spill (INV-QD-14): selection deprioritises a pool that
 *   is quota-degraded (live `remaining_pct` below the LOW band, or in an active
 *   cooldown) so load spills onto a peer WITH headroom BEFORE a 429 — the
 *   proactive complement to the reactive exhausted-pool re-route above. The
 *   capability order is preserved WITHIN the healthy and degraded groups; a
 *   degraded pool stays a fallback so a run never stalls when every pool is
 *   degraded. Inert when quota management is disabled (selection stays pure
 *   capability order). This is what makes the real-time quota sources actually
 *   redistribute load instead of merely throttling a single chosen pool.
 */

import type { SessionConfig } from "../types/sessionConfig.js";
import type { CapacityPool, PartialCompletionTerminal } from "../quota/capacity.js";
import type { QuotaStateEntry, QuotaState, WaveSchedule } from "../quota/types.js";
import {
  scheduleWave,
  buildProviderModelKey,
  QUOTA_REMAINING_PCT_LOW,
} from "../quota/scheduler.js";
import {
  recordWaveOutcome,
  readQuotaState,
  emptyQuotaState,
  recordTokensPerPctObservation,
} from "../quota/state.js";
import { buildEmptyPoolTerminal, buildQuotaPausedTerminal } from "../quota/capacity.js";
import type { WorkerOutputChannel } from "../quota/errorParsing.js";
import { detectRateLimitError, computeCooldownUntil } from "../quota/errorParsing.js";
import type { ReservationLedger } from "../quota/reservationLedger.js";
import { tierRank } from "./tierRank.js";

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
  /**
   * Endpoint-REPORTED cost for this request in USD, relayed by the dispatcher from
   * the provider result (opencode's `cost` field). Consumed by the reactive
   * cost-verification seam in `handleResult`: a pool DECLARED free
   * (`declaredCostPerMtok === 0`) that reports a positive cost is demoted out of
   * free-first ordering. Absent when the backend reports no cost (most endpoints).
   */
  observedCostUsd?: number | null;
  error?: unknown;
  /**
   * The worker ERROR/STATUS channel evidence that classified a `rate_limited`
   * outcome. Carried so the consumer's `recordRateLimit` hook can re-validate it
   * through a channel-isolated host-session source (CE-003) and accrue the
   * bounded re-limit escalation count. Absent on non-rate_limited outcomes (and
   * on a rate_limited outcome a provider classified by exit-code rather than a
   * limit string — that path keeps the normal transient re-route, never an
   * account-wall escalation).
   */
  rateLimit?: {
    channel: WorkerOutputChannel;
    text: string;
    /**
     * ISO reset instant parsed from `text` when the limit stated a wall-clock
     * reset (a host *session* limit, e.g. "resets 1:50pm"). Set by the engine at
     * the rate_limited observation point (never by the provider): it records a
     * POOL-level pause until this instant, so the rolling loop skips that pool
     * rather than thrashing it, and — when it is the only surviving pool — strands
     * the remaining work as a retryable `quota_paused` terminal. Absent for a
     * bare transient 429 with no parseable reset (that keeps the INV-QD-07
     * cooldown-and-retry behaviour).
     */
    reset_at?: string;
  };
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
  /**
   * Reservation-ledger lease held for this in-flight packet (spec admission model).
   * Set only when a `reservationLedger` was configured; reconciled (freed) in
   * `handleResult` when the packet completes. `resourceKey` is the pool id the lease
   * was taken against, needed to reconcile. Null/undefined when no ledger is wired.
   */
  leaseId?: string | null;
  resourceKey?: string;
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
   * Pool id → epoch-ms of a host session-limit reset ("resets 1:50pm"-style
   * wall). A pool here is PAUSED-until-reset: `selectProvider` skips it while
   * `now < resetAtMs` (pause-honor, no thrash), and when every remaining item's
   * pool is paused with nothing in flight the run STRANDS them as a retryable
   * `quota_paused` terminal (piece D). Distinct from `exhaustedPoolIds` (a bare
   * transient 429 without a parseable reset): a paused pool carries the reset that
   * makes the strand retryable and drives the terminal's `earliest_reset_at`.
   */
  pausedPoolResetAt: Map<string, number>;
  /**
   * Packet ids that could not be dispatched because every pool was exhausted.
   * Surfaced via {@link RollingDispatcher.getTerminal} as an `empty_pool`
   * PartialCompletionTerminal (INV-QD-07).
   */
  strandedIds: Set<string>;
  /**
   * Pool ids demoted by reactive cost verification: a pool DECLARED free
   * (`declaredCostPerMtok === 0`) that reported a positive cost on a completion, so
   * its declared-free claim is falsified. Treated as quota-degraded by
   * `selectProvider` (spilled to fallback behind healthy pools), so a stale
   * `cost_per_mtok:0` can't silently keep free-first fill. In-memory: a fresh run
   * re-verifies from scratch — a promotional free tier that returns is re-tried, and
   * the durable cross-run operator signal is the per-pool friction event, not this
   * set. Monotonic (never un-demoted mid-run). Scope is this dispatcher instance by
   * default; when a driver injects a shared set (`config.costDemotedPoolIds`, as
   * `driveRolling` does) it spans every sub-wave + level of the whole drive.
   */
  costDemotedPoolIds: Set<string>;
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
   * Reactive cost verification (arbitrage tier): invoked ONCE per pool the FIRST
   * time a pool declared free (`declaredCostPerMtok === 0`) reports a positive cost
   * on a successful completion — its declared-free claim is falsified. The engine
   * has already demoted the pool (added it to `costDemotedPoolIds` → spilled to
   * fallback) by the time this fires; the hook is the consumer's seam to surface it
   * as reviewable friction (the consumer owns `artifactsDir`/`runId`, which the
   * packet-agnostic engine does not). Best-effort — a throwing hook never aborts
   * dispatch. Omit to leave demotion silent (no friction emitted).
   */
  onCostDrift?: (info: {
    poolId: string;
    observedCostUsd: number;
    declaredCostPerMtok: number;
  }) => void;
  /**
   * Shared cost-demotion set for reactive cost verification. When a driver runs
   * several dispatchers over one logical run (`driveRolling` creates one per
   * file-ownership sub-wave per dependency level), it passes ONE set here so a pool
   * demoted in an earlier sub-wave stays demoted (and `onCostDrift` fires once) for
   * the whole drive — without it the demotion would reset at every sub-wave/level
   * boundary and a lapsed-free pool would regain free-first fill each boundary. Omit
   * for a standalone dispatcher (it owns a fresh per-instance set).
   */
  costDemotedPoolIds?: Set<string>;
  /**
   * Host-session escalation predicate. When a `rate_limited` packet has been
   * ESCALATED by the host-session source (its account-level wall re-tripped the
   * SAME packet past the bounded re-limit guard — an unresettable / clock-skewed
   * wall), re-queuing it would livelock. Consulted in the rate_limited branch:
   * an escalated packet is STRANDED (surfaced via the empty-pool terminal) instead
   * of re-queued, while a non-escalated packet keeps the normal INV-QD-07
   * transient-exhaustion re-route. The consumer owns feeding the source's
   * `recordLimit` from the worker ERROR/STATUS channel; this is the read side.
   * Omit to leave INV-QD-07 behaviour unchanged.
   */
  isPacketEscalated?: (packetId: string) => boolean;
  /**
   * The write side of the host-session escalation guard: invoked at the
   * `rate_limited` observation point BEFORE {@link isPacketEscalated} is consulted,
   * so the consumer can feed its host-session source's channel-isolated
   * `recordLimit` and let a same-packet account wall accrue the bounded re-limit
   * count. The freshly-recorded escalation is then read back through
   * `isPacketEscalated` in the same pass — strand-instead-of-requeue. Receives the
   * packet and its result (carrying `rateLimit` channel/text evidence). Omit to
   * leave the source unfed (no escalation can ever fire).
   */
  recordRateLimit?: (
    packet: RollingDispatchPacket<TPacket>,
    result: RollingDispatchResult<TPacket>,
  ) => void;
  /**
   * Shared token-reservation ledger (spec/audit/dispatch-admission-control.md, the
   * proactive admission layer). When supplied, every dispatched packet LEASES its
   * output-envelope cost against the account-keyed ledger BEFORE dispatch and
   * reconciles the lease on completion — so two co-located dispatch loops pointed at
   * the SAME ledger file (same `provider#account/model` meter) each see the other's
   * outstanding reservations and cannot both optimistically assume the full budget.
   * The resourceKey is the pool id (`pool.id` is already `provider#account/model`).
   * Omit to leave the in-process `InFlightTokenTracker` as the sole accounting
   * (behaviour identical to before this field existed). The reactive 429/backoff
   * floor still catches any residual under-reservation regardless.
   */
  reservationLedger?: ReservationLedger;
  /**
   * Live remaining token budget for a pool's resourceKey (its `pool.id`). Consulted
   * only when `reservationLedger` is set — it is the budget the ledger admits
   * against (`budget - Σ outstanding_leases >= cost`). Return a non-finite value
   * (the default) for an optimistic/unbounded budget, in which case the ledger only
   * prevents co-located double-counting and never gates on an absolute token ceiling.
   */
  resolvePoolBudget?: (poolId: string) => number;
  /**
   * Output-token envelope (spec Resolved decision 1) added to a packet's INPUT
   * `estimatedTokens` to form the reservation cost. Consulted only when
   * `reservationLedger` is set. Default 0 → the lease reserves the input estimate
   * alone; the reactive floor still catches output under-reservation.
   */
  resolveOutputReservation?: (
    packet: RollingDispatchPacket<TPacket>,
    poolId: string,
  ) => number;
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
 *
 * The ordering is the single shared `tierRank` authority (P1) — this module no
 * longer keeps its own copy of the {small,standard,deep} map.
 */
function poolCapabilityRank(pool: CapacityPool): number {
  // tierRank() already maps an absent/unknown rank to the neutral middle tier.
  return tierRank(pool.rank);
}

// ---------------------------------------------------------------------------
// selectProvider
// ---------------------------------------------------------------------------

/**
 * Classify a pool as quota-degraded from its live signals: an active cooldown
 * (learned 429 backoff, or a critical proactive reset folded in by
 * `scheduleWave`) or a real-time `remaining_pct` below the LOW band. A degraded
 * pool is still dispatchable — `scheduleWave` floors the wave at 1 — but it is
 * deprioritised so load spills to a healthier peer first (INV-QD-14).
 *
 * Reads the same `QUOTA_REMAINING_PCT_LOW` threshold the scheduler uses to halve
 * a wave, so "degraded enough to halve" and "degraded enough to spill off" stay
 * defined by one constant rather than a second magic number.
 */
function isPoolQuotaDegraded(
  pool: CapacityPool,
  schedule: WaveSchedule,
): boolean {
  if (schedule.cooldown_until) return true;
  const remainingPct = pool.quotaSourceSnapshot?.remaining_pct;
  return remainingPct != null && remainingPct < QUOTA_REMAINING_PCT_LOW;
}

/**
 * Select the best available provider slot for a packet.
 *
 * Two ordering axes, applied in priority order:
 *  1. **Quota health (INV-QD-14, proactive spill).** When quota management is
 *     active, pools that are NOT quota-degraded are tried before degraded ones,
 *     so load spills off a throttled pool (low `remaining_pct` / in cooldown)
 *     onto a peer with headroom BEFORE a 429. This is the proactive complement to
 *     the reactive exhausted-pool re-route (INV-QD-07) and is what lets the
 *     real-time quota sources actually redistribute load across heterogeneous
 *     pools rather than merely throttling one chosen pool. Degraded pools remain
 *     a fallback so a run never stalls when every pool is degraded.
 *  2. **Capability rank.** WITHIN each health group, high-complexity packets
 *     (complexity >= 0.5) prefer the most-capable pool; low-complexity packets
 *     prefer the least-capable pool (preserving expensive capacity for harder
 *     work — the per-model/cost axis). Pool rank comes from `pool.rank`, never a
 *     provider-name table (INV-shared-core-02).
 *
 * Pools whose id is in `exhaustedPoolIds` are skipped — this is how the
 * transient-429 recovery re-routes a re-queued packet to a pool still within
 * headroom (INV-QD-07): the pool that rate-limited is excluded on the next pass.
 *
 * Pools in `costDemotedPoolIds` (a declared-free pool that reported a positive
 * cost — reactive cost verification) are treated as quota-degraded: still
 * dispatchable, but spilled to the fallback group behind healthy pools so they
 * lose their free-first preference.
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
  pausedPoolResetAt: ReadonlyMap<string, number> = new Map(),
  costDemotedPoolIds: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
): ProviderSlot | null {
  const complexity = scorePacketComplexity(packet);
  const highComplexity = complexity >= 0.5;

  // Pause-honor (piece D): a pool paused until a stated host session-limit reset
  // is skipped while `now < resetAt` — the rolling loop must NOT re-dispatch into
  // a paused pool (no thrash). Once its reset passes it becomes eligible again
  // (near-reset in-process resume), unlike the monotonic `exhaustedPoolIds`.
  const isPausedNow = (poolId: string): boolean => {
    const resetAt = pausedPoolResetAt.get(poolId);
    return resetAt != null && now < resetAt;
  };

  // Capability ordering: high-complexity → descending rank, low-complexity → ascending.
  // Within an equal-capability tie, balance by current in-flight load (least-loaded
  // first) so a run of same-complexity packets fans OUT across equal pools rather than
  // front-loading the first — deliberate multi-pool fan-out even when the pools are
  // unbounded (defect-1 sub-defect 2). Each dispatch updates the tracker, so the next
  // same-rank packet in the pass prefers the peer that is now less loaded.
  const sorted = [...confirmedPools]
    .filter((p) => !exhaustedPoolIds.has(p.id) && !isPausedNow(p.id))
    .sort((a, b) => {
      const diff = poolCapabilityRank(b) - poolCapabilityRank(a);
      const capOrdered = highComplexity ? diff : -diff;
      if (capOrdered !== 0) return capOrdered;
      return inFlightTracker.getInFlightTokens(a.id) - inFlightTracker.getInFlightTokens(b.id);
    });

  // Ask scheduleWave whether each pool can accept one more slot, accounting for
  // in-flight tokens as additional estimated slot cost. The schedule already
  // folds in the real-time quota snapshot, the resolved provider limits, and any
  // active cooldown, so it doubles as the health signal for the spill ordering below.
  const scheduleForPool = (pool: CapacityPool): WaveSchedule => {
    // pool.id is the canonical (provider, account, model) key — use it directly so
    // scheduling and outcome-recording index the SAME account-stamped quota entry.
    const poolKey = pool.id;
    // Prefer the LIVE quota entry over `pool.quotaStateEntry` (a frozen snapshot
    // captured at pool construction). `refreshQuotaStateIfNeeded` reloads the whole
    // on-disk state before every dispatchPass, so the live record is same-or-fresher:
    // reading the snapshot FIRST would hide a cooldown learned mid-run (INV-QD-16) —
    // the exact signal INV-QD-14 proactive spill needs — since the snapshot is fixed
    // at build time and never sees the mid-run write. The snapshot stays only as a
    // last-resort fallback for the narrow window where the live read is transiently
    // unavailable (readQuotaState throwing → the cache retains its prior/empty state),
    // so a prior-run cooldown still drives proactive spill instead of waiting for the
    // reactive 429 floor. Both are keyed by pool.id, so they can never index apart.
    const quotaStateEntry = quotaStateEntries[poolKey] ?? pool.quotaStateEntry ?? null;
    const inFlightTokens = inFlightTracker.getInFlightTokens(pool.id);
    return scheduleWave({
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
  };

  const evaluated = sorted.map((pool) => ({ pool, schedule: scheduleForPool(pool) }));

  // Proactive cross-pool spill (INV-QD-14): healthy pools first, then degraded,
  // each group keeping the capability order above (a stable partition). Quota
  // management is not switchable (one track, always-on), so this ordering always
  // applies — there is no inert "quota disabled" mode.
  // A cost-demoted pool (declared free but observed charging) is treated as
  // degraded so it spills behind healthy pools — the routing half of reactive cost
  // verification. Folded in here (not into `isPoolQuotaDegraded`, which is a pure
  // function of live quota signals) because the demotion set is dispatch-run state.
  const isDegraded = (e: { pool: CapacityPool; schedule: WaveSchedule }): boolean =>
    isPoolQuotaDegraded(e.pool, e.schedule) || costDemotedPoolIds.has(e.pool.id);
  const ordered = [
    ...evaluated.filter((e) => !isDegraded(e)),
    ...evaluated.filter((e) => isDegraded(e)),
  ];

  for (const { pool, schedule } of ordered) {
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
    onCostDrift,
    costDemotedPoolIds: injectedCostDemotedPoolIds,
    isPacketEscalated,
    recordRateLimit,
    reservationLedger,
    resolvePoolBudget,
    resolveOutputReservation: resolveOutputReservationFn,
  } = config;

  const state: RollingDispatchState<TPacket> = {
    pendingQueue: [],
    inFlight: new Map(),
    completedIds: new Set(),
    exhaustedPoolIds: new Set(),
    pausedPoolResetAt: new Map(),
    strandedIds: new Set(),
    // A driver-provided set (driveRolling) makes demotion span this run's sub-waves
    // + levels; a standalone dispatcher owns a fresh per-instance set.
    costDemotedPoolIds: injectedCostDemotedPoolIds ?? new Set(),
  };

  const inFlightTracker = new InFlightTokenTracker();
  const allResults: RollingDispatchResult<TPacket>[] = [];
  // Per-pool in-flight count for optional maxConcurrentPerPool cap.
  const inFlightPerPool: Map<string, number> = new Map();

  // Token-budget slope learning (per pool): remember the last-observed
  // remaining_pct per window label and the tokens dispatched since that reading,
  // so a completion whose pool snapshot has advanced can attribute Δtokens across
  // Δpercent and seed/update the learned tokens_per_pct slope. Degrade-safe: when
  // the snapshot hasn't moved (Δpercent below the floor) nothing is learned.
  interface SlopeBaseline {
    /** remaining_pct (0–1) per window label at the baseline reading. */
    pctByLabel: Map<string, number>;
    /** Tokens dispatched against this pool since the baseline reading. */
    tokensSinceBaseline: number;
  }
  const slopeBaselines: Map<string, SlopeBaseline> = new Map();

  function windowPctMap(pool: CapacityPool | undefined): Map<string, number> {
    const map = new Map<string, number>();
    const snap = pool?.quotaSourceSnapshot;
    if (!snap) return map;
    if (snap.windows && snap.windows.length > 0) {
      for (const w of snap.windows) {
        if (w.remaining_pct != null && Number.isFinite(w.remaining_pct)) {
          map.set(w.label, w.remaining_pct);
        }
      }
    } else if (snap.remaining_pct != null && Number.isFinite(snap.remaining_pct)) {
      map.set("default", snap.remaining_pct);
    }
    return map;
  }

  function ensureBaseline(poolId: string): void {
    if (slopeBaselines.has(poolId)) return;
    const pool = confirmedPools.find((p) => p.id === poolId);
    slopeBaselines.set(poolId, {
      pctByLabel: windowPctMap(pool),
      tokensSinceBaseline: 0,
    });
  }

  /**
   * Attribute the tokens dispatched since the baseline to whichever of the pool's
   * windows have MOVED, folding a slope sample per moved window. No-op when the
   * pool has no live snapshot or no window advanced. Re-baselines on any fold.
   */
  async function observeSlope(poolId: string, tokens: number): Promise<void> {
    const baseline = slopeBaselines.get(poolId);
    if (!baseline) return;
    baseline.tokensSinceBaseline += Math.max(0, tokens);
    const pool = confirmedPools.find((p) => p.id === poolId);
    const current = windowPctMap(pool);
    let foldedAny = false;
    for (const [label, priorPct] of baseline.pctByLabel) {
      const nowPct = current.get(label);
      if (nowPct == null) continue;
      if ((priorPct - nowPct) * 100 < 0.5) continue; // below MIN_SLOPE_DELTA_PERCENT
      try {
        await recordTokensPerPctObservation(
          poolId,
          label,
          priorPct,
          nowPct,
          baseline.tokensSinceBaseline,
        );
      } catch {
        // Non-fatal: slope learning must never abort dispatch.
      }
      foldedAny = true;
    }
    if (foldedAny) {
      slopeBaselines.set(poolId, { pctByLabel: current, tokensSinceBaseline: 0 });
      quotaStateCacheDirty = true;
    }
  }

  // Quota state cache — refreshed before each dispatch pass. The read is
  // deliberately lock-free: `writeQuotaState` renames a temp file over the
  // destination, so every reader observes a whole file, never a torn prefix.
  let quotaStateCache: QuotaState = emptyQuotaState();
  let quotaStateCacheDirty = true;
  let quotaStateUnavailableWarned = false;

  async function refreshQuotaStateIfNeeded(): Promise<void> {
    if (quotaStateCacheDirty) {
      try {
        quotaStateCache = await readQuotaState();
      } catch (error) {
        // The file exists but is unusable. Substituting an empty state here
        // would erase every cooldown and learned limit from the engine's view
        // — i.e. degrade FAIL-OPEN into unbounded dispatch. Keep the last
        // state we successfully read (cold start: still empty) and say so.
        if (!quotaStateUnavailableWarned) {
          quotaStateUnavailableWarned = true;
          process.stderr.write(
            `[rolling-dispatch] ${
              error instanceof Error ? error.message : String(error)
            }; retaining last-known quota state (${
              Object.keys(quotaStateCache.entries).length
            } entries)\n`,
          );
        }
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
    lease?: { leaseId: string; resourceKey: string } | null,
  ): void {
    // Remove from pending queue.
    state.pendingQueue = state.pendingQueue.filter((p) => p.id !== packet.id);

    ensureBaseline(slot.poolId);
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
      leaseId: lease?.leaseId ?? null,
      resourceKey: lease?.resourceKey,
    };

    state.inFlight.set(packet.id, entry);
  }

  /**
   * Admission gate over the shared reservation ledger (proactive admission layer,
   * spec/audit/dispatch-admission-control.md). Reserves the packet's output-envelope
   * cost against `slot.poolId`'s live budget BEFORE dispatch, atomically under the
   * ledger lock so a co-located peer's in-flight leases are visible and optimism is
   * bounded by ONE budget.
   *
   * Returns a discriminated result:
   *  - `no_ledger` — no ledger configured; dispatch unconditionally (behaviour
   *    identical to before the ledger existed).
   *  - `admitted` — carry the lease on the in-flight entry; reconciled on completion.
   *  - `blocked` — budget minus everyone's outstanding leases cannot cover this
   *    packet. `outstandingBefore` is the sum of OTHERS' (and this loop's own)
   *    live leases the ledger saw: `0` means nothing anywhere holds budget, so the
   *    single packet's cost exceeds the WHOLE budget and no completion will ever
   *    free room — the caller's liveness backstop force-admits it (the reactive 429
   *    floor still catches the overshoot). A non-zero value means a lease is
   *    outstanding and will free budget, so the caller waits instead of forcing.
   *
   * `forceUnbounded` overrides the pool budget with +Infinity so the backstop admit
   * always succeeds.
   */
  async function admitAgainstLedger(
    packet: RollingDispatchPacket<TPacket>,
    slot: ProviderSlot,
    forceUnbounded: boolean,
  ): Promise<
    | { status: "no_ledger" }
    | { status: "admitted"; lease: { leaseId: string; resourceKey: string } }
    | { status: "blocked"; outstandingBefore: number }
  > {
    if (!reservationLedger) return { status: "no_ledger" };
    const resourceKey = slot.poolId;
    const outputReservation = resolveOutputReservationFn?.(packet, slot.poolId) ?? 0;
    const cost = Math.max(0, packet.estimatedTokens) + Math.max(0, outputReservation);
    const budget = forceUnbounded
      ? Number.POSITIVE_INFINITY
      : resolvePoolBudget?.(slot.poolId) ?? Number.POSITIVE_INFINITY;
    const decision = await reservationLedger.admit({
      resourceKey,
      cost,
      budget,
      poolId: slot.poolId,
    });
    if (decision.admitted && decision.leaseId !== null) {
      return { status: "admitted", lease: { leaseId: decision.leaseId, resourceKey } };
    }
    return { status: "blocked", outstandingBefore: decision.outstandingBefore };
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

    // Reconcile the reservation lease (success OR failure — the request is no
    // longer in flight either way), returning its reserved budget to the shared
    // ledger so a co-located peer (or the next pass) can admit against it. The
    // real token cost surfaces in the provider's next quota snapshot; the ledger's
    // job is only to stop reserving it. Best-effort: a ledger failure must never
    // abort dispatch.
    if (reservationLedger && entry.leaseId && entry.resourceKey) {
      try {
        await reservationLedger.reconcile(entry.resourceKey, entry.leaseId);
      } catch {
        // Non-fatal: the lease's TTL expiry reclaims it if reconcile ever fails.
      }
    }

    state.inFlight.delete(packetId);

    // Record quota outcome. 'error' is a distinct quota outcome (a non-quota
    // failure — it leaves the 429 streak and cooldown alone); only 'rate_limited'
    // applies the backoff cooldown that throttles the exhausted pool.
    // The pool id IS the canonical (provider, account, model) quota key — record the
    // outcome under it so the reactive backoff state lands on the same entry
    // scheduling reads.
    const providerModelKey = providerSlot.poolId;
    const quotaOutcome = result.outcome === "success" ? "success"
      : result.outcome === "rate_limited" ? "rate_limited"
      : result.outcome === "error" ? "error"
      : "timeout" as const;

    try {
      await recordWaveOutcome(providerModelKey, { outcome: quotaOutcome });
    } catch {
      // Non-fatal: quota recording failure should not abort dispatch.
    }

    // Token-budget slope learning: attribute the tokens this packet consumed to
    // whichever of the pool's windows have advanced since the baseline reading,
    // seeding/refining the learned tokens_per_pct slope. No-op unless the pool's
    // live snapshot moved (degrade-safe).
    await observeSlope(providerSlot.poolId, estimatedTokens);

    quotaStateCacheDirty = true;

    // Transient-exhaustion recovery (INV-QD-07 / ARC-d81a55ab): a rate_limited
    // result is NOT a terminal completion. Drop the exhausted pool from the
    // active routing set and re-queue the packet so the next dispatch pass
    // re-selects a pool still within headroom. The packet is therefore neither
    // marked completed nor recorded as a result — it remains live work.
    if (result.outcome === "rate_limited") {
      // Host session-limit pause (piece D): when the worker's ERROR/STATUS
      // channel carried a session-limit string with a parseable wall-clock reset
      // (e.g. "You've hit your session limit · resets 1:50pm"), record a
      // POOL-level pause until that reset and DO NOT permanently exhaust the pool
      // — a near reset lets the same process re-dispatch after it passes, and the
      // reset feeds the retryable `quota_paused` terminal. A bare transient 429
      // (no reset) keeps the monotonic INV-QD-07 exhausted-pool re-route.
      const limitText = result.rateLimit?.text;
      const detection = limitText ? detectRateLimitError(limitText) : null;
      const resetAtMs =
        detection && detection.retryAfterMs != null
          ? Date.parse(computeCooldownUntil(detection.retryAfterMs))
          : null;
      if (resetAtMs != null && Number.isFinite(resetAtMs)) {
        // Stamp the parsed reset back onto the result so the consumer (and the
        // terminal) can surface it, then pause the pool until then.
        result.rateLimit = {
          ...result.rateLimit!,
          reset_at: new Date(resetAtMs).toISOString(),
        };
        const prior = state.pausedPoolResetAt.get(providerSlot.poolId);
        // Keep the LATEST reset if the pool re-limits with a farther wall.
        state.pausedPoolResetAt.set(
          providerSlot.poolId,
          prior != null ? Math.max(prior, resetAtMs) : resetAtMs,
        );
      } else {
        state.exhaustedPoolIds.add(providerSlot.poolId);
      }
      // Feed the host-session source FIRST (write side): a channel-isolated
      // recordLimit accrues the same-packet bounded re-limit count and may escalate
      // this packet — which the isPacketEscalated read below then observes in the
      // SAME pass. Best-effort; the source swallows its own failures.
      recordRateLimit?.(packet, result);
      // Bounded-escalation guard: if the host-session source has ESCALATED this
      // packet (its account wall re-tripped the SAME packet past the bound — an
      // unresettable / clock-skewed limit), re-queuing it would livelock. Strand
      // it instead so it surfaces via the empty-pool terminal (INV-QD-07's
      // stranding path), rather than re-routing into the wall forever. A
      // non-escalated packet keeps the normal transient-exhaustion re-route.
      if (isPacketEscalated?.(packet.id)) {
        if (!state.completedIds.has(packet.id)) state.strandedIds.add(packet.id);
        try {
          process.stderr.write(
            JSON.stringify({
              ts: new Date().toISOString(),
              kind: "rolling_dispatch_stranded_host_session_escalation",
              packet_id: packet.id,
              exhausted_pool_id: providerSlot.poolId,
            }) + "\n",
          );
        } catch {
          // Observability must never abort a run.
        }
        return;
      }
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

    // Reactive cost verification (arbitrage tier): a pool DECLARED free
    // (`declaredCostPerMtok === 0`) that reports a positive cost on a successful
    // completion has a falsified free-first claim — demote it (spill to fallback via
    // the degraded partition in selectProvider) so a stale `cost_per_mtok:0` can't
    // keep silently winning free-first fill. Fires the consumer's friction hook ONCE
    // per pool per drive (the set guards re-entry). Only `success` carries a cost;
    // a declared cost that is undefined (host pools) or positive is out of scope
    // (only free→charging), and a missing/zero observed cost is no signal.
    if (result.outcome === "success") {
      const servingPool = confirmedPools.find((p) => p.id === providerSlot.poolId);
      const declared = servingPool?.declaredCostPerMtok;
      const observed = result.observedCostUsd;
      if (
        declared === 0 &&
        typeof observed === "number" &&
        Number.isFinite(observed) &&
        observed > 0 &&
        !state.costDemotedPoolIds.has(providerSlot.poolId)
      ) {
        state.costDemotedPoolIds.add(providerSlot.poolId);
        try {
          onCostDrift?.({
            poolId: providerSlot.poolId,
            observedCostUsd: observed,
            declaredCostPerMtok: declared,
          });
        } catch {
          // Best-effort: a throwing friction hook must never abort dispatch.
        }
      }
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

  /**
   * True when NO pool can currently accept because every pool is either
   * permanently exhausted (bare 429) OR paused until a future session-limit reset
   * (piece D). Waiting the short transient tick cannot help — the remaining work
   * is stranded: `quota_paused` when at least one blocker is a reset pause (so the
   * strand stays retryable), else `empty_pool`.
   */
  function noPoolCanAcceptNow(now: number): boolean {
    return confirmedPools.every(
      (p) =>
        state.exhaustedPoolIds.has(p.id) ||
        (state.pausedPoolResetAt.get(p.id) ?? -Infinity) > now,
    );
  }

  /**
   * Earliest reset epoch-ms across all currently-paused pools (piece D), or null
   * when none is paused. Drives the `quota_paused` terminal's `earliest_reset_at`
   * and tells a resuming step how long to wait.
   */
  function earliestPausedResetMs(now: number): number | null {
    let earliest: number | null = null;
    for (const resetAt of state.pausedPoolResetAt.values()) {
      if (resetAt <= now) continue;
      if (earliest == null || resetAt < earliest) earliest = resetAt;
    }
    return earliest;
  }

  /** Move every still-pending packet into the stranded set and clear the queue. */
  function strandPending(): void {
    for (const packet of state.pendingQueue) {
      if (!state.completedIds.has(packet.id)) state.strandedIds.add(packet.id);
    }
    state.pendingQueue = [];
  }

  /**
   * One dispatch pass: select a pool for each dispatchable packet, gate it through
   * the reservation ledger (when configured), and dispatch the admitted ones.
   * Returns how many were dispatched.
   *
   * Liveness backstop: a packet the ledger BLOCKS with `outstandingBefore === 0`
   * has a cost exceeding the WHOLE pool budget while nothing anywhere holds a lease
   * to ever free room — the FIRST such packet per pass is admitted unbounded so the
   * run can never deadlock on a single over-budget packet (the reactive 429 floor
   * still catches the overshoot). A block with outstanding leases (`> 0`) means a
   * co-located peer or an in-flight packet will free budget, so it waits instead —
   * this is what stops two co-located loops from both force-admitting into overshoot.
   */
  async function dispatchPass(): Promise<number> {
    let dispatched = 0;
    let forcedUsed = false;
    for (const packet of getDispatchablePackets()) {
      // selectProvider skips pools in exhaustedPoolIds, so a re-queued packet
      // re-routes to a surviving pool (INV-QD-07).
      const slot = selectProvider(
        packet,
        confirmedPools,
        inFlightTracker,
        quotaStateCache.entries,
        sessionConfig,
        state.exhaustedPoolIds,
        state.pausedPoolResetAt,
        state.costDemotedPoolIds,
        Date.now(),
      );

      if (slot === null) continue;

      // Per-pool in-flight COUNT cap. The pool's own endpoint-declared cap
      // (`concurrencyCap`, e.g. a NIM worker's max-concurrency) and the global
      // `maxConcurrentPerPool` option are BOTH honoured — the effective ceiling is
      // the min of whichever are set. This is the throttle an optimistic (unmetered)
      // source needs: with no token budget to gate on, without it the pass would
      // dispatch every ready packet at once and overrun the endpoint (the NIM
      // `33/32` incident). A packet skipped here stays pending and a later pass
      // dispatches it once an in-flight slot frees.
      const poolConcurrencyCap = confirmedPools.find((p) => p.id === slot.poolId)?.concurrencyCap ?? null;
      const optionCap = options.maxConcurrentPerPool ?? null;
      const effectiveCap =
        poolConcurrencyCap != null && optionCap != null
          ? Math.min(poolConcurrencyCap, optionCap)
          : (poolConcurrencyCap ?? optionCap);
      // A cap of ≥1 gates; a non-positive cap is treated as NO cap (never zero-admit),
      // so a stray 0 can't wedge the engine into an infinite skip/no-progress spin.
      if (effectiveCap != null && effectiveCap >= 1 && (inFlightPerPool.get(slot.poolId) ?? 0) >= effectiveCap) {
        continue;
      }

      // Reservation-ledger admission (proactive layer).
      const admission = await admitAgainstLedger(packet, slot, false);
      let lease: { leaseId: string; resourceKey: string } | null = null;
      if (admission.status === "admitted") {
        lease = admission.lease;
      } else if (admission.status === "blocked") {
        if (admission.outstandingBefore === 0 && !forcedUsed && dispatched === 0) {
          // Single packet exceeds the whole budget with nothing holding a lease →
          // force it unbounded so the run can't deadlock. Only the first per pass.
          const forced = await admitAgainstLedger(packet, slot, true);
          if (forced.status === "admitted") {
            lease = forced.lease;
            forcedUsed = true;
          } else {
            continue;
          }
        } else {
          continue; // leave pending; a later pass admits once a lease frees.
        }
      }
      // status === "no_ledger" falls through with lease === null (dispatch as before).

      dispatchOnePacket(packet, slot, lease);
      dispatched++;
    }
    return dispatched;
  }

  async function run(): Promise<RollingDispatchResult<TPacket>[]> {
    while (state.pendingQueue.length > 0 || state.inFlight.size > 0) {
      // Dispatch pass: fill quota headroom with pending packets.
      await refreshQuotaStateIfNeeded();

      const dispatched = await dispatchPass();

      // If nothing is in flight and nothing was dispatched but pending work
      // remains, decide whether to wait or strand:
      //  - All pools exhausted → waiting cannot help; strand the remainder and
      //    surface an empty_pool terminal (INV-QD-07 / SEAM-rolling-stranding).
      //  - Otherwise this is a transient quota cooldown; yield briefly and retry.
      if (state.inFlight.size === 0 && dispatched === 0 && state.pendingQueue.length > 0) {
        // No pool can accept right now: every pool is exhausted (bare 429) or
        // paused until a future session-limit reset (piece D). Waiting the short
        // transient tick cannot help — strand the remainder and return so a later
        // step redispatches after the reset (NO in-process multi-hour sleep). The
        // terminal reason is chosen in getTerminal(): `quota_paused` (retryable)
        // when a reset pause is the blocker, else `empty_pool`.
        if (noPoolCanAcceptNow(Date.now())) {
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
    // Piece D: if any pool is paused until a session-limit reset, the strand is a
    // RETRYABLE `quota_paused` terminal carrying the earliest reset — the consumer
    // keeps the stranded items pending and a later step redispatches them clean.
    // Otherwise it is the pre-existing non-retryable `empty_pool` terminal.
    const earliest = earliestPausedResetMs(Date.now());
    if (earliest != null) {
      return buildQuotaPausedTerminal(
        [...state.strandedIds],
        new Date(earliest).toISOString(),
      );
    }
    return buildEmptyPoolTerminal([...state.strandedIds]);
  }

  return { enqueue, run, getState, getTerminal };
}
