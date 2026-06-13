/**
 * seam-dispatch-concurrency-model-agnostic-routing.test.mjs
 *
 * Cross-module seam test: dispatch-concurrency-and-model-agnostic-routing
 *
 * Enforces the contract between:
 *   - packages/audit-code/src/cli/dispatch/tierRouting.ts
 *     (resolveDispatchTier, resolveTierBudgets, computeDispatchFanout, TIER_RANK)
 *   - @audit-tools/shared dispatch/rollingDispatch
 *     (selectProvider, InFlightTokenTracker, createRollingDispatcher)
 *   - @audit-tools/shared quota/capacity
 *     (CapacityPool.rank typed as DispatchModelTier)
 *
 * Seam invariants:
 *   A. DispatchModelTier vocabulary is shared — tier names used by audit-code's
 *      TIER_RANK ("small"|"standard"|"deep") are the same strings used on
 *      CapacityPool.rank in @audit-tools/shared.
 *   B. resolveDispatchTier partition behavior: risk thresholds map to correct
 *      tiers (small < standard_at <= standard < deep_at <= deep). Escalators only
 *      raise, never lower, the risk baseline.
 *   C. resolveTierBudgets fallback: missing tiers fall back to the nearest
 *      LOWER reported rank (COR-eebbabf7 invariant: down before up on tie).
 *   D. selectProvider lane behavior: high-complexity packets (complexity >= 0.5)
 *      prefer the most-capable pool; low-complexity packets prefer the least-capable.
 *      Pool capability rank derives from CapacityPool.rank, not a provider-name table.
 *   E. computeDispatchFanout produces a serializable dispatch summary consistent
 *      with the agent_count / max_concurrent_agents / confirmation_recommended shape.
 *   F. createRollingDispatcher drives all enqueued packets to completion and
 *      routes high-complexity packets to the higher-ranked pool when two pools
 *      are available.
 */

import test from "node:test";
import assert from "node:assert/strict";

// ── audit-code tierRouting (local TypeScript, loaded via tsx/esm) ────────────
const {
  resolveDispatchTier,
  resolveTierBudgets,
  computeDispatchFanout,
  TIER_RANK,
  TIER_ORDER,
} = await import("../src/cli/dispatch/tierRouting.ts");

// ── Shared rolling dispatch (selectProvider, InFlightTokenTracker) ────────────
const {
  selectProvider,
  InFlightTokenTracker,
  createRollingDispatcher,
} = await import("@audit-tools/shared");

// ── Shared capacity (CapacityPool type is structural; we test rank field) ─────
// No runtime import needed for types — we verify behavioral compatibility below.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal CapacityPool that reports a given DispatchModelTier rank. The quota
 * headroom is left wide open (no quotaStateEntry, no discoveredLimits, no
 * hostConcurrencyLimit) so scheduleWave always grants a slot — this isolates
 * routing behavior from quota throttling.
 */
function openPool(id, rank = undefined) {
  return {
    id,
    providerName: "claude-code",
    hostModel: null,
    rank,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
  };
}

/** Minimal DispatchComplexity for use with resolveDispatchTier. */
function complexity(overrides = {}) {
  return {
    priority: "high",
    task_count: 1,
    file_count: 1,
    total_lines: 100,
    estimated_tokens: 1000,
    lenses: ["correctness"],
    tags: [],
    large_file_mode: false,
    ...overrides,
  };
}

/** Minimal RollingDispatchPacket. */
function packet(id, complexityScore, estimatedTokens = 100) {
  return { id, payload: { label: id }, estimatedTokens, complexity: complexityScore };
}

// ---------------------------------------------------------------------------
// A. DispatchModelTier vocabulary shared between audit-code and @audit-tools/shared
// ---------------------------------------------------------------------------

test("A1: TIER_RANK keys match the DispatchModelTier union used by CapacityPool.rank", () => {
  // The three string values valid for CapacityPool.rank (typed as DispatchModelTier
  // in @audit-tools/shared) must be exactly the three keys in TIER_RANK.
  const expectedTiers = ["small", "standard", "deep"];
  const actualKeys = Object.keys(TIER_RANK).sort();
  assert.deepEqual(
    actualKeys,
    expectedTiers.sort(),
    "TIER_RANK must cover exactly the DispatchModelTier union",
  );
});

test("A2: TIER_ORDER spans all DispatchModelTier values in ascending capability order", () => {
  assert.deepEqual(TIER_ORDER, ["small", "standard", "deep"]);
  // Ranks must be strictly ascending along TIER_ORDER.
  for (let i = 1; i < TIER_ORDER.length; i++) {
    assert.ok(
      TIER_RANK[TIER_ORDER[i]] > TIER_RANK[TIER_ORDER[i - 1]],
      `TIER_RANK[${TIER_ORDER[i]}] must be > TIER_RANK[${TIER_ORDER[i - 1]}]`,
    );
  }
});

test("A3: CapacityPool.rank 'deep' string is accepted as a valid TIER_RANK key", () => {
  // This verifies the shared string "deep" (from CapacityPool.rank) round-trips
  // through audit-code's TIER_RANK without losing its relative rank value.
  const pool = openPool("deep-pool", "deep");
  assert.ok(
    Object.prototype.hasOwnProperty.call(TIER_RANK, pool.rank),
    "'deep' rank from CapacityPool must be a key in TIER_RANK",
  );
});

// ---------------------------------------------------------------------------
// B. resolveDispatchTier partition behavior (risk-primary baseline + escalators)
// ---------------------------------------------------------------------------

test("B1: low routing_risk (<= standard_at) → small tier (baseline)", () => {
  const hint = resolveDispatchTier({
    routingRisk: 0.1,
    complexity: complexity(),
  });
  assert.equal(hint.tier, "small");
  assert.ok(hint.reasons.some((r) => r.startsWith("routing_risk:")));
});

test("B2: mid routing_risk (>= standard_at, < deep_at) → standard tier", () => {
  const hint = resolveDispatchTier({
    routingRisk: 0.5,
    complexity: complexity(),
  });
  assert.equal(hint.tier, "standard");
});

test("B3: high routing_risk (>= deep_at) → deep tier", () => {
  const hint = resolveDispatchTier({
    routingRisk: 0.8,
    complexity: complexity(),
  });
  assert.equal(hint.tier, "deep");
});

test("B4: undefined routing_risk → small tier (unknown baseline)", () => {
  const hint = resolveDispatchTier({
    routingRisk: undefined,
    complexity: complexity(),
  });
  assert.equal(hint.tier, "small");
  assert.ok(hint.reasons.includes("routing_risk:unknown"));
});

test("B5: deep escalator (large_file_mode) raises small baseline to deep", () => {
  const hint = resolveDispatchTier({
    routingRisk: 0.1,
    complexity: complexity({ large_file_mode: true }),
  });
  assert.equal(hint.tier, "deep");
  assert.ok(hint.reasons.includes("isolated_large_file"));
});

test("B6: standard escalator (sensitive_lens) raises small baseline to standard", () => {
  const hint = resolveDispatchTier({
    routingRisk: 0.1,
    complexity: complexity({ lenses: ["security"] }),
  });
  assert.equal(hint.tier, "standard");
  assert.ok(hint.reasons.includes("sensitive_lens"));
});

test("B7: deep escalator does NOT lower a deep baseline — escalators are raise-only", () => {
  // Risk is already deep; adding no escalators should keep it at deep.
  const hint = resolveDispatchTier({
    routingRisk: 0.9,
    complexity: complexity(),
  });
  assert.equal(hint.tier, "deep");
});

test("B8: critical_flow tag escalates to deep regardless of low risk", () => {
  const hint = resolveDispatchTier({
    routingRisk: 0.1,
    complexity: complexity({ tags: ["critical_flow"] }),
  });
  assert.equal(hint.tier, "deep");
  assert.ok(hint.reasons.includes("critical_flow"));
});

test("B9: custom routing_tiers overrides default cut-points", () => {
  // Move deep_at to 0.9 so risk=0.8 now lands at standard, not deep.
  const hint = resolveDispatchTier({
    routingRisk: 0.8,
    complexity: complexity(),
    routingTiers: { deep_at: 0.9, standard_at: 0.5 },
  });
  assert.equal(hint.tier, "standard");
});

// ---------------------------------------------------------------------------
// C. resolveTierBudgets fallback: down before up on tie
// ---------------------------------------------------------------------------

test("C1: all three tiers reported — each gets its own budget", () => {
  const input = new Map([
    ["small", 100],
    ["standard", 200],
    ["deep", 300],
  ]);
  const out = resolveTierBudgets(input);
  assert.equal(out.small, 100);
  assert.equal(out.standard, 200);
  assert.equal(out.deep, 300);
});

test("C2: only 'deep' reported — standard and small fall back to deep (nearest is deep, no lower available)", () => {
  const input = new Map([["deep", 300]]);
  const out = resolveTierBudgets(input);
  assert.equal(out.deep, 300);
  // standard has no lower tier below it when only deep is reported
  assert.equal(out.standard, 300);
  assert.equal(out.small, 300);
});

test("C3: only 'small' reported — standard and deep get small (nearest lower wins — COR-eebbabf7)", () => {
  const input = new Map([["small", 100]]);
  const out = resolveTierBudgets(input);
  assert.equal(out.small, 100);
  // standard: nearest lower = small (distance 1 down); up would be deep (distance 1 up — tie).
  // COR-eebbabf7 invariant: prefer lower on tie → small budget.
  assert.equal(out.standard, 100);
  assert.equal(out.deep, 100);
});

test("C4: 'small' and 'deep' reported — standard falls back to small (lower preferred on equal distance)", () => {
  // standard is equidistant from small (down) and deep (up).
  // COR-eebbabf7: prefer LOWER (less capable) on tie.
  const input = new Map([
    ["small", 50],
    ["deep", 500],
  ]);
  const out = resolveTierBudgets(input);
  assert.equal(out.small, 50);
  assert.equal(out.deep, 500);
  // standard: down=small(50), up=deep(500). lower preferred → 50.
  assert.equal(out.standard, 50);
});

test("C5: resolveTierBudgets rejects empty input", () => {
  assert.throws(
    () => resolveTierBudgets(new Map()),
    /at least one reported rank/i,
  );
});

// ---------------------------------------------------------------------------
// D. selectProvider lane behavior: complexity-based pool ordering
// ---------------------------------------------------------------------------

test("D1: high-complexity packet (0.9) routes to the highest-rank pool (deep > standard)", () => {
  const pools = [
    openPool("standard-pool", "standard"),
    openPool("deep-pool", "deep"),
  ];
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(
    packet("p1", 0.9, 1000),
    pools,
    tracker,
    {},
    {},
  );
  assert.ok(slot !== null, "should find a slot");
  assert.equal(slot.poolId, "deep-pool", "high-complexity must prefer the deep pool");
});

test("D2: low-complexity packet (0.1) routes to the lowest-rank pool (small < standard)", () => {
  const pools = [
    openPool("small-pool", "small"),
    openPool("standard-pool", "standard"),
  ];
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(
    packet("p2", 0.1, 500),
    pools,
    tracker,
    {},
    {},
  );
  assert.ok(slot !== null, "should find a slot");
  assert.equal(slot.poolId, "small-pool", "low-complexity must prefer the small pool");
});

test("D3: boundary packet (complexity=0.5) is treated as high-complexity", () => {
  // complexity >= 0.5 triggers descending sort (most-capable first)
  const pools = [
    openPool("small-pool", "small"),
    openPool("deep-pool", "deep"),
  ];
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(
    packet("p3", 0.5, 100),
    pools,
    tracker,
    {},
    {},
  );
  assert.ok(slot !== null, "boundary complexity should find a slot");
  assert.equal(slot.poolId, "deep-pool", "complexity 0.5 is high-complexity: prefer deep");
});

test("D4: pools without rank fall back to standard (neutral) — unknown provider is not mis-ranked", () => {
  // One pool with rank "deep", one without rank (should be neutral = standard).
  // High-complexity → deep pool preferred. Verifies rank-absent is not treated as deep.
  const pools = [
    openPool("no-rank-pool"),          // rank = undefined → neutral (standard)
    openPool("deep-pool", "deep"),     // explicitly deep
  ];
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(
    packet("p4", 0.9, 100),
    pools,
    tracker,
    {},
    {},
  );
  assert.ok(slot !== null);
  assert.equal(slot.poolId, "deep-pool", "explicit 'deep' rank must beat neutral (undefined rank)");
});

// ---------------------------------------------------------------------------
// E. computeDispatchFanout produces correct serializable summary shape
// ---------------------------------------------------------------------------

test("E1: 5 agents, max 2 concurrent → correct summary fields", () => {
  const fanout = computeDispatchFanout({ agentCount: 5, maxConcurrent: 2 });
  assert.equal(fanout.agent_count, 5);
  assert.equal(fanout.max_concurrent_agents, 2);
  assert.equal(fanout.confirmation_recommended, false); // 5 <= default threshold (10)
  assert.match(fanout.dispatch_summary, /5 agents/);
  assert.match(fanout.dispatch_summary, /max 2 concurrent/);
});

test("E2: agent_count > confirm_threshold triggers confirmation_recommended", () => {
  const fanout = computeDispatchFanout({
    agentCount: 15,
    maxConcurrent: 4,
    confirmThreshold: 10,
  });
  assert.equal(fanout.confirmation_recommended, true);
});

test("E3: 1 agent produces singular 'agent' label in dispatch_summary", () => {
  const fanout = computeDispatchFanout({ agentCount: 1, maxConcurrent: 1 });
  assert.match(fanout.dispatch_summary, /1 agent,/);
  assert.doesNotMatch(fanout.dispatch_summary, /1 agents/);
});

// ---------------------------------------------------------------------------
// F. createRollingDispatcher drives packets to completion with correct routing
// ---------------------------------------------------------------------------

test("F1: createRollingDispatcher routes packets and returns all results", async () => {
  const routed = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [openPool("only-pool", "standard")],
    sessionConfig: {},
    dispatchPacket: async (pkt, slot) => {
      routed.push({ id: pkt.id, poolId: slot.poolId });
      return { packet: pkt, outcome: "success" };
    },
  });

  dispatcher.enqueue([
    packet("a", 0.9),
    packet("b", 0.1),
    packet("c", 0.5),
  ]);

  const results = await dispatcher.run();
  assert.equal(results.length, 3);
  const resultIds = results.map((r) => r.packet.id).sort();
  assert.deepEqual(resultIds, ["a", "b", "c"]);
  assert.ok(results.every((r) => r.outcome === "success"));
});

test("F2: createRollingDispatcher with two rank pools routes high-complexity to deep pool", async () => {
  const routedTo = {};

  const dispatcher = createRollingDispatcher({
    confirmedPools: [
      openPool("small-pool", "small"),
      openPool("deep-pool", "deep"),
    ],
    sessionConfig: {},
    dispatchPacket: async (pkt, slot) => {
      routedTo[pkt.id] = slot.poolId;
      return { packet: pkt, outcome: "success" };
    },
  });

  dispatcher.enqueue([
    packet("hi", 0.9, 500),   // high-complexity → deep pool
    packet("lo", 0.0, 500),   // low-complexity  → small pool
  ]);

  await dispatcher.run();

  assert.equal(routedTo["hi"], "deep-pool",
    "high-complexity packet must be routed to the deep pool");
  assert.equal(routedTo["lo"], "small-pool",
    "low-complexity packet must be routed to the small pool");
});

test("F3: InFlightTokenTracker in-flight accounting round-trips correctly", () => {
  const tracker = new InFlightTokenTracker();
  tracker.recordDispatched("pool-a", 1000);
  tracker.recordDispatched("pool-a", 500);
  assert.equal(tracker.getInFlightTokens("pool-a"), 1500);

  tracker.recordCompleted("pool-a", 500);
  assert.equal(tracker.getInFlightTokens("pool-a"), 1000);

  // Unknown pool returns 0
  assert.equal(tracker.getInFlightTokens("pool-b"), 0);
});

test("F4: createRollingDispatcher deduplicate: enqueue same packet id twice → dispatched once", async () => {
  let dispatchCount = 0;

  const dispatcher = createRollingDispatcher({
    confirmedPools: [openPool("pool", "standard")],
    sessionConfig: {},
    dispatchPacket: async (pkt) => {
      dispatchCount++;
      return { packet: pkt, outcome: "success" };
    },
  });

  const p = packet("dup", 0.5);
  dispatcher.enqueue([p, p]);

  const results = await dispatcher.run();
  assert.equal(results.length, 1);
  assert.equal(dispatchCount, 1, "duplicate packet id must not be dispatched twice");
});
