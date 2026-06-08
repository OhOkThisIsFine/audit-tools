import test from "node:test";
import assert from "node:assert/strict";

const {
  computeDispatchCapacity,
  summarizeDispatchCapacityPools,
} = await import("../src/quota/capacity.ts");

function hostLimit(n) {
  return { active_subagents: n, source: "cli_flags", description: "test host limit" };
}

function hostPool(id, overrides = {}) {
  return {
    id,
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
    ...overrides,
  };
}

test("single pool: capacity is the full pending layout capped by host concurrency", () => {
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: hostLimit(4) })],
    sessionConfig: {},
    pendingItemTokens: new Array(17).fill(30000),
  });
  // Ambition is the 17 pending items; the host's 4-subagent ceiling binds — NOT a
  // preset wave size, and not the pathological serialized-to-1.
  assert.equal(capacity.total_slots, 4);
  assert.equal(capacity.binding_cap, "host_concurrency");
  assert.equal(capacity.pools.length, 1);
  assert.equal(capacity.primary.slots, 4);
  // Estimated tokens for one wave = the top-4 packets' costs.
  assert.equal(capacity.estimated_wave_tokens, 4 * 30000);
});

test("single pool: never dispatches more slots than there are pending items", () => {
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: hostLimit(8) })],
    sessionConfig: {},
    pendingItemTokens: [1000, 1000],
  });
  assert.equal(capacity.total_slots, 2);
});

test("single pool, no host ceiling: a parallel agent host fans out instead of serializing to 1", () => {
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: null })],
    sessionConfig: {},
    pendingItemTokens: new Array(20).fill(1000),
  });
  // claude-code with no learned history and no host cap defaults to parallel
  // dispatch (DEFAULT_AGENT_HOST_CONCURRENCY = 8), never 1.
  assert.ok(capacity.total_slots > 1, `expected parallel dispatch, got ${capacity.total_slots}`);
});

test("multi pool: capacity sums independent host pool slots", () => {
  const capacity = computeDispatchCapacity({
    pools: [
      hostPool("cli", { hostConcurrencyLimit: hostLimit(2) }),
      hostPool("ide", { hostConcurrencyLimit: hostLimit(3) }),
    ],
    sessionConfig: {},
    pendingItemTokens: [900, 800, 700, 600, 500, 400],
  });
  assert.equal(capacity.total_slots, 5);
  assert.equal(capacity.binding_cap, "host_concurrency");
  assert.deepEqual(capacity.pools.map((p) => [p.pool_id, p.slots]), [
    ["cli", 2],
    ["ide", 3],
  ]);
  assert.equal(capacity.estimated_wave_tokens, 900 + 800 + 700 + 600 + 500);
  assert.equal(capacity.primary.pool_id, "ide");
});

test("multi pool: total slots never exceed pending item count", () => {
  const capacity = computeDispatchCapacity({
    pools: [
      hostPool("cli", { hostConcurrencyLimit: hostLimit(8) }),
      hostPool("ide", { hostConcurrencyLimit: hostLimit(8) }),
    ],
    sessionConfig: {},
    pendingItemTokens: [1000, 1000],
  });
  assert.equal(capacity.total_slots, 2);
  assert.equal(
    capacity.pools.reduce((sum, pool) => sum + pool.slots, 0),
    2,
  );
});

test("multi pool: summary exposes serializable per-pool quota metadata", () => {
  const capacity = computeDispatchCapacity({
    pools: [
      hostPool("cli", { hostConcurrencyLimit: hostLimit(1) }),
      hostPool("ide", { hostConcurrencyLimit: hostLimit(2) }),
    ],
    sessionConfig: {},
    pendingItemTokens: [3000, 2000, 1000],
  });
  const summaries = summarizeDispatchCapacityPools(capacity);
  assert.deepEqual(summaries.map((s) => [s.pool_id, s.slots]), [
    ["cli", 1],
    ["ide", 2],
  ]);
  assert.equal(summaries[0].binding_cap, "host_concurrency");
  assert.equal(summaries[0].resolved_limits.context_tokens > 0, true);
});

test("computeDispatchCapacity rejects an empty pool list", () => {
  assert.throws(
    () => computeDispatchCapacity({
      pools: [],
      sessionConfig: {},
      pendingItemTokens: [1000],
    }),
    /at least one capacity pool/i,
  );
});
