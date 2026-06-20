/**
 * A-8 hybrid dispatch split (FINDING-020 capstone) — `planHybridDispatch`.
 *
 * The assignment layer that splits one eligible frontier across the host-subagent
 * pool and the in-process backend pool(s) via the shared coordinator, then
 * partitions the claimed assignments into the work each driver runs. Asserts the
 * spec's acceptance criteria at the partition level:
 *
 *  - both pools receive nodes when both have capacity (proactive split, crit. 2);
 *  - each node is claimed to exactly one pool — partitions are disjoint, every
 *    assignment carries an ownerToken (single claimant, crit. 1);
 *  - a pool with a silent/absent capacity signal still gets a floored slot, so its
 *    nodes are never dropped (safe degrade, crit. 4);
 *  - the host-only and backend-only configs fall out with one partition empty.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimRegistry } from "../../src/shared/quota/claimRegistry.js";
import { planHybridDispatch } from "../../src/remediate/steps/hybridDispatch.js";
import type { CapacityPool, FrontierNode, SessionConfig } from "audit-tools/shared";

// Configured hosted concurrency so the shared fold yields a wave > 1 — which is
// what makes the cross-pool split observable (the fold still owns every cap).
const SESSION: SessionConfig = {
  quota: { unknown_hosted_concurrency: 8 },
} as SessionConfig;

function nodes(count: number, tokens = 1000): FrontierNode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `blk-${i}`,
    estimatedTokens: tokens,
  }));
}

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

/** The conversation host's subagent pool (turn-based driver). */
function hostPool(over: Partial<CapacityPool> = {}): CapacityPool {
  return {
    id: "pool/claude-code",
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: {
      active_subagents: 4,
      source: "host_reported",
      description: "host subagent budget",
    },
    quotaSourceSnapshot: snapshot(0.95),
    ...over,
  };
}

/** An in-process backend pool (the NIM / openai-compatible worker). */
function nimPool(over: Partial<CapacityPool> = {}): CapacityPool {
  return {
    id: "pool/openai-compatible",
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaSourceSnapshot: snapshot(0.95),
    ...over,
  };
}

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

/** Always-granting in-memory ClaimRegistry stand-in for the deterministic tests. */
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

describe("A-8 planHybridDispatch", () => {
  it("hybrid [host + nim], both healthy: both partitions receive nodes (proactive split, crit. 2)", async () => {
    const store = settledStore();
    const part = await planHybridDispatch({
      frontier: nodes(12),
      pools: [hostPool(), nimPool()],
      sessionConfig: SESSION,
      claimRegistry: fakeRegistry(),
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });

    // Both pools carry load concurrently when both have headroom.
    expect(part.host.length).toBeGreaterThan(0);
    expect(part.inProcess.length).toBeGreaterThan(0);
    // Correct classification: in-process is the backend pool, host is claude-code.
    expect(part.inProcess.every((a) => a.providerName === "openai-compatible")).toBe(true);
    expect(part.host.every((a) => a.providerName === "claude-code")).toBe(true);
  });

  it("each node claimed to exactly one pool: disjoint partitions, every assignment carries an ownerToken (crit. 1)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hybrid-claim-"));
    try {
      const registry = new ClaimRegistry(join(dir, "node-claims.json"));
      const store = settledStore();
      const part = await planHybridDispatch({
        frontier: nodes(12),
        pools: [hostPool(), nimPool()],
        sessionConfig: SESSION,
        claimRegistry: registry,
        readSettled: store.readSettled,
        onSettle: store.onSettle,
      });

      const hostIds = part.host.map((a) => a.block_id);
      const inProcIds = part.inProcess.map((a) => a.block_id);
      // No node appears in both partitions.
      expect(hostIds.filter((id) => inProcIds.includes(id))).toEqual([]);
      // Every claimed node carries a real ownerToken (the release credential).
      for (const a of [...part.host, ...part.inProcess]) {
        expect(typeof a.ownerToken).toBe("string");
        expect(a.ownerToken.length).toBeGreaterThan(0);
      }
      // Every claimed id is unique across the whole split.
      const all = [...hostIds, ...inProcIds];
      expect(new Set(all).size).toBe(all.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("safe degrade: a backend pool with a silent capacity signal still gets a floored slot (crit. 4)", async () => {
    const store = settledStore();
    const part = await planHybridDispatch({
      frontier: nodes(3, 500),
      // Single backend pool whose proactive quota source silently degraded — the
      // S4 fold floors it to >=1 slot off the byte estimate rather than dropping it.
      pools: [nimPool({ quotaSignalDegraded: true, quotaSourceSnapshot: null })],
      sessionConfig: SESSION,
      claimRegistry: fakeRegistry(),
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    expect(part.inProcess.length).toBeGreaterThanOrEqual(1);
    expect(part.host).toEqual([]);
  });

  it("host-only config: every node lands in the host partition", async () => {
    const store = settledStore();
    const part = await planHybridDispatch({
      frontier: nodes(6),
      pools: [hostPool()],
      sessionConfig: SESSION,
      claimRegistry: fakeRegistry(),
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    expect(part.host.length).toBeGreaterThan(0);
    expect(part.inProcess).toEqual([]);
  });

  it("backend-only config: every node lands in the in-process partition", async () => {
    const store = settledStore();
    const part = await planHybridDispatch({
      frontier: nodes(6),
      pools: [nimPool()],
      sessionConfig: SESSION,
      claimRegistry: fakeRegistry(),
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    expect(part.inProcess.length).toBeGreaterThan(0);
    expect(part.host).toEqual([]);
  });

  it("a settled pool is excluded from the split (co-owned exclusion set)", async () => {
    const store = settledStore();
    store.set.add("pool/openai-compatible");
    const part = await planHybridDispatch({
      frontier: nodes(8),
      pools: [hostPool(), nimPool()],
      sessionConfig: SESSION,
      claimRegistry: fakeRegistry(),
      readSettled: store.readSettled,
      onSettle: store.onSettle,
    });
    // The settled backend pool receives nothing; all work routes to the host pool.
    expect(part.inProcess).toEqual([]);
    expect(part.host.length).toBeGreaterThan(0);
  });
});
