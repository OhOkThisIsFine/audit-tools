import { test, expect } from "vitest";
import assert from "node:assert/strict";

const {
  computeDispatchCapacity,
  summarizeDispatchCapacityPools,
} = await import("../../src/shared/quota/capacity.ts");

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
  expect(capacity.total_slots).toBe(4);
  expect(capacity.binding_cap).toBe("host_concurrency");
  expect(capacity.pools.length).toBe(1);
  expect(capacity.primary.slots).toBe(4);
  // Estimated tokens for one wave = the top-4 packets' costs.
  expect(capacity.estimated_wave_tokens).toBe(4 * 30000);
});

test("single pool: never dispatches more slots than there are pending items", () => {
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: hostLimit(8) })],
    sessionConfig: {},
    pendingItemTokens: [1000, 1000],
  });
  expect(capacity.total_slots).toBe(2);
});

test("single pool, no host ceiling: a parallel agent host fans out instead of serializing to 1", () => {
  const capacity = computeDispatchCapacity({
    pools: [hostPool("host", { hostConcurrencyLimit: null })],
    sessionConfig: {},
    pendingItemTokens: new Array(20).fill(1000),
  });
  // claude-code with no learned history and no host cap invents no floor and no
  // ceiling — it fans out across the pending work rather than serializing to 1.
  expect(capacity.total_slots > 1, `expected parallel dispatch, got ${capacity.total_slots}`).toBeTruthy();
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
  expect(capacity.total_slots).toBe(5);
  expect(capacity.binding_cap).toBe("host_concurrency");
  expect(capacity.pools.map((p) => [p.pool_id, p.slots])).toEqual([
    ["cli", 2],
    ["ide", 3],
  ]);
  expect(capacity.estimated_wave_tokens).toBe(900 + 800 + 700 + 600 + 500);
  expect(capacity.primary.pool_id).toBe("ide");
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
  expect(capacity.total_slots).toBe(2);
  expect(capacity.pools.reduce((sum, pool) => sum + pool.slots, 0)).toBe(2);
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
  expect(summaries.map((s) => [s.pool_id, s.slots])).toEqual([
    ["cli", 1],
    ["ide", 2],
  ]);
  expect(summaries[0].binding_cap).toBe("host_concurrency");
  expect(summaries[0].resolved_limits.context_tokens > 0).toBe(true);
});

test("a pool's concurrencyCap is carried through the allocation AND the serialized summary", () => {
  // C3 (NIM/Codex fix set): source pools carry an endpoint-declared count cap that
  // is NOT the host subagent budget. It must survive both in-memory (audit reads
  // the allocation) and serialization (remediate reads the summary) so each maps it
  // to AdmissionPool.declaredCap. It is a separate ceiling, so it does NOT enter the
  // slot math (host-less claude-code fans out on token/rate headroom as usual).
  const capacity = computeDispatchCapacity({
    pools: [hostPool("nim", { hostConcurrencyLimit: null, concurrencyCap: 3 })],
    sessionConfig: {},
    pendingItemTokens: new Array(10).fill(1000),
  });
  expect(capacity.pools[0].concurrencyCap, "allocation echoes the pool cap").toBe(3);
  const summaries = summarizeDispatchCapacityPools(capacity);
  expect(summaries[0].concurrency_cap, "summary serializes the pool cap").toBe(3);
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

test("a pool's contextCapTokens is carried through the allocation AND the serialized summary", () => {
  // U2 context-fit gate: source pools carry a per-request context-token cap that
  // gates packet fitting. It must survive both in-memory (audit reads the allocation)
  // and serialization (remediate reads the summary) so selection-time fit checking
  // works correctly. null/absent = unknown cap → no fit filtering.
  const capacity = computeDispatchCapacity({
    pools: [hostPool("worker", { hostConcurrencyLimit: null, contextCapTokens: 32000 })],
    sessionConfig: {},
    pendingItemTokens: [10000],
  });
  expect(capacity.pools[0].contextCapTokens, "allocation echoes the context cap").toBe(32000);
  const summaries = summarizeDispatchCapacityPools(capacity);
  expect(summaries[0].context_cap_tokens, "summary serializes the context cap").toBe(32000);
});

test("contextCapTokens: null (unknown) is absent from allocation and summary when unset", () => {
  // When contextCapTokens is null/absent, it is not included in the allocation or
  // summary (optional spread semantics). The fit-check code treats undefined and
  // null equivalently as "no cap → always fits".
  const capacity = computeDispatchCapacity({
    pools: [hostPool("unknown", { hostConcurrencyLimit: null, contextCapTokens: null })],
    sessionConfig: {},
    pendingItemTokens: [10000],
  });
  expect(capacity.pools[0].contextCapTokens).toBeUndefined();
  const summaries = summarizeDispatchCapacityPools(capacity);
  expect(summaries[0].context_cap_tokens).toBeUndefined();
});

test("INV-SCC-02 (COR-9a7a9790): all-oversized pending work still yields a structural capacity (total_slots >= 1, defined primary, binding-cap attribution)", () => {
  // Pending work is NON-empty but every packet (+ agentic harness overhead)
  // exceeds every pool's declared context cap, so the U2 fit-gate skips every
  // pool. The capacity contract over non-empty pools[] must still hold
  // structurally — a defined primary allocation, total_slots >= 1, and a
  // binding-cap attribution — never an empty-allocation crash or an undefined
  // primary the callers (.primary.schedule dereferences) would trip over. The
  // oversized packets then surface reactively at dispatch (packet_too_large).
  const capacity = computeDispatchCapacity({
    pools: [
      hostPool("small-a", { hostConcurrencyLimit: hostLimit(4), contextCapTokens: 16000 }),
      hostPool("small-b", { hostConcurrencyLimit: hostLimit(4), contextCapTokens: 20000 }),
    ],
    sessionConfig: {},
    // 50k + 15k overhead > both caps → zero fitting items in every pool.
    pendingItemTokens: [50000, 60000],
  });
  expect(capacity.total_slots).toBeGreaterThanOrEqual(1);
  expect(capacity.pools.length).toBeGreaterThanOrEqual(1);
  expect(capacity.primary, "primary allocation must be defined").toBeTruthy();
  expect(capacity.primary.schedule, "primary.schedule must be dereferenceable").toBeTruthy();
  expect(typeof capacity.binding_cap).toBe("string");
});
