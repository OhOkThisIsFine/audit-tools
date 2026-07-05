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
}

/** Default capability gate: the pool's window must fit the packet's reservation. */
function defaultCapable(pool: AdmissionPool, packet: AdmissionCandidate): boolean {
  if (!Number.isFinite(pool.capacityTokens) || pool.capacityTokens <= 0) return true;
  return pool.capacityTokens >= packet.cost;
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
    // Cost-first-capable: cheapest capable pool first; ties break toward the more
    // capable pool so equal-cost lanes prefer the one with more headroom.
    const candidates = input.pools
      .filter((pool) => capable(pool, packet))
      .sort((a, b) => a.costRank - b.costRank || b.capabilityRank - a.capabilityRank);

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
