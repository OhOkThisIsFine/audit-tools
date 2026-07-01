/**
 * A-8 hybrid spill coordinator — audit-driver view (IMPL-a8).
 *
 * The coordinator is a SHARED module both dispatch drivers drive identically, so
 * the audit side asserts the same four invariants the remediate suite does,
 * through the audit-side relative import path:
 *
 *  1. Two-loop single-assignment — two coordinators sharing ONE on-disk
 *     ClaimRegistry never both hand back the same node (CE-001).
 *  2. Healthy-before-degraded split — the degraded pool's share stays smaller.
 *  3. Silent-degrade byte-estimate — a quotaSignalDegraded pool still gets a
 *     floored slot via the S4 fold (not dropped by the coordinator).
 *  4. Global budget — the TOTAL across pools never exceeds the shared host budget.
 *
 *  + terminalStatus: the sole 'all pools exhausted' pause authorization.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ClaimRegistry } = await import("../../src/shared/quota/claimRegistry.ts");
const { HybridSpillCoordinator } = await import(
  "../../src/shared/dispatch/coordinator.ts"
);

// Configured hosted-pool concurrency so the shared fold yields a wave > 1, which
// is what makes the proactive split observable (the fold still owns every cap).
const SESSION = { quota: { unknown_hosted_concurrency: 8 } };

function nodes(count, tokens = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    id: `n-${i}`,
    estimatedTokens: tokens,
  }));
}

function pool(id, over = {}) {
  return {
    id,
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
    ...over,
  };
}

function snapshot(remainingPct) {
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
  const set = new Set();
  return {
    readSettled: () => set,
    onSettle: (poolId) => set.add(poolId),
    set,
  };
}

// Always-granting in-memory ClaimRegistry stand-in for the deterministic tests.
function fakeRegistry() {
  const held = new Set();
  return {
    async claim(nodeId) {
      if (held.has(nodeId)) return { acquired: false, heldBy: "other" };
      held.add(nodeId);
      return { acquired: true, ownerToken: `tok-${nodeId}` };
    },
    async release(nodeId) {
      return held.delete(nodeId);
    },
  };
}

function countByPool(assignments) {
  const m = new Map();
  for (const a of assignments) m.set(a.poolId, (m.get(a.poolId) ?? 0) + 1);
  return m;
}

test("A8: two-loop single-assignment — exactly one claimant across a shared registry (CE-001)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a8-audit-claim-"));
  try {
    const registryPath = join(dir, "claim-registry.json");
    const reg = new ClaimRegistry(registryPath);
    const store = settledStore();
    const mk = (poolId) =>
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
    assert.equal(new Set(all).size, all.length);
    assert.ok(all.length > 0);
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
  assert.ok(healthyCount > 0);
  assert.ok(healthyCount > degradedCount);
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
  assert.ok(assignments.length >= 1);
  assert.ok(assignments.every((a) => a.poolId === "pool/silent"));
});

test("A8: global budget — total across pools never exceeds the shared host budget", async () => {
  const store = settledStore();
  const reg = fakeRegistry();
  const hostLimit = {
    active_subagents: 2,
    source: "host_reported",
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
  assert.ok(assignments.length <= 2);
  assert.ok(assignments.length > 0);
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

  assert.equal(coord.terminalStatus(["n-0"]).kind, "dispatchable");

  await coord.settlePool("pool/0");
  assert.equal(coord.terminalStatus(["n-0"]).kind, "dispatchable");
  const onlyP1 = await coord.planAssignments(nodes(4));
  assert.ok(onlyP1.every((a) => a.poolId === "pool/1"));

  await coord.settlePool("pool/1");
  const status = coord.terminalStatus(["n-0", "n-1"]);
  assert.equal(status.kind, "all_pools_exhausted");
  assert.equal(status.terminal.reason, "empty_pool");
  assert.deepEqual(status.terminal.stranded_ids, ["n-0", "n-1"]);
  assert.deepEqual(await coord.planAssignments(nodes(4)), []);
});
