/**
 * A-8 hybrid spill coordinator (IMPL-a8).
 *
 * The coordinator is the ONE assignment layer both dispatch drivers share. These
 * cover the four invariants the prompt names:
 *
 *  1. Two-loop single-assignment — two coordinators sharing ONE on-disk
 *     ClaimRegistry never both hand back the same node (exactly-one-claimant,
 *     CE-001), because the claim is taken BEFORE the node is returned.
 *  2. Healthy-before-degraded split — a quota-degraded pool (low remaining_pct)
 *     is deprioritised by the shared fold so the healthy pool carries the load.
 *  3. Silent-degrade byte-estimate — a pool whose proactive quota source silently
 *     degraded (`quotaSignalDegraded`) still receives a byte-estimate-floored slot
 *     via the S4 fold rather than being dropped; the raw signal is carried, never
 *     pre-folded by the coordinator.
 *  4. Global budget — when all pools share one host concurrency limit, the TOTAL
 *     nodes assigned across pools never exceeds that global budget.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimRegistry } from "../../src/shared/quota/claimRegistry.js";
import {
  HybridSpillCoordinator,
  type FrontierNode,
  type NodeAssignment,
} from "../../src/shared/dispatch/coordinator.js";
import type { CapacityPool, SessionConfig } from "audit-tools/shared";

// A configured hosted-pool concurrency so the shared fold produces a wave > 1,
// which is what makes the proactive split observable: at the bare default an
// unconfigured hosted pool floors to a single slot and healthy/degraded look
// identical. The fold (not the coordinator) still owns every cap.
const SESSION: SessionConfig = {
  quota: { unknown_hosted_concurrency: 8 },
} as SessionConfig;

function nodes(count: number, tokens = 1000): FrontierNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n-${i}`,
    estimatedTokens: tokens,
  }));
}

function pool(id: string, over: Partial<CapacityPool> = {}): CapacityPool {
  return {
    id,
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
    ...over,
  };
}

/** A complete real-time usage snapshot carrying a given remaining_pct. */
function snapshot(remainingPct: number): CapacityPool["quotaSourceSnapshot"] {
  return {
    remaining_pct: remainingPct,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date(0).toISOString(),
    source: "test",
  };
}

/** An in-memory settled set + sink, so the deterministic tests need no disk. */
function settledStore() {
  const set = new Set<string>();
  return {
    readSettled: () => set as ReadonlySet<string>,
    onSettle: (poolId: string) => {
      set.add(poolId);
    },
    set,
  };
}

describe("A-8 HybridSpillCoordinator", () => {
  it("two-loop single-assignment: a node is handed back by exactly one coordinator (CE-001)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "a8-claim-"));
    try {
      const registryPath = join(dir, "claim-registry.json");
      // Two coordinators, two ClaimRegistry instances → the SAME on-disk file:
      // this is the cross-driver case (audit loop + remediate loop, same goal).
      const regA = new ClaimRegistry(registryPath);
      const regB = new ClaimRegistry(registryPath);
      const storeA = settledStore();
      const storeB = settledStore();
      const poolA = pool("pool/a");
      const poolB = pool("pool/b");

      const coordA = new HybridSpillCoordinator({
        pools: [poolA],
        sessionConfig: SESSION,
        claimRegistry: regA,
        readSettled: storeA.readSettled,
        onSettle: storeA.onSettle,
      });
      const coordB = new HybridSpillCoordinator({
        pools: [poolB],
        sessionConfig: SESSION,
        claimRegistry: regB,
        readSettled: storeB.readSettled,
        onSettle: storeB.onSettle,
      });

      const frontier = nodes(6);
      // Both loops try to plan the SAME frontier (serialized here; the registry's
      // own withFileLock makes the claim atomic even under true concurrency).
      const fromA = await coordA.planAssignments(frontier);
      const fromB = await coordB.planAssignments(frontier);

      const idsA = fromA.map((a) => a.nodeId);
      const idsB = fromB.map((a) => a.nodeId);

      // No node is claimed by both coordinators.
      const overlap = idsA.filter((id) => idsB.includes(id));
      expect(overlap).toEqual([]);
      // Whatever A claimed, B was refused (A planned first and took all six).
      expect(new Set(idsA).size).toBe(idsA.length);
      expect(new Set(idsB).size).toBe(idsB.length);
      expect(idsA.length).toBeGreaterThan(0);

      // Releasing A's claims frees those nodes for B on a subsequent pass.
      for (const a of fromA) await coordA.release(a);
      const fromBAfter = await coordB.planAssignments(frontier);
      expect(fromBAfter.length).toBeGreaterThan(0);
      // Now B can claim ids that A had released.
      expect(fromBAfter.some((a) => idsA.includes(a.nodeId))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two-loop single-assignment: a single shared registry never double-claims under interleaved planning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "a8-claim2-"));
    try {
      const registryPath = join(dir, "claim-registry.json");
      const reg = new ClaimRegistry(registryPath);
      const store = settledStore();
      const mk = (poolId: string) =>
        new HybridSpillCoordinator({
          pools: [pool(poolId)],
          sessionConfig: SESSION,
          claimRegistry: reg,
          readSettled: store.readSettled,
          onSettle: store.onSettle,
        });
      const coordA = mk("pool/a");
      const coordB = mk("pool/b");

      const frontier = nodes(10);
      const [fromA, fromB] = await Promise.all([
        coordA.planAssignments(frontier),
        coordB.planAssignments(frontier),
      ]);
      const all = [...fromA, ...fromB].map((a) => a.nodeId);
      // Every claimed node is unique across BOTH loops.
      expect(new Set(all).size).toBe(all.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("healthy-before-degraded split: the healthy pool carries more than the degraded peer", async () => {
    const store = settledStore();
    const reg = fakeRegistry();
    const healthy = pool("pool/healthy", {
      // Ample remaining token budget → carries the bulk of the frontier.
      quotaSourceSnapshot: { ...snapshot(0.95), tokens_remaining: 1_000_000 },
    });
    const degraded = pool("pool/degraded", {
      // A small remaining token budget → the token-budget gate keeps its share
      // strictly smaller (the differentiation now comes from the budget, not the
      // removed remaining_pct halving cliff).
      quotaSourceSnapshot: { ...snapshot(0.02), tokens_remaining: 1500 },
    });
    const coord = new HybridSpillCoordinator({
      pools: [healthy, degraded],
      sessionConfig: SESSION,
      claimRegistry: reg,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });

    const assignments = await coord.planAssignments(nodes(20));
    const byPool = countByPool(assignments);
    const healthyCount = byPool.get("pool/healthy") ?? 0;
    const degradedCount = byPool.get("pool/degraded") ?? 0;

    // The frontier is split across BOTH pools (proactive, not one throttled).
    expect(healthyCount).toBeGreaterThan(0);
    // The healthy pool is loaded at least as much as the degraded one; the
    // degraded pool's remaining_pct halving keeps its share strictly smaller.
    expect(healthyCount).toBeGreaterThanOrEqual(degradedCount);
    expect(healthyCount).toBeGreaterThan(degradedCount);
  });

  it("silent-degrade byte-estimate: a quotaSignalDegraded pool still gets a floored slot, signal carried not pre-folded", async () => {
    const store = settledStore();
    const reg = fakeRegistry();
    // Single pool whose proactive quota source silently degraded: no snapshot, but
    // the explicit raw marker is set. The S4 fold must still floor it to >=1 slot
    // off the byte estimate rather than the coordinator dropping it.
    const degraded = pool("pool/silent", {
      quotaSignalDegraded: true,
      quotaSourceSnapshot: null,
    });
    const coord = new HybridSpillCoordinator({
      pools: [degraded],
      sessionConfig: SESSION,
      claimRegistry: reg,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });

    const assignments = await coord.planAssignments(nodes(3, 500));
    // Floor-1: the silently-degraded pool is still dispatchable.
    expect(assignments.length).toBeGreaterThanOrEqual(1);
    expect(assignments.every((a) => a.poolId === "pool/silent")).toBe(true);
  });

  it("global budget: total nodes assigned across pools never exceeds the shared host budget", async () => {
    const store = settledStore();
    const reg = fakeRegistry();
    // Two pools that BOTH report the SAME host concurrency limit + source → the
    // shared fold derives a GLOBAL budget of 2 across the pair (not 2 each).
    const hostLimit = {
      active_subagents: 2,
      source: "host_reported" as const,
      description: "shared host budget",
    };
    const p0 = pool("pool/0", { hostConcurrencyLimit: hostLimit });
    const p1 = pool("pool/1", { hostConcurrencyLimit: hostLimit });
    const coord = new HybridSpillCoordinator({
      pools: [p0, p1],
      sessionConfig: SESSION,
      claimRegistry: reg,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });

    const assignments = await coord.planAssignments(nodes(12));
    // The global host budget caps the TOTAL across both pools.
    expect(assignments.length).toBeLessThanOrEqual(2);
    expect(assignments.length).toBeGreaterThan(0);
  });

  it("terminalStatus: dispatchable until every confirmed pool is settled, then the sole pause terminal fires", async () => {
    const store = settledStore();
    const reg = fakeRegistry();
    const p0 = pool("pool/0");
    const p1 = pool("pool/1");
    const coord = new HybridSpillCoordinator({
      pools: [p0, p1],
      sessionConfig: SESSION,
      claimRegistry: reg,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });

    // No pool settled → dispatchable (a driver must NOT pause).
    expect(coord.terminalStatus(["n-0"]).kind).toBe("dispatchable");

    // One of two settled → still dispatchable (transient single-pool exhaustion).
    await coord.settlePool("pool/0");
    expect(coord.terminalStatus(["n-0"]).kind).toBe("dispatchable");
    // A settled pool is excluded from the next split.
    const onlyP1 = await coord.planAssignments(nodes(4));
    expect(onlyP1.every((a) => a.poolId === "pool/1")).toBe(true);

    // Both settled → the ONLY pause-authorizing terminal, carrying the stranded ids.
    await coord.settlePool("pool/1");
    const status = coord.terminalStatus(["n-0", "n-1"]);
    expect(status.kind).toBe("all_pools_exhausted");
    if (status.kind === "all_pools_exhausted") {
      expect(status.terminal.reason).toBe("empty_pool");
      expect(status.terminal.stranded_ids).toEqual(["n-0", "n-1"]);
    }
    // A fully-settled coordinator offers no further assignments.
    expect(await coord.planAssignments(nodes(4))).toEqual([]);
  });

  it("settlePool is idempotent and writes through the co-owned set", async () => {
    const store = settledStore();
    const reg = fakeRegistry();
    const coord = new HybridSpillCoordinator({
      pools: [pool("pool/0")],
      sessionConfig: SESSION,
      claimRegistry: reg,
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    await coord.settlePool("pool/0");
    await coord.settlePool("pool/0");
    expect([...store.set]).toEqual(["pool/0"]);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

/** Count assignments per pool id. */
function countByPool(assignments: NodeAssignment[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of assignments) m.set(a.poolId, (m.get(a.poolId) ?? 0) + 1);
  return m;
}

/**
 * An always-granting in-memory ClaimRegistry stand-in for the deterministic
 * split/budget tests: the claim layer is exercised end-to-end in the two-loop
 * tests above, so here we isolate the capacity-split behaviour from disk I/O.
 * One token per node so releases are well-formed.
 */
function fakeRegistry(): ClaimRegistry {
  const held = new Set<string>();
  const stub = {
    async claim(nodeId: string) {
      if (held.has(nodeId)) return { acquired: false as const, heldBy: "other" };
      held.add(nodeId);
      return { acquired: true as const, ownerToken: `tok-${nodeId}` };
    },
    async release(nodeId: string) {
      return held.delete(nodeId);
    },
  };
  return stub as unknown as ClaimRegistry;
}
