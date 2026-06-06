import test from "node:test";
import assert from "node:assert/strict";

const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");

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

test("computeDispatchCapacity accepts exactly one pool and returns total_slots >= 1 with one pool allocation", () => {
  // pools is a single-element tuple [CapacityPool] — the single-pool constraint is
  // now statically enforced at compile time rather than by a runtime guard.
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: hostLimit(3) })],
    sessionConfig: {},
    pendingItemTokens: new Array(5).fill(10000),
  });
  assert.ok(capacity.total_slots >= 1, `expected total_slots >= 1, got ${capacity.total_slots}`);
  assert.equal(capacity.pools.length, 1);
});

// NOTE: passing `pools: []` or `pools: [pool1, pool2]` to ComputeDispatchCapacityInput is a
// TypeScript compile-time error (the type is `[CapacityPool]`, a single-element tuple).
// No runtime guard is needed — TypeScript rejects zero or multiple pools before the code runs.
