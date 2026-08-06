/**
 * A-8 hybrid spill coordinator — audit-driver view (IMPL-a8).
 *
 * The coordinator is a SHARED module both dispatch drivers drive identically, so
 * the audit side asserts the same four invariants the remediate suite does,
 * through the audit-side relative import path.
 */
import { test, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapacityPool, SessionConfig } from "audit-tools/shared";
import type { ClaimRegistry } from "../../src/shared/quota/claimRegistry.js";
import type { FrontierNode, NodeAssignment } from "../../src/shared/dispatch/coordinator.js";

const { ClaimRegistry: ClaimRegistryCtor } = await import("../../src/shared/quota/claimRegistry.js");
const { HybridSpillCoordinator } = await import(
  "../../src/shared/dispatch/coordinator.js"
);

// Configured hosted-pool concurrency so the shared fold yields a wave > 1, which
// is what makes the proactive split observable (the fold still owns every cap).
// `unknown_hosted_concurrency` is a test-only synthetic knob, not a real
// QuotaConfig field — mirrors the identical cast in tests/remediate/a8.test.ts.
const SESSION = {
  quota: {
    unknown_hosted_concurrency: 8,
    default_context_tokens: 200_000,
    reserved_output_tokens: 8_000,
  },
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
    // Unattributable test pool: the documented fallback is the pool's own id, so
    // each fixture pool meters alone rather than joining a shared allowance.
    accountKey: id,
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
    ...over,
  };
}

function snapshot(remainingPct: number): NonNullable<CapacityPool["quotaSourceSnapshot"]> {
  return {
    remaining_pct: remainingPct,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date(0).toISOString(),
    source: "test",
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

// Always-granting in-memory ClaimRegistry stand-in for the deterministic tests.
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

function countByPool(assignments: NodeAssignment[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const a of assignments) m.set(a.poolId, (m.get(a.poolId) ?? 0) + 1);
  return m;
}

test("A8: two-loop single-assignment — exactly one claimant across a shared registry (CE-001)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a8-audit-claim-"));
  try {
    const registryPath = join(dir, "claim-registry.json");
    const reg = new ClaimRegistryCtor(registryPath);
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
    expect(all.length > 0).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A8: healthy-before-degraded split — degraded pool's share stays smaller", async () => {
  const store = settledStore();
  const reg = fakeRegistry();
  // Differentiation now comes from the remaining token budget (the removed
  // remaining_pct halving cliff no longer applies): ample budget carries the bulk,
  // a small budget stays smaller.
  const healthy = pool("pool/healthy", {
    quotaSourceSnapshot: { ...snapshot(0.95), tokens_remaining: 1_000_000 },
  });
  const degraded = pool("pool/degraded", {
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
  expect(healthyCount > 0).toBeTruthy();
  expect(healthyCount > degradedCount).toBeTruthy();
});

test("A8: silent-degrade byte-estimate — a quotaSignalDegraded pool still gets a floored slot", async () => {
  const store = settledStore();
  const reg = fakeRegistry();
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
  expect(assignments.length >= 1).toBeTruthy();
  expect(assignments.every((a) => a.poolId === "pool/silent")).toBeTruthy();
});

test("A8: global budget — total across pools never exceeds the shared host budget", async () => {
  const store = settledStore();
  const reg = fakeRegistry();
  const hostLimit = {
    active_subagents: 2,
    source: "host_reported" as const,
    description: "shared host budget",
  };
  const coord = new HybridSpillCoordinator({
    pools: [
      pool("pool/0", { hostConcurrencyLimit: hostLimit }),
      pool("pool/1", { hostConcurrencyLimit: hostLimit }),
    ],
    sessionConfig: SESSION,
    claimRegistry: reg,
    readSettled: store.readSettled,
    onSettle: store.onSettle,
  });

  const assignments = await coord.planAssignments(nodes(12));
  expect(assignments.length <= 2).toBeTruthy();
  expect(assignments.length > 0).toBeTruthy();
});

test("A8: terminalStatus — dispatchable until every pool settled, then the sole pause terminal", async () => {
  const store = settledStore();
  const reg = fakeRegistry();
  const coord = new HybridSpillCoordinator({
    pools: [pool("pool/0"), pool("pool/1")],
    sessionConfig: SESSION,
    claimRegistry: reg,
    readSettled: store.readSettled,
    onSettle: store.onSettle,
  });

  expect(coord.terminalStatus(["n-0"]).kind).toBe("dispatchable");

  await coord.settlePool("pool/0");
  expect(coord.terminalStatus(["n-0"]).kind).toBe("dispatchable");
  const onlyP1 = await coord.planAssignments(nodes(4));
  expect(onlyP1.every((a) => a.poolId === "pool/1")).toBeTruthy();

  await coord.settlePool("pool/1");
  const status = coord.terminalStatus(["n-0", "n-1"]);
  expect(status.kind).toBe("all_pools_exhausted");
  if (status.kind === "all_pools_exhausted") {
    expect(status.terminal.reason).toBe("empty_pool");
    expect(status.terminal.stranded_ids).toEqual(["n-0", "n-1"]);
  }
  expect(await coord.planAssignments(nodes(4))).toEqual([]);
});
