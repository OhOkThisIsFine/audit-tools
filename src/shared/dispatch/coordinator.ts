/**
 * Hybrid spill coordinator (A-8).
 *
 * The ONE assignment layer that BOTH dispatch drivers — the audit in-process
 * provider engine (`driveRollingAuditDispatch`) and the remediate host-subagent
 * loop (`advanceHostRolling`) — drive identically, so the spill topology can no
 * longer drift between them. It sits ABOVE the shared capacity fold
 * (`computeDispatchCapacity` / `scheduleWave`, S4) and the per-node accept
 * lifecycle (`acceptNodeWorktree`); it owns the cross-driver invariants those
 * lower layers cannot enforce on their own:
 *
 *  - **Claim-before-assign (CE-001).** Every node is claimed through A-10's
 *    file-backed {@link ClaimRegistry} BEFORE it is returned in any assignment,
 *    so two loops driving the same goal can never both pick the same node —
 *    exactly-one-claimant across both drivers. A node another driver already
 *    holds a live claim on is silently skipped (it is that driver's to run); the
 *    coordinator only ever hands back nodes it actually owns.
 *
 *  - **Co-owned SettledExclusionSet (CE-001 spill/exclusion handshake).** A pool
 *    that was spilled onto and then exhausted is recorded *settled* in the SAME
 *    exclusion set dc4 persists on the active-dispatch artifact (read in via
 *    `readSettled`, written back via `onSettle`). A settled pool is therefore
 *    excluded from every future split AND is never re-offered as net-new on
 *    re-discovery (INV-S03) — the spill side and the pause side share one set,
 *    not two that can disagree.
 *
 *  - **Proactive capacity split across ALL pools.** The frontier is split across
 *    every non-settled pool by capacity up front (not one chosen pool throttled
 *    reactively), folding inv2's RAW per-pool signals
 *    (`quotaSourceSnapshot` / `quotaStateEntry` / `quotaSignalDegraded`) to slot
 *    counts ONLY through the single shared `computeDispatchCapacity` fold — never
 *    pre-folded here and never re-folded. The global host-concurrency budget is
 *    honoured because it lives inside that same fold.
 *
 *  - **The single pause authorization.** {@link HybridSpillCoordinator.terminalStatus}
 *    emits the `all_pools_exhausted` terminal — and that terminal is the ONLY
 *    signal authorizing dc4 to pause the run. While any confirmed pool is still
 *    unsettled the coordinator reports `dispatchable`, so a driver never pauses
 *    on a transient single-pool exhaustion that the split could route around.
 *
 * The module is pure logic over injected collaborators (the registry, the
 * read/write hooks for the shared set, an optional clock) — zero direct disk or
 * provider coupling, so it runs identically on win32 / darwin / linux and under
 * either driver.
 */

import type { CapacityPool, PartialCompletionTerminal } from "../quota/capacity.js";
import {
  computeDispatchCapacity,
  buildEmptyPoolTerminal,
  AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS,
} from "../quota/capacity.js";
import type { SessionConfig } from "../types/sessionConfig.js";
import type { SettledExclusionSet } from "../rolling/pausedState.js";
import type { ClaimRegistry } from "../quota/claimRegistry.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A dispatchable frontier node, packet-payload-agnostic. The coordinator needs
 * only the stable id (for the claim) and the projected input-token cost (for the
 * capacity split); the payload is the driver's own concern.
 */
export interface FrontierNode {
  /** Stable, unique id for this node within the run (the claim key). */
  id: string;
  /** Projected input-token cost — fed to the S4 fold, never re-derived here. */
  estimatedTokens: number;
}

/**
 * One node claimed for one pool. Returned ONLY after the claim succeeded, so the
 * caller may dispatch immediately. The `ownerToken` is carried so the caller
 * (and {@link HybridSpillCoordinator.release}) can release or heartbeat the claim
 * through the same registry without re-reading it.
 */
export interface NodeAssignment {
  nodeId: string;
  poolId: string;
  providerName: CapacityPool["providerName"];
  hostModel: string | null;
  /** Claim token minted by the registry; required to release the claim. */
  ownerToken: string;
}

/**
 * The coordinator's terminal verdict after a planning pass.
 *
 * - `dispatchable`: at least one confirmed pool is still unsettled — keep going,
 *   never pause.
 * - `all_pools_exhausted`: every confirmed pool is settled; this is the ONLY
 *   signal that authorizes dc4 to engage the resumable pause. The stranded ids
 *   ride along as a {@link PartialCompletionTerminal} so the caller can route
 *   them through its consumer-specific handler.
 */
export type CoordinatorTerminalStatus =
  | { kind: "dispatchable" }
  | { kind: "all_pools_exhausted"; terminal: PartialCompletionTerminal };

/** Construction inputs for {@link HybridSpillCoordinator}. */
export interface HybridSpillCoordinatorOptions {
  /** Confirmed provider pools for this run, in preference order. */
  pools: CapacityPool[];
  sessionConfig: SessionConfig;
  /**
   * A-10 file-backed claim registry. The SAME registry path is supplied by both
   * drivers so a claim taken by one is visible to the other (exactly-one-claimant).
   */
  claimRegistry: ClaimRegistry;
  /**
   * Read the CURRENT shared settled-exclusion set (the pool ids dc4 persisted on
   * the active-dispatch artifact). Read on every pass so a pool another loop
   * settled is honoured immediately — the set is co-owned, not snapshotted once.
   */
  readSettled: () => SettledExclusionSet;
  /**
   * Persist a newly-settled pool id back into the shared set. Invoked by
   * {@link HybridSpillCoordinator.settlePool} so the spill side and dc4's pause
   * side write through ONE set. Optional for in-memory / test use.
   */
  onSettle?: (poolId: string) => void | Promise<void>;
}

/**
 * Whether a node fits a pool's declared per-request/context token cap, including
 * the agentic-harness overhead a CLI worker adds on top of the packet prompt.
 * A pool with no declared cap (null/absent — host pools, undeclared sources) is
 * always admissible: unknown means no fit filtering, the status quo.
 */
function nodeContextFits(node: FrontierNode, pool: CapacityPool): boolean {
  if (pool.contextCapTokens == null) return true;
  return node.estimatedTokens + AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS <= pool.contextCapTokens;
}

// ---------------------------------------------------------------------------
// HybridSpillCoordinator
// ---------------------------------------------------------------------------

export class HybridSpillCoordinator {
  private readonly pools: CapacityPool[];
  private readonly sessionConfig: SessionConfig;
  private readonly claimRegistry: ClaimRegistry;
  private readonly readSettled: () => SettledExclusionSet;
  private readonly onSettle?: (poolId: string) => void | Promise<void>;

  constructor(opts: HybridSpillCoordinatorOptions) {
    this.pools = opts.pools;
    this.sessionConfig = opts.sessionConfig;
    this.claimRegistry = opts.claimRegistry;
    this.readSettled = opts.readSettled;
    this.onSettle = opts.onSettle;
  }

  /** The pools NOT in the current shared settled set, in preference order. */
  private activePools(): CapacityPool[] {
    const settled = this.readSettled();
    return this.pools.filter((p) => !settled.has(p.id));
  }

  /**
   * Plan one dispatch pass: proactively split `nodes` across every non-settled
   * pool by capacity, then CLAIM each planned node before returning it.
   *
   * Steps:
   *  1. Drop settled pools (co-owned set) — a spilled-then-exhausted pool is never
   *     offered capacity again.
   *  2. Size every surviving pool through the single shared `computeDispatchCapacity`
   *     fold (S4): inv2's raw per-pool signals become slot counts THERE, the global
   *     host budget is enforced THERE, and the largest nodes land on the pools with
   *     the most headroom. No pre-fold or re-fold happens in this module.
   *  3. Walk the per-pool slot allocations largest-node-first and, for each
   *     (node, pool) pairing, take a registry claim BEFORE emitting the assignment.
   *     A node already held by another loop (live claim) is skipped — exactly-one
   *     claimant across both drivers (CE-001). Only owned nodes are returned.
   *
   * Returns the assignments the caller now exclusively owns. An empty result with
   * no active pools means the caller should consult {@link terminalStatus}.
   */
  async planAssignments(nodes: FrontierNode[]): Promise<NodeAssignment[]> {
    const active = this.activePools();
    if (active.length === 0 || nodes.length === 0) return [];

    // Largest-node-first so the capacity split and the claim walk agree with
    // computeDispatchCapacity's own descending layout (biggest work → most headroom).
    const ordered = [...nodes].sort((a, b) => b.estimatedTokens - a.estimatedTokens);

    // S4: the ONE fold. Raw per-pool quota signals → slot counts, global host
    // budget applied, all inside computeDispatchCapacity. We pass the ordered node
    // token costs as the pending layout and read back the per-pool slot counts.
    const capacity = computeDispatchCapacity({
      pools: active,
      sessionConfig: this.sessionConfig,
      pendingItemTokens: ordered.map((n) => n.estimatedTokens),
    });

    const poolById = new Map(active.map((p) => [p.id, p]));
    const assignments: NodeAssignment[] = [];
    // Per-pool packet-fit gate (U2): the claim walk consumes a shared queue with a
    // FIRST-FIT scan instead of a linear cursor, so a node too large for THIS pool's
    // declared context cap stays available for a later (larger or cap-less) pool in
    // the same walk — the claim itself is the fit guarantee (a node is never claimed
    // to a pool it cannot fit; post-hoc repartitioning would strand the claim on the
    // wrong pool id).
    const unassigned = [...ordered];

    for (const alloc of capacity.pools) {
      const pool = poolById.get(alloc.pool_id);
      // Defensive: the fold echoes the input pools, but never assign to a pool
      // that is not in the active (non-settled) set.
      if (!pool) continue;
      let placed = 0;
      let scan = 0;
      while (placed < alloc.slots && scan < unassigned.length) {
        const node = unassigned[scan]!;
        if (!nodeContextFits(node, pool)) {
          // Too large for this pool — leave it queued for a later pool this walk
          // (or unclaimed for the next cycle); the slot stays open for the next node.
          scan += 1;
          continue;
        }
        unassigned.splice(scan, 1);
        // Claim BEFORE returning the node in any assignment (CE-001). A node
        // another driver already holds is skipped — it is theirs to run — and the
        // slot is freed for the next node so capacity is not wasted on a contested id.
        const claim = await this.claimRegistry.claim(node.id, pool.id);
        if (!claim.acquired) continue;
        assignments.push({
          nodeId: node.id,
          poolId: pool.id,
          providerName: pool.providerName,
          hostModel: pool.hostModel,
          ownerToken: claim.ownerToken,
        });
        placed += 1;
      }
      if (unassigned.length === 0) break;
    }

    // Loud never-fits surface (spec F1): a node whose size exceeds EVERY active
    // pool's declared cap can never be claimed by this coordinator — re-offering
    // is correct only while a cap-less (host) pool may appear; silent re-offer
    // against a fixed all-capped pool set would look like an idle wedge. One
    // structured line per plan so the caller/operator can see exactly which
    // nodes are unplaceable and why.
    const neverFits = unassigned.filter((n) =>
      active.every((p) => !nodeContextFits(n, p)),
    );
    if (neverFits.length > 0) {
      try {
        process.stderr.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            kind: "hybrid_dispatch_node_never_fits",
            node_ids: neverFits.map((n) => n.id).sort(),
            active_pool_caps: active
              .map((p) => ({ pool_id: p.id, context_cap_tokens: p.contextCapTokens ?? null }))
              .sort((a, b) => a.pool_id.localeCompare(b.pool_id)),
          }) + "\n",
        );
      } catch {
        // Observability must never abort a plan.
      }
    }

    return assignments;
  }

  /**
   * Record a pool as spilled-then-exhausted in the co-owned SettledExclusionSet.
   *
   * This is the spill side of the CE-001 handshake: once a pool that load was
   * spilled onto can no longer take work, it is written back through `onSettle`
   * into the SAME set dc4 reads when it pauses — so the pool is excluded from
   * every future split here AND is never re-offered as net-new on re-discovery
   * (INV-S03). Idempotent: settling an already-settled pool is a no-op.
   */
  async settlePool(poolId: string): Promise<void> {
    if (this.readSettled().has(poolId)) return;
    await this.onSettle?.(poolId);
  }

  /**
   * Release a node's claim once its `acceptNodeWorktree` lifecycle has finished
   * (success OR failure) — the convergence point both drivers share. Token-checked
   * by the registry, so only the owner can release. A `rate_limited` node that the
   * driver intends to re-queue should NOT be released here (it is still owned work);
   * release only on a terminal accept outcome.
   */
  async release(assignment: NodeAssignment): Promise<void> {
    await this.claimRegistry.release(assignment.nodeId, assignment.ownerToken);
  }

  /**
   * The single pause-authorization check. Returns `all_pools_exhausted` — carrying
   * a `PartialCompletionTerminal` over `strandedIds` — ONLY when every confirmed
   * pool is settled; otherwise `dispatchable`. dc4 may engage its resumable pause
   * if and only if this returns the terminal; a transient single-pool exhaustion
   * (other pools still unsettled) keeps the run dispatchable.
   */
  terminalStatus(strandedIds: string[]): CoordinatorTerminalStatus {
    const settled = this.readSettled();
    const allExhausted = this.pools.length > 0 && this.pools.every((p) => settled.has(p.id));
    if (!allExhausted) return { kind: "dispatchable" };
    return {
      kind: "all_pools_exhausted",
      terminal: buildEmptyPoolTerminal(strandedIds),
    };
  }
}
