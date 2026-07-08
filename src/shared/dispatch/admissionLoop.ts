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
import { estimatePacketCost } from "../quota/packetCost.js";

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
  /** Largest packet cost this pool can fit (context window − output). */
  capacityTokens: number;
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

/** Cost-first order: cheapest first, ties toward the more capable pool. */
function costFirstCmp(a: AdmissionPool, b: AdmissionPool): number {
  return a.costRank - b.costRank || b.capabilityRank - a.capabilityRank;
}

/** Deterministic tiebreak so equal-key orderings are stable across processes. */
function poolIdCmp(a: AdmissionPool, b: AdmissionPool): number {
  return a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0;
}

/**
 * A pool's throughput proxy for the cost↔speed dial (spec/dispatch-cost-speed-dial.md):
 * its declared CONCURRENCY (how many packets it runs in parallel), which is the same
 * real-world property as `declaredCap` and clears a batch proportionally faster. This
 * is auto-derived from what the provider already declares (a source's `max_concurrent`
 * or the host's subagent budget) — no operator rate declaration, and no learned/measured
 * signal (honors "concurrency is declared or absent, never learned"). An ABSENT cap
 * (`null`) ⇒ unbounded parallelism ⇒ `+Infinity` (ranks fastest); a small cap (the
 * sequential-ish host) ranks slower than an uncapped/high-concurrency source.
 */
function throughputOf(pool: AdmissionPool): number {
  return pool.declaredCap == null ? Number.POSITIVE_INFINITY : pool.declaredCap;
}

/** Descending throughput; `+Infinity`-safe (Infinity−Infinity would be NaN). */
function speedFirstCmp(a: AdmissionPool, b: AdmissionPool): number {
  const ta = throughputOf(a);
  const tb = throughputOf(b);
  if (ta !== tb) {
    if (ta === Number.POSITIVE_INFINITY) return -1;
    if (tb === Number.POSITIVE_INFINITY) return 1;
    return tb - ta;
  }
  return b.capabilityRank - a.capabilityRank || poolIdCmp(a, b);
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
      if (pool.declaredCap != null && (countByPool.get(pool.poolId) ?? 0) >= pool.declaredCap) {
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
