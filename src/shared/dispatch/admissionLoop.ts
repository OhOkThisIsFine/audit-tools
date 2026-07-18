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
import type { ReservationLedger } from "../quota/reservationLedger.js";
import { DISPATCH_LEASE_TTL_MS } from "../quota/reservationLedger.js";
import { estimatePacketCost } from "../quota/packetCost.js";
import type { DispatchCapacityPoolSummary } from "../quota/capacity.js";
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
}

/** One pool a packet may be routed to. */
export interface AdmissionPool {
  poolId: string;
  /** `provider#account/model` — the metered account the lease keys to. */
  resourceKey: string;
  /** Live remaining token budget for `resourceKey`. `+Infinity` ⇒ optimistic. */
  budget: number;
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
   * pools that also share a tier (e.g. many repair-proxy models on the neutral fallback
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

/** A successful admission: one packet leased to one pool. */
export interface AdmissionGrant {
  packet_id: string;
  pool_id: string;
  resource_key: string;
  lease_id: string;
  cost: number;
}

export const AdmissionGrantSchema = z
  .object({
    packet_id: z.string(),
    pool_id: z.string(),
    resource_key: z.string(),
    lease_id: z.string(),
    cost: z.number(),
  })
  .strict();

/** Why a packet was admitted or blocked — the per-admission explain record. */
export const AdmissionExplainSchema = z
  .object({
    packet_id: z.string(),
    /** null only when NO pool was capable of the packet at all. */
    pool_id: z.string().nullable(),
    resource_key: z.string().nullable(),
    admitted: z.boolean(),
    reason: z.enum(["admitted", "no_capable_pool", "budget_exhausted", "cap_reached"]),
    /** Present on an admit attempt against a real pool (budget headroom before it). */
    headroom_before: z.number().optional(),
    outstanding_before: z.number().optional(),
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
 * Finer capability tiebreak on the raw registry score (LOWER = more capable), consulted
 * only after the coarse tier ordinal has tied. A present score sorts before an absent
 * one; both absent ⇒ 0 (fall through to the next tiebreak). Never a primary axis — it
 * only refines cost-equal, same-tier pools (e.g. repair-proxy models on one tier).
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
  const countByPool = new Map<string, number>();
  try {
    const snapshot = await input.ledger.snapshot();
    for (const leases of Object.values(snapshot)) {
      for (const lease of leases) {
        countByPool.set(lease.poolId, (countByPool.get(lease.poolId) ?? 0) + 1);
      }
    }
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
        resource_key: null,
        admitted: false,
        reason: "no_capable_pool",
        cost: packet.cost,
      });
      blocked.push(packet.id);
      continue;
    }

    let placed = false;
    let lastReason: AdmissionExplain["reason"] = "budget_exhausted";
    let lastPool = candidates[0]!;
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
        lastReason = "cap_reached";
        lastPool = pool;
        continue;
      }
      const decision = await input.ledger.admit({
        resourceKey: pool.resourceKey,
        cost: packet.cost,
        budget: pool.budget,
        poolId: pool.poolId,
        ...(input.leaseTtlMs != null ? { leaseTtlMs: input.leaseTtlMs } : {}),
      });
      if (decision.admitted && decision.leaseId) {
        granted.push({
          packet_id: packet.id,
          pool_id: pool.poolId,
          resource_key: pool.resourceKey,
          lease_id: decision.leaseId,
          cost: packet.cost,
        });
        countByPool.set(pool.poolId, (countByPool.get(pool.poolId) ?? 0) + 1);
        explains.push({
          packet_id: packet.id,
          pool_id: pool.poolId,
          resource_key: pool.resourceKey,
          admitted: true,
          reason: "admitted",
          headroom_before: decision.headroomBefore,
          outstanding_before: decision.outstandingBefore,
          cost: packet.cost,
        });
        placed = true;
        break;
      }
      lastReason = "budget_exhausted";
      lastPool = pool;
    }

    if (!placed) {
      explains.push({
        packet_id: packet.id,
        pool_id: lastPool.poolId,
        resource_key: lastPool.resourceKey,
        admitted: false,
        reason: lastReason,
        cost: packet.cost,
      });
      blocked.push(packet.id);
    }
  }

  return { granted, explains, blocked };
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
  packets: { id: string; inputTokens: number; complexity: number }[];
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
  }));
  const declaredCap = input.pools.reduce<number | null>(
    (min, p) => (p.declaredCap == null ? min : min == null ? p.declaredCap : Math.min(min, p.declaredCap)),
    null,
  );
  if (!input.grantLeases) {
    return { granted_packet_ids: candidates.map((c) => c.id), declared_cap: declaredCap, leases: [], explains: [] };
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
