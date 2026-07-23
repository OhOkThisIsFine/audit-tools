// Host-path admission loop — the tool-side "grant the admitted set" primitive of
// the dispatch admission-control model (spec/audit/dispatch-admission-control.md).
//
// The in-process rolling engine (rollingDispatch.ts) admits ONE packet at a time
// continuously; this is its host-subagent-path analog: at a dispatch step the tool
// admits a BATCH — as many packets as budget (and any declared in-flight cap) allow
// right now — reserving each against the shared ReservationLedger, and hands the
// host EXACTLY that granted set. The host dispatches the set, reports at
// result-ingest (merge-and-ingest), and the next `next-step` re-admits the
// remainder. The granted set's size is the instantaneous admission width — there is
// no computed concurrency number (spec: "concurrency is not a computed quantity").
//
// COST-FIRST ROUTING is a first-class property: each packet is routed to the
// CHEAPEST pool CAPABLE of it (cost-ascending among capable pools) that still has
// budget + in-flight-cap headroom, so lower-cost providers fill before pricier ones
// and overflow spills to the next-cheapest-capable pool. The capability gate and
// cost rank are inputs, so refining the complexity/risk gate is a one-predicate
// change, never a re-architecture.

import { z } from "zod";
import type { ConstraintOutcome, ReservationLedger } from "../quota/reservationLedger.js";
import { DISPATCH_LEASE_TTL_MS } from "../quota/reservationLedger.js";
import { estimatePacketCost } from "../quota/packetCost.js";
import type { DispatchCapacityPoolSummary } from "../quota/capacity.js";
import type { DispatchModelTier } from "../types/stepContract.js";
import type { WindowBudget } from "../quota/types.js";
import { windowConstraintsFor } from "../quota/windowConstraints.js";
import { deriveColdStartAdmissionBatch } from "../quota/scheduler.js";
import { tierRank } from "./tierRank.js";
import { deriveCostRank, lookupConfirmedPosition } from "./costRank.js";

/** One packet the admission loop may grant this pass. */
export interface AdmissionCandidate {
  id: string;
  /** Reservation cost = input estimate + output envelope (estimatePacketCost). */
  cost: number;
  /** Complexity in [0, 1] — the default capability gate's routing signal. */
  complexity: number;
  /**
   * The packet's minimum-capability floor (unified-routing step C): its dispatch
   * tier (`resolveDispatchTier` — risk/complexity-derived). A pool is eligible only
   * if its RELATIVE capability among the currently-available pools clears this
   * floor ({@link buildCapabilityFloorCapable}); a hard `deep` packet is never
   * routed to a bottom-band model just because it is free, idle, and fits context.
   * Absent ⇒ no floor (small), preserving legacy callers.
   */
  requiredTier?: DispatchModelTier;
}

/** One pool a packet may be routed to. */
export interface AdmissionPool {
  poolId: string;
  /**
   * ⚠ REPORTING ONLY — no longer what the lease keys to. Admission keys per WINDOW
   * ({@link windowBudgets}); this remains for the explain artifact's pool-level label.
   */
  resourceKey: string;
  /**
   * The MIN across the pool's windows. NOT the metering unit when
   * {@link windowBudgets} is populated — windows share no denominator, so a single
   * scalar cannot express "fits every applicable allowance", and admission meters per
   * window instead. It has TWO live uses beyond reporting, so it is not inert: the
   * cold-start batch sizer reads it as a rough magnitude, and it is the ceiling of the
   * fallback constraint when {@link windowBudgets} is EMPTY (no snapshot / cooldown).
   */
  budget: number;
  /**
   * The account this pool's credential belongs to — the partition an `account`-scoped
   * window's allowance is shared across. Two models on one credential MUST produce the
   * same value; that identity is what stops N models from each admitting against their
   * own copy of one allowance.
   */
  accountKey: string;
  /**
   * Every window this pool must fit inside, each in its own unit — the METERING basis.
   * Empty ⇒ no live signal (no snapshot, or the cooldown path), and admission falls
   * back to ONE pool-keyed constraint carrying {@link budget} as its ceiling.
   */
  windowBudgets: WindowBudget[];
  /** Declared hard in-flight cap (e.g. Codex's 6), passed verbatim. null ⇒ none. */
  declaredCap: number | null;
  /** Cost rank — LOWER is cheaper; the loop routes cheapest-capable-first. */
  costRank: number;
  /** Capability rank — HIGHER is more capable; ties break toward more capable. */
  capabilityRank: number;
  /**
   * Raw per-`(provider,model)` capability score (registry `composite_rank`) — LOWER
   * is more capable, the inverse convention of {@link capabilityRank}. A FINER tiebreak
   * consulted only AFTER the coarse tier ordinal, so it reorders only among cost-equal
   * pools that also share a tier (e.g. many proxy-sourced models on the neutral fallback
   * tier). null/absent ⇒ no finer signal; a present score sorts before an absent one
   * within that tie. Never reorders against cost or tier.
   */
  capabilityScore?: number | null;
  /**
   * Throughput rank for the cost↔speed dial — the pool's effective PARALLELISM (higher
   * = faster; `+Infinity` = hardware-parallel). Consulted only when λ > 0. Derived
   * pool-class-aware by {@link deriveThroughputConcurrency} at the build site — a
   * backend source's uncapped default is `+Infinity` (parallel) while the conversation
   * host's unspecified default is `1` (sequential), so `declaredCap`'s ambiguous `null`
   * sentinel is NOT reused for the rank. See spec/dispatch-cost-speed-dial.md.
   */
  throughputConcurrency: number;
  /** Largest packet cost this pool can fit (context window − output). */
  capacityTokens: number;
  /**
   * Cold-start calibration (see WaveSchedule.calibrating): at least one binding window
   * has no real token budget derived yet (no absolute count, no learned slope). When
   * true, {@link admitBatch} caps this pool's GRANT via
   * {@link deriveColdStartAdmissionBatch} — sized to `budget` when `budget` is still a
   * real finite number (a SIBLING window is the uncalibrated one), else the small
   * slope-learning probe — so the host-path fan-out cannot grant the whole frontier
   * before the tokens-per-percent slope is observed. The grant obeys this, whereas the
   * scheduler's `max_concurrent` clamp (which the host ignores) does not.
   */
  calibrating?: boolean;
}

/**
 * Derive a pool's throughput rank (effective parallelism) pool-class-aware — the fix
 * for the `declaredCap == null` ambiguity (spec/dispatch-cost-speed-dial.md): the same
 * "no cap" sentinel means opposite speeds on the two pool classes, so throughput cannot
 * be read off `declaredCap` alone.
 *
 * - **Backend source** (an endpoint that accepts concurrent requests): an uncapped
 *   source is hardware-parallel ⇒ `+Infinity` (fastest); a declared `max_concurrent`
 *   ⇒ that count.
 * - **Conversation host**: its parallelism IS its subagent budget; unspecified ⇒ the
 *   host is effectively SEQUENTIAL ⇒ `1` (ranks slowest), NOT unbounded. This is what
 *   stops λ=1 from crowning the default zero-declaration host over a metered parallel
 *   source — with no manual declaration.
 */
export function deriveThroughputConcurrency(params: {
  isConversationHost: boolean;
  hostActiveSubagents?: number | null;
  sourceConcurrencyCap?: number | null;
}): number {
  if (params.isConversationHost) {
    return params.hostActiveSubagents ?? 1;
  }
  return params.sourceConcurrencyCap ?? Number.POSITIVE_INFINITY;
}

/**
 * Build the admission pool set from the serializable per-pool capacity summaries —
 * the SINGLE source of truth both orchestrators use (audit summarizes its dispatch
 * capacity; remediate passes `schedule.capacity_pools`), so the two cannot drift on
 * how a pool maps to an {@link AdmissionPool}. Every field is derived here once:
 * budget (optimistic `+Infinity` when no live ceiling), the hard in-flight cap
 * (`declaredCap` — host subagent budget OR endpoint `max_concurrent`), cost rank
 * (with the operator-confirmed position as rung 1; spec/cost-first-routing.md), the
 * capability tier ordinal, the throughput rank (pool-class-aware concurrency;
 * spec/dispatch-cost-speed-dial.md), and the context-window fit ceiling.
 */
export function admissionPoolsFromSummaries(
  summaries: readonly DispatchCapacityPoolSummary[],
  confirmedCostPositions?: Map<string, number> | null,
): AdmissionPool[] {
  return summaries.map((pool) => ({
    poolId: pool.pool_id,
    resourceKey: pool.pool_id,
    budget: pool.remaining_token_budget ?? Number.POSITIVE_INFINITY,
    accountKey: pool.account_key,
    windowBudgets: (pool.window_budgets ?? []).map((w) => ({
      scope: w.scope,
      label: w.label,
      budget: w.budget,
      unit: w.unit,
      ...(w.tokens_per_pct != null ? { tokensPerPct: w.tokens_per_pct } : {}),
      reset_at: w.reset_at,
    })),
    declaredCap: pool.host_concurrency_limit?.active_subagents ?? pool.concurrency_cap ?? null,
    costRank: deriveCostRank({
      model: pool.model,
      tier: pool.rank,
      declaredCostPerMtok: pool.declared_cost_per_mtok,
      confirmedPosition: lookupConfirmedPosition(confirmedCostPositions, pool.model),
    }),
    capabilityRank: tierRank(pool.rank),
    capabilityScore: pool.capability_rank ?? null,
    throughputConcurrency: deriveThroughputConcurrency({
      isConversationHost: pool.is_conversation_host,
      hostActiveSubagents: pool.host_concurrency_limit?.active_subagents,
      sourceConcurrencyCap: pool.concurrency_cap,
    }),
    // ONE fit predicate on both dispatch paths (unified-routing step B): a source
    // pool's own effective window (`context_cap_tokens`, non-null since step A)
    // outranks the wave's resolved limits — previously the host-admission path gated
    // every pool against the HOST's window, so a small-context source pool admitted
    // packets it could never serve (413 instead of skip). Host pools carry no
    // `context_cap_tokens` and fall through to their real resolved window.
    capacityTokens: pool.context_cap_tokens ?? pool.resolved_limits.context_tokens,
    calibrating: pool.calibrating === true,
  }));
}

/**
 * One constraint's evaluation, serialized for the persisted explain artifact —
 * the wire form of the ledger's {@link ConstraintOutcome} (legibility invariant,
 * spec/audit/dispatch-admission-control.md Resolved decision 3).
 *
 * `headroom_before: null` means UNBOUNDED, not unknown — a cold-start pool with
 * no real ceiling computes `headroomBefore = +Infinity`, which `JSON.stringify`
 * (the artifact's actual emit path) collapses to `null`; `.number()` alone
 * rejects that on read-back even though it accepts `Infinity` in memory, so
 * `null` is the honest encoding of what the artifact actually contains on disk.
 */
export const ConstraintOutcomeRecordSchema = z
  .object({
    resource_key: z.string(),
    headroom_before: z.number().nullable(),
    outstanding_before: z.number(),
    cost: z.number(),
    /** Whether this constraint alone had room. Admission requires ALL true. */
    cleared: z.boolean(),
  })
  .strict();
export type ConstraintOutcomeRecord = z.infer<typeof ConstraintOutcomeRecordSchema>;

/** Serialize ledger outcomes for the artifact (non-finite headroom → null). */
export function toConstraintOutcomeRecords(
  outcomes: readonly ConstraintOutcome[],
): ConstraintOutcomeRecord[] {
  return outcomes.map((o) => ({
    resource_key: o.resourceKey,
    headroom_before: Number.isFinite(o.headroomBefore) ? o.headroomBefore : null,
    outstanding_before: o.outstandingBefore,
    cost: o.cost,
    cleared: o.cleared,
  }));
}

/**
 * One NON-decisive pool consultation during a packet's admission walk — a pool
 * that was tried and refused before the decision landed elsewhere (the decisive
 * pool's data lives on the explain record itself, never duplicated here). The
 * refusal vocabulary is shared with {@link AdmissionExplain.reason} so one
 * parser covers both.
 */
export const AdmissionAttemptSchema = z
  .object({
    pool_id: z.string(),
    reason: z.enum(["budget_exhausted", "cap_reached", "window_uncalibrated"]),
    /** Ledger outcomes when the attempt reached the ledger; [] otherwise. */
    constraints: z.array(ConstraintOutcomeRecordSchema),
    /** cap_reached only: the in-flight count and cap that refused. */
    in_flight_before: z.number().optional(),
    cap: z.number().optional(),
    /** window_uncalibrated only: labels of the windows that could not price. */
    unpriced_windows: z.array(z.string()).optional(),
  })
  .strict();
export type AdmissionAttempt = z.infer<typeof AdmissionAttemptSchema>;

/** A successful admission: one packet leased to one pool. */
export interface AdmissionGrant {
  packet_id: string;
  pool_id: string;
  /**
   * EVERY resource key the lease was recorded under (deduped, in constraint
   * order) — never one of N. Diagnostic provenance only: `reconcile(leaseId)`
   * sweeps every key itself, so no caller needs this to release the lease.
   */
  resource_keys: string[];
  lease_id: string;
  cost: number;
}

export const AdmissionGrantSchema = z
  .object({
    packet_id: z.string(),
    pool_id: z.string(),
    resource_keys: z.array(z.string()),
    lease_id: z.string(),
    cost: z.number(),
  })
  .strict();

/**
 * Why a packet was admitted or blocked — the per-admission explain record.
 * Carries the FULL constraint-outcome array the decision was taken against
 * (every key consulted, its headroom before, the packet's cost against it,
 * which key refused) plus the non-decisive walk trail — never a one-of-N
 * scalar that looks authoritative while being partial
 * ([[write-only-data-looks-authoritative]]).
 */
export const AdmissionExplainSchema = z
  .object({
    packet_id: z.string(),
    /** null when NO pool was capable, or on a plan-only (`planned`) grant. */
    pool_id: z.string().nullable(),
    admitted: z.boolean(),
    reason: z.enum([
      "admitted",
      // Plan-only display grant (`grantLeases: false`): the in-process rolling
      // engine leases per-packet at dispatch time and records its decisions in
      // the engine decision log — no lease exists for this record, by design.
      "planned",
      "no_capable_pool",
      "budget_exhausted",
      "cap_reached",
      "packet_oversized",
      // A window that APPLIES to the packet has no learned tokens-per-percent slope,
      // so it cannot price the draw. Distinct from budget_exhausted: nothing ran
      // out, the pool is still calibrating — telling the operator the budget is gone
      // would be a false report of a wall that does not exist.
      "window_uncalibrated",
    ]),
    /**
     * The DECISIVE attempt's full constraint-outcome array: on a grant, the
     * successful admit's; on a ledger refusal, the refusing decision's. Empty
     * when the ledger was never reached (no_capable_pool / cap_reached /
     * window_uncalibrated / planned / packet_oversized).
     */
    constraints: z.array(ConstraintOutcomeRecordSchema),
    /**
     * The tightest (or refusing) constraint of the decisive attempt — the
     * binding window a report should name, as its full outcome row. Null when
     * the ledger was never reached.
     */
    binding: ConstraintOutcomeRecordSchema.nullable(),
    /** Pools consulted and refused BEFORE the decision, in walk order. */
    attempts: z.array(AdmissionAttemptSchema),
    /** cap_reached refusal only: the in-flight count and cap that refused. */
    in_flight_before: z.number().optional(),
    cap: z.number().optional(),
    /** window_uncalibrated refusal only: labels of the unpriceable windows. */
    unpriced_windows: z.array(z.string()).optional(),
    cost: z.number(),
  })
  .strict();
export type AdmissionExplain = z.infer<typeof AdmissionExplainSchema>;

/**
 * The admission artifact both orchestrators embed in their dispatch-quota contract,
 * REPLACING the removed `max_concurrent_agents` scalar. `granted_packet_ids` is the
 * set the host dispatches this step (its size is the emergent admission width);
 * `declared_cap` is the verbatim per-environment hard in-flight cap (null when
 * none); `leases` are reconciled (freed) at result-ingest; `explains` reconstruct
 * why the fan-out was the width it was.
 */
export const DispatchAdmissionSchema = z
  .object({
    granted_packet_ids: z.array(z.string()),
    declared_cap: z.number().int().min(1).nullable(),
    leases: z.array(AdmissionGrantSchema),
    explains: z.array(AdmissionExplainSchema),
  })
  .strict();
export type DispatchAdmission = z.infer<typeof DispatchAdmissionSchema>;

/** Outcome of one admission pass. */
export interface AdmitBatchResult {
  granted: AdmissionGrant[];
  explains: AdmissionExplain[];
  /** Packet ids not admitted this pass — deferred to a later grant (re-invoke). */
  blocked: string[];
}

export interface AdmitBatchInput {
  /** Candidate packets in PRIORITY order (highest-priority first). */
  packets: AdmissionCandidate[];
  pools: AdmissionPool[];
  ledger: ReservationLedger;
  /**
   * Capability gate: may this pool handle this packet? Defaults to a size fit
   * (`pool.capacityTokens >= packet.cost`) — a grounded, provider-neutral gate. A
   * caller refines the complexity/risk gate by supplying its own predicate (the
   * intended extension point for cost/capability routing policy).
   */
  capable?: (pool: AdmissionPool, packet: AdmissionCandidate) => boolean;
  /**
   * Lease lifetime for this batch's grants; defaults to the ledger's own TTL
   * (`STALE_LOCK_MS`). Grants that outlive a state mutation — a host-subagent
   * wave, an in-process packet run — must pass a dispatch-length TTL
   * ({@link DISPATCH_LEASE_TTL_MS}) or the lease expires mid-flight and a
   * concurrent admitter double-grants the account (budget AND cap-count axes).
   */
  leaseTtlMs?: number;
  /**
   * Cost↔speed dispatch bias (λ) ∈ [0, 1] — the operator-set operating point on the
   * cost-vs-throughput frontier among capable pools (spec/dispatch-cost-speed-dial.md).
   * λ=0 (default) is pure cost-first — byte-identical to the pre-dial ordering. λ=1 is
   * pure throughput (fastest-capable-first). 0<λ<1 blends the two axes' ordinals.
   * Out-of-range values clamp to [0, 1].
   */
  dispatchBias?: number;
}

/** Default capability gate: the pool's window must fit the packet's reservation. */
function defaultCapable(pool: AdmissionPool, packet: AdmissionCandidate): boolean {
  if (!Number.isFinite(pool.capacityTokens) || pool.capacityTokens <= 0) return true;
  return pool.capacityTokens >= packet.cost;
}

/**
 * Build the composed capability gate (unified-routing step C): size-fit AND a
 * RELATIVE per-packet capability floor over the currently-available pool set.
 *
 * Relative, never absolute (the "never a named-model→tier map" invariant): pools
 * with a known per-model `capabilityScore` (registry/leaderboard composite_rank,
 * LOWER = better) are banded into terciles among the SCORED pools — band 0 = top
 * third. A pool with no score but a NON-NEUTRAL tier ordinal maps ordinal→band
 * (deep→0, small→2). A pool with neither signal (score null + neutral ordinal —
 * e.g. a proxy pool the leaderboard didn't match) is UNKNOWN and **fails open**
 * (owner decision 2026-07-17): it stays eligible for every floor, and `onFailOpen`
 * records the low-confidence routing so the choice is observable — fail-closed
 * would reproduce the host-only collapse whenever no pool carries capability data.
 *
 * Floor: `deep` ⇒ band 0 only; `standard` ⇒ bands 0–1; `small`/absent ⇒ all.
 * Composed over the size-fit gate, so supplying this predicate never loses the
 * context-window check. Proxy-agnostic by construction — it reads only the pool's
 * own `capabilityScore`/`capabilityRank` fields, never a transport's catalog
 * ([[litellm-replaces-repair-proxy]]).
 */
export interface CapabilityFailOpenInfo {
  poolId: string;
  packetId: string;
  requiredTier: DispatchModelTier;
}

/**
 * {@link buildCapabilityFloorCapable} with the per-(pool, packet) de-duplication its
 * reporters all need — the predicate is re-evaluated as the loop rescans, so a raw
 * `onFailOpen` fires repeatedly for one routing decision.
 *
 * Single-sourced because the dedup was audit's alone: remediate passed no reporter at
 * all, so on that draw an unranked pool admitting `deep` work was completely SILENT —
 * and silence is exactly what let the unwired `marshal.ts` schedule go unnoticed. Both
 * draws now report through one core ([[dissolve-auditor-remediator-distinction]]); a
 * fail-open is a routing fact, not an audit-only concern.
 */
export function buildObservedCapabilityFloorCapable(
  pools: readonly AdmissionPool[],
  onFailOpen: (info: CapabilityFailOpenInfo) => void,
): (pool: AdmissionPool, packet: AdmissionCandidate) => boolean {
  const seen = new Set<string>();
  return buildCapabilityFloorCapable(pools, (info) => {
    // Structured key: pool and packet ids are opaque strings, so a printable separator
    // could occur inside one and collide two distinct pairs into a single key —
    // silently suppressing a real fail-open report. JSON of the pair cannot collide.
    const key = JSON.stringify([info.poolId, info.packetId]);
    if (seen.has(key)) return;
    seen.add(key);
    onFailOpen(info);
  });
}

export function buildCapabilityFloorCapable(
  pools: readonly AdmissionPool[],
  onFailOpen?: (info: CapabilityFailOpenInfo) => void,
  isAvailable?: (poolId: string) => boolean,
): (pool: AdmissionPool, packet: AdmissionCandidate) => boolean {
  // Tercile-band the scored pools once per batch (deterministic: score asc, poolId tiebreak).
  const scored = pools
    .filter((p) => typeof p.capabilityScore === "number" && Number.isFinite(p.capabilityScore))
    .sort(
      (a, b) =>
        (a.capabilityScore as number) - (b.capabilityScore as number) ||
        a.poolId.localeCompare(b.poolId),
    );
  const scoreBand = new Map<string, number>();
  scored.forEach((p, i) => {
    scoreBand.set(p.poolId, Math.floor((3 * i) / scored.length));
  });
  const NEUTRAL_ORDINAL = tierRank(undefined); // the fallback tier — carries no information
  const bandOf = (pool: AdmissionPool): number | null => {
    const fromScore = scoreBand.get(pool.poolId);
    if (fromScore !== undefined) return fromScore;
    // No score: a non-neutral ordinal is a real declared/roster rank → coarse band.
    // (A genuinely-DECLARED `standard` rank is indistinguishable from the fallback
    // here — both are the neutral ordinal — so declared-standard pools are treated
    // as unknown/fail-open. Deliberate: representing "declared vs defaulted" would
    // need rank provenance on the summary; fail-open is the safe direction.)
    if (pool.capabilityRank !== NEUTRAL_ORDINAL) return 2 - Math.min(pool.capabilityRank, 2);
    return null; // unknown — fail open
  };
  // The batch's BEST available band — the floor is RELATIVE all the way down
  // (C-review F3): `deep` means "the most capable band available", not "band 0 or
  // nothing". Without this, an all-small ordinal roster gives every deep packet an
  // empty candidate set → a `no_capable_pool` wall that step E rightly calls
  // structural/permanent — a livelock the floor itself manufactured. The scored
  // path already behaves this way (n=1 scored pool = band 0 by construction).
  //
  // "Available" is LIVE, not a build-time snapshot (zero-spill fix, live incident
  // 2026-07-22): when the caller supplies `isAvailable`, the best band is
  // re-derived per evaluation over pools still available. A static snapshot kept
  // holding the floor at a 429-exhausted pool's band, so every surviving
  // lower-band sibling failed `capable` and ~140 packets stranded as
  // `no_fitting_pool` without one sibling attempt. Without the callback (host
  // admission path — pools are re-banded per batch) behavior is unchanged. If
  // every banded pool is unavailable the floor goes inert (fail-open) — the
  // availability filters exclude those pools regardless, and a floor with no
  // live reference point has no signal to give.
  const bandedPools = pools
    .map((p) => ({ poolId: p.poolId, band: bandOf(p) }))
    .filter((e): e is { poolId: string; band: number } => e.band !== null);
  const anyBanded = bandedPools.length > 0;
  const bestAvailableBand = (): number => {
    const available = bandedPools.filter((e) => isAvailable?.(e.poolId) !== false);
    if (available.length === 0) return anyBanded ? Number.POSITIVE_INFINITY : 0;
    return Math.min(...available.map((e) => e.band));
  };
  const FLOOR_MAX_BAND: Record<DispatchModelTier, number> = { deep: 0, standard: 1, small: 2 };
  return (pool, packet) => {
    if (!defaultCapable(pool, packet)) return false;
    const tier = packet.requiredTier;
    if (!tier || tier === "small") return true;
    const band = bandOf(pool);
    if (band === null) {
      // Unknown capability: fail-open, never a block. Record it ONLY when the batch
      // has at least one banded pool (C-review F2) — with zero capability data the
      // floor is globally inert and there is no routing choice to flag; recording
      // would spam a warning per packet on every ordinary single-host wave.
      if (anyBanded) {
        onFailOpen?.({ poolId: pool.poolId, packetId: packet.id, requiredTier: tier });
      }
      return true;
    }
    return band <= Math.max(FLOOR_MAX_BAND[tier], bestAvailableBand());
  };
}

/**
 * The in-process engine's draw over the ONE capability-floor implementation
 * ({@link buildCapabilityFloorCapable}) — adapts the engine's `CapacityPool` shape
 * (F4) via the same signals the admission summaries carry (`rank` → tier ordinal,
 * `declaredCapabilityRank` → raw score), so the engine and the host path band
 * pools identically and cannot drift. Size-fit stays the engine's own
 * `doesNotFitContext` gate, so the stub's `capacityTokens` is +Infinity (inert
 * here). Fail-open all the way down: an unknown pool id, like unknown capability,
 * never blocks.
 */
export function buildCapacityPoolCapabilityFloor(
  pools: readonly {
    id: string;
    rank?: DispatchModelTier;
    declaredCapabilityRank?: number | null;
  }[],
  onFailOpen?: (info: { poolId: string; packetId: string; requiredTier: DispatchModelTier }) => void,
  isAvailable?: (poolId: string) => boolean,
): (poolId: string, packet: { id: string; requiredTier?: DispatchModelTier }) => boolean {
  // Capability-gate stubs only — these never reach `admit`, so the metering fields
  // are inert placeholders rather than a second (drifting) derivation of them.
  const stubs: AdmissionPool[] = pools.map((p) => ({
    poolId: p.id,
    resourceKey: p.id,
    budget: Number.POSITIVE_INFINITY,
    accountKey: p.id,
    windowBudgets: [],
    declaredCap: null,
    costRank: 0,
    capabilityRank: tierRank(p.rank),
    capabilityScore: p.declaredCapabilityRank ?? null,
    throughputConcurrency: Number.POSITIVE_INFINITY,
    capacityTokens: Number.POSITIVE_INFINITY,
  }));
  const byId = new Map(stubs.map((s) => [s.poolId, s]));
  const floor = buildCapabilityFloorCapable(stubs, onFailOpen, isAvailable);
  return (poolId, packet) => {
    const stub = byId.get(poolId);
    if (!stub) return true; // pool outside the banded set — no signal, fail open
    return floor(stub, {
      id: packet.id,
      cost: 0,
      complexity: 0,
      ...(packet.requiredTier ? { requiredTier: packet.requiredTier } : {}),
    });
  };
}

/**
 * Finer capability tiebreak on the raw registry score (LOWER = more capable), consulted
 * only after the coarse tier ordinal has tied. A present score sorts before an absent
 * one; both absent ⇒ 0 (fall through to the next tiebreak). Never a primary axis — it
 * only refines cost-equal, same-tier pools (e.g. proxy-sourced models on one tier).
 */
function capabilityScoreCmp(a: AdmissionPool, b: AdmissionPool): number {
  const av = typeof a.capabilityScore === "number" && Number.isFinite(a.capabilityScore) ? a.capabilityScore : null;
  const bv = typeof b.capabilityScore === "number" && Number.isFinite(b.capabilityScore) ? b.capabilityScore : null;
  if (av !== null && bv !== null) return av - bv; // lower = more capable, sorts first
  if (av !== null) return -1; // present before absent
  if (bv !== null) return 1;
  return 0;
}

/** Cost-first order: cheapest first, ties toward the more capable pool (tier, then raw score). */
function costFirstCmp(a: AdmissionPool, b: AdmissionPool): number {
  return a.costRank - b.costRank || b.capabilityRank - a.capabilityRank || capabilityScoreCmp(a, b);
}

/** Deterministic tiebreak so equal-key orderings are stable across processes. */
function poolIdCmp(a: AdmissionPool, b: AdmissionPool): number {
  return a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0;
}

/** Descending throughput (effective parallelism); `+Infinity`-safe (Inf−Inf = NaN). */
function speedFirstCmp(a: AdmissionPool, b: AdmissionPool): number {
  const ta = a.throughputConcurrency;
  const tb = b.throughputConcurrency;
  if (ta !== tb) {
    if (ta === Number.POSITIVE_INFINITY) return -1;
    if (tb === Number.POSITIVE_INFINITY) return 1;
    return tb - ta;
  }
  return b.capabilityRank - a.capabilityRank || capabilityScoreCmp(a, b) || poolIdCmp(a, b);
}

/**
 * Order the capable pools for one packet at the operating point `bias` (λ).
 *
 * λ=0 (or a single candidate) ⇒ the exact pre-dial cost-first order. Otherwise blend
 * the two axes' ORDINALS within this candidate set — a $/Mtok cost value cannot be
 * linearly mixed with a tokens/min rate, so each axis contributes its dense integer
 * rank, keeping a well-defined total order (spec/dispatch-cost-speed-dial.md).
 */
function orderCandidates(pools: AdmissionPool[], bias: number): AdmissionPool[] {
  const ordered = pools.slice();
  if (bias <= 0 || ordered.length <= 1) {
    return ordered.sort(costFirstCmp);
  }
  const costOrdinal = new Map<string, number>();
  ordered
    .slice()
    .sort((a, b) => costFirstCmp(a, b) || poolIdCmp(a, b))
    .forEach((pool, i) => costOrdinal.set(pool.poolId, i));
  const speedOrdinal = new Map<string, number>();
  ordered
    .slice()
    .sort(speedFirstCmp)
    .forEach((pool, i) => speedOrdinal.set(pool.poolId, i));
  const blended = (pool: AdmissionPool): number =>
    (1 - bias) * (costOrdinal.get(pool.poolId) ?? 0) + bias * (speedOrdinal.get(pool.poolId) ?? 0);
  return ordered.sort(
    (a, b) => blended(a) - blended(b) || b.capabilityRank - a.capabilityRank || costFirstCmp(a, b) || poolIdCmp(a, b),
  );
}

/**
 * Admit as many packets as budget + declared caps allow this pass, routing each to
 * the cheapest capable pool with headroom. Every admission RESERVES the packet's
 * cost against the shared ledger under its lock, so co-located dispatch loops on one
 * account cannot collectively over-admit. Returns the granted set (the host
 * dispatches exactly these), the explain trail, and the blocked remainder.
 *
 * A pool's declared in-flight cap is enforced by COUNT of its outstanding ledger
 * leases (cross-process) plus this batch's grants — the only place an explicit
 * agent-count exists (a verbatim environment limit), never a computed concurrency.
 */
export async function admitBatch(input: AdmitBatchInput): Promise<AdmitBatchResult> {
  const capable = input.capable ?? defaultCapable;
  // Clamp λ into [0,1] AND coerce a non-finite (NaN/±Infinity) input to the cost-first
  // default — this is the single ordering chokepoint, so it must never emit a NaN
  // comparator regardless of caller (callers also pre-clamp; this is the enforced floor).
  const rawBias = input.dispatchBias ?? 0;
  const bias = Number.isFinite(rawBias) ? Math.min(1, Math.max(0, rawBias)) : 0;
  const granted: AdmissionGrant[] = [];
  const explains: AdmissionExplain[] = [];
  const blocked: string[] = [];

  // Seed per-pool in-flight COUNT from the ledger (other consumers' live leases),
  // so a declared cap accounts for cross-process in-flight, then add this batch's.
  //
  // ⚠ Count DISTINCT lease ids, not lease rows. A multi-constraint admission writes
  // one row PER WINDOW under the same lease id, so counting rows would divide a
  // pool's declared cap by its window count (a 2-window account pool with a declared
  // cap of 4 would admit 2). The cap is a COUNT OF IN-FLIGHT REQUESTS and must be
  // passed verbatim regardless of how many allowances each request meters against.
  const countByPool = new Map<string, number>();
  try {
    const snapshot = await input.ledger.snapshot();
    const seenByPool = new Map<string, Set<string>>();
    for (const leases of Object.values(snapshot)) {
      for (const lease of leases) {
        let seen = seenByPool.get(lease.poolId);
        if (!seen) {
          seen = new Set<string>();
          seenByPool.set(lease.poolId, seen);
        }
        seen.add(lease.leaseId);
      }
    }
    for (const [poolId, seen] of seenByPool) countByPool.set(poolId, seen.size);
  } catch {
    // Degrade-safe: an unreadable ledger just means cap counting starts at 0.
  }

  for (const packet of input.packets) {
    // Capability is a hard floor (filter), then order the survivors at the operating
    // point λ: cost-first at λ=0 (default, unchanged), sliding toward throughput-first
    // as λ→1. Spill still walks this order to the next pool with headroom.
    const candidates = orderCandidates(
      input.pools.filter((pool) => capable(pool, packet)),
      bias,
    );

    if (candidates.length === 0) {
      explains.push({
        packet_id: packet.id,
        pool_id: null,
        admitted: false,
        reason: "no_capable_pool",
        constraints: [],
        binding: null,
        attempts: [],
        cost: packet.cost,
      });
      blocked.push(packet.id);
      continue;
    }

    let placed = false;
    let lastReason: AdmissionExplain["reason"] = "budget_exhausted";
    let lastPool = candidates[0]!;
    // The refused-consultation trail (legibility): every pool the walk tried and
    // passed over, with why — the decisive pool's data lands on the explain
    // record itself, never duplicated here.
    const attempts: AdmissionAttempt[] = [];
    // The decisive ledger decision on a total refusal (the LAST pool's), so the
    // explain carries the full constraint-outcome array it was decided on.
    let lastDecision: { constraints: ConstraintOutcomeRecord[]; binding: ConstraintOutcomeRecord | null } | null =
      null;
    for (const pool of candidates) {
      // Effective in-flight cap = the declared hard cap, TIGHTENED at cold start to a
      // TOKEN-AWARE calibration batch (never a flat magic count). `pool.budget` is
      // `remaining_token_budget ?? +Infinity` (apiPool.ts): when it is still a real
      // finite number (a SIBLING window is the uncalibrated one), size the batch to
      // what conservatively fits THIS packet's own cost estimate; when it is
      // genuinely +Infinity (no window has any real budget yet — e.g. a percent-only
      // quota source pre-slope), fall back to the small slope-learning probe. Without
      // this the host grant would fan out the ENTIRE frontier — at arbitrary per-packet
      // size — before the tokens-per-percent slope can be observed: the scheduler's
      // `max_concurrent` cold-start clamp does NOT reach the grant, which is what the
      // host actually obeys. Only affects `grantLeases:true` (host path); the in-process
      // driver returns before admitBatch.
      const coldStartBatch = pool.calibrating
        ? deriveColdStartAdmissionBatch({ availableBudget: pool.budget, perPacketTokenEstimate: packet.cost })
        : null;
      const effectiveCap =
        coldStartBatch != null ? Math.min(pool.declaredCap ?? coldStartBatch, coldStartBatch) : pool.declaredCap;
      if (effectiveCap != null && (countByPool.get(pool.poolId) ?? 0) >= effectiveCap) {
        attempts.push({
          pool_id: pool.poolId,
          reason: "cap_reached",
          constraints: [],
          in_flight_before: countByPool.get(pool.poolId) ?? 0,
          cap: effectiveCap,
        });
        lastReason = "cap_reached";
        lastPool = pool;
        lastDecision = null;
        continue;
      }
      // Reserve against EVERY window this pool must fit inside — the account-scoped
      // ones shared with sibling models on the same credential, plus any scoped to
      // this model alone. This is where N models on one account stop each admitting
      // against their own copy of one allowance — PROVIDED the pools carry a shared
      // , which is decided at the producer () and
      // merely consumed here. A pool whose source cannot be attributed to a credential
      // falls back to metering alone.
      const { constraints, unpriced } = windowConstraintsFor(
        pool.poolId,
        pool.accountKey,
        pool.windowBudgets,
        packet.cost,
        pool.budget,
      );
      if (unpriced.length > 0) {
        // A window that cannot price this draw (percent window, no learned slope) must
        // NOT be dropped from the set — admitting on the remaining constraints would
        // meter the packet against fewer allowances than actually apply to it, which is
        // the fail-open direction. Reported as its own reason: nothing is exhausted.
        //
        // ⚠ NOT reachable from the in-repo producer: deriveTokenBudget drops an
        // unpriceable window BEFORE it enters window_budgets and sets 
        // instead, so every emitted percent window carries a positive slope. This
        // guards a summary arriving over the WIRE, where  is
        // schema-optional. Keep it fail-CLOSED: if it ever became producer-reachable
        // for a calibrating pool it would livelock (blocked ⇒ no dispatch ⇒ no delta
        // sample ⇒ no slope ⇒ blocked), so that producer change must come with a
        // calibration escape, not a relaxation here.
        attempts.push({
          pool_id: pool.poolId,
          reason: "window_uncalibrated",
          constraints: [],
          unpriced_windows: unpriced.map((w) => w.label),
        });
        lastReason = "window_uncalibrated";
        lastPool = pool;
        lastDecision = null;
        continue;
      }
      const decision = await input.ledger.admit({
        constraints,
        poolId: pool.poolId,
        ...(input.leaseTtlMs != null ? { leaseTtlMs: input.leaseTtlMs } : {}),
      });
      // The full per-constraint evaluation (every key consulted, its headroom,
      // this draw's cost against it, which cleared) — carried onto the explain
      // record whether the decision admits or refuses. Non-finite headroom is
      // genuinely unbounded and normalizes to `null` (the schema must match the
      // literal bytes JSON.stringify puts on disk).
      const outcomeRecords = toConstraintOutcomeRecords(decision.constraints);
      const bindingRecord = decision.binding
        ? toConstraintOutcomeRecords([decision.binding])[0]!
        : null;
      if (decision.admitted && decision.leaseId) {
        granted.push({
          packet_id: packet.id,
          pool_id: pool.poolId,
          resource_keys: [...new Set(decision.constraints.map((o) => o.resourceKey))],
          lease_id: decision.leaseId,
          cost: packet.cost,
        });
        countByPool.set(pool.poolId, (countByPool.get(pool.poolId) ?? 0) + 1);
        explains.push({
          packet_id: packet.id,
          pool_id: pool.poolId,
          admitted: true,
          reason: "admitted",
          constraints: outcomeRecords,
          binding: bindingRecord,
          attempts,
          cost: packet.cost,
        });
        placed = true;
        break;
      }
      attempts.push({
        pool_id: pool.poolId,
        reason: "budget_exhausted",
        constraints: outcomeRecords,
      });
      lastReason = "budget_exhausted";
      lastPool = pool;
      lastDecision = { constraints: outcomeRecords, binding: bindingRecord };
    }

    if (!placed) {
      // The decisive (last) pool's refused consultation is carried on the record
      // itself — pop it off the trail so the two never duplicate, and lift its
      // reason-specific extras (cap counts / unpriceable labels) onto the record.
      const decisive =
        attempts.length > 0 && attempts[attempts.length - 1]!.pool_id === lastPool.poolId
          ? attempts.pop()!
          : null;
      explains.push({
        packet_id: packet.id,
        pool_id: lastPool.poolId,
        admitted: false,
        reason: lastReason,
        constraints: lastDecision?.constraints ?? [],
        binding: lastDecision?.binding ?? null,
        attempts,
        ...(decisive?.in_flight_before != null ? { in_flight_before: decisive.in_flight_before } : {}),
        ...(decisive?.cap != null ? { cap: decisive.cap } : {}),
        ...(decisive?.unpriced_windows ? { unpriced_windows: decisive.unpriced_windows } : {}),
        cost: packet.cost,
      });
      blocked.push(packet.id);
    }
  }

  return { granted, explains, blocked };
}

/**
 * The plan-only display grant's explain record: no lease exists BY DESIGN — the
 * in-process rolling engine admits + leases per-packet at dispatch time, and its
 * decisions land in the engine decision log. This record exists so a non-empty
 * decision round can never present an empty explains array (the legibility
 * invariant's "a decision path that writes no explain is itself a defect").
 */
function plannedExplain(candidate: AdmissionCandidate): AdmissionExplain {
  return {
    packet_id: candidate.id,
    pool_id: null,
    admitted: true,
    reason: "planned",
    constraints: [],
    binding: null,
    attempts: [],
    cost: candidate.cost,
  };
}

/**
 * Build the `DispatchAdmission` contract block both orchestrators embed in their
 * dispatch-quota — the single-sourced host-path admission derivation (no per-tool
 * copy that could drift). Computes each packet's envelope reservation
 * (`estimatePacketCost` with the declared output cap), derives the surfaced declared
 * cap (the most-constraining pool's in-flight cap), and either GRANTS via
 * {@link admitBatch} (host-subagent path, `grantLeases: true` — leases persist for
 * reconcile at ingest) or returns a plan-only block listing every candidate
 * (`grantLeases: false` — the in-process rolling engine leases per-packet itself,
 * so a host grant here would double-count).
 */
export async function computeDispatchAdmission(input: {
  packets: { id: string; inputTokens: number; complexity: number; requiredTier?: DispatchModelTier }[];
  pools: AdmissionPool[];
  /** Declared output cap for the packet envelope (cold-start; ratio refines later). */
  outputCap: number;
  grantLeases: boolean;
  ledger: ReservationLedger;
  capable?: (pool: AdmissionPool, packet: AdmissionCandidate) => boolean;
  /** Cost↔speed operating point λ ∈ [0,1]; see {@link AdmitBatchInput.dispatchBias}. */
  dispatchBias?: number;
}): Promise<DispatchAdmission> {
  const candidates: AdmissionCandidate[] = input.packets.map((p) => ({
    id: p.id,
    cost: estimatePacketCost({ inputEstimate: p.inputTokens, declaredOutputCap: input.outputCap }).cost,
    complexity: p.complexity,
    ...(p.requiredTier ? { requiredTier: p.requiredTier } : {}),
  }));
  const declaredCap = input.pools.reduce<number | null>(
    (min, p) => (p.declaredCap == null ? min : min == null ? p.declaredCap : Math.min(min, p.declaredCap)),
    null,
  );
  if (!input.grantLeases) {
    // Plan-only path (in-process engine — it admits + leases per packet itself).
    // No leases, but the capability FLOOR still applies (F4): the contract must not
    // display a grant the engine's floor will refuse to dispatch. Floor ONLY — size
    // fit stays the engine's own `doesNotFitContext` gate (declared per-pool caps),
    // so a size refusal is never mislabeled `no_capable_pool` here. Residual (named,
    // display-only): the engine can still size-refuse a displayed grant onto a
    // capped pool; the packet remains dispatchable to uncapped pools.
    // An EMPTY pool set means no capacity summary reached admission, not "nothing
    // is capable" — grant all, as before the floor existed. Every grant still
    // writes its `planned` explain: an empty explains array on a non-empty
    // decision round is itself a defect (the live 144-granted-empty incident).
    if (input.pools.length === 0) {
      return {
        granted_packet_ids: candidates.map((c) => c.id),
        declared_cap: declaredCap,
        leases: [],
        explains: candidates.map((c) => plannedExplain(c)),
      };
    }
    // Same-pool conjunction of the two per-packet engine axes: capability floor
    // (banded over size-neutralized stubs, mirroring
    // `buildCapacityPoolCapabilityFloor`) ∧ envelope fit (`defaultCapable`). Built
    // here from the pools — never `input.capable`, whose composed predicate can't
    // separate the axes. The RELATIVE floor never refuses every pool (fail-open +
    // the best band is always eligible), so a total refusal is always a size fact:
    // labeled `packet_oversized`, never `no_capable_pool` (which would misread a
    // sizing problem as a capability one — adversarial-review F1).
    const sizeNeutralPools = input.pools.map((p) => ({
      ...p,
      capacityTokens: Number.POSITIVE_INFINITY,
    }));
    const floorOnly = buildCapabilityFloorCapable(sizeNeutralPools);
    const grantedIds: string[] = [];
    const explains: AdmissionExplain[] = [];
    for (const candidate of candidates) {
      const granted = input.pools.some(
        (pool, i) => floorOnly(sizeNeutralPools[i]!, candidate) && defaultCapable(pool, candidate),
      );
      if (granted) {
        grantedIds.push(candidate.id);
        explains.push(plannedExplain(candidate));
      } else {
        explains.push({
          packet_id: candidate.id,
          pool_id: null,
          admitted: false,
          reason: "packet_oversized",
          constraints: [],
          binding: null,
          attempts: [],
          cost: candidate.cost,
        });
      }
    }
    return { granted_packet_ids: grantedIds, declared_cap: declaredCap, leases: [], explains };
  }
  const admit = await admitBatch({
    packets: candidates,
    pools: input.pools,
    ledger: input.ledger,
    // Host-wave grants live for the WAVE (minutes of subagent work before
    // ingest reconciles them), not the ledger's seconds-scale default — an
    // expired lease frees both budget and the declared-cap count to a
    // concurrent co-located admitter mid-wave (the host-path lease-TTL fix).
    leaseTtlMs: DISPATCH_LEASE_TTL_MS,
    ...(input.capable ? { capable: input.capable } : {}),
    ...(input.dispatchBias != null ? { dispatchBias: input.dispatchBias } : {}),
  });
  return {
    granted_packet_ids: admit.granted.map((g) => g.packet_id),
    declared_cap: declaredCap,
    leases: admit.granted,
    explains: admit.explains,
  };
}
