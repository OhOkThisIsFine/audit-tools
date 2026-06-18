import test from "node:test";
import assert from "node:assert/strict";

const {
  filterNewProviders,
  checkLivelockGuard,
  advancePausedState,
  LIVELOCK_PAUSE_LIMIT,
} = await import("../../src/shared/rolling/pausedState.ts");

// ---------------------------------------------------------------------------
// filterNewProviders
// ---------------------------------------------------------------------------

test("filterNewProviders — excludes settled providers, passes genuinely new ones", () => {
  const result = filterNewProviders(["a", "b", "c"], new Set(["a"]));
  assert.deepEqual(result, ["b", "c"]);
});

test("filterNewProviders — returns empty when all discovered are settled", () => {
  const result = filterNewProviders(["a"], new Set(["a", "b"]));
  assert.deepEqual(result, []);
});

test("filterNewProviders — returns empty when discovered is empty", () => {
  const result = filterNewProviders([], new Set(["a"]));
  assert.deepEqual(result, []);
});

test("filterNewProviders — returns all discovered when settled is empty", () => {
  const result = filterNewProviders(["x"], new Set());
  assert.deepEqual(result, ["x"]);
});

// ---------------------------------------------------------------------------
// checkLivelockGuard
// ---------------------------------------------------------------------------

test("checkLivelockGuard — returns false below limit", () => {
  assert.equal(checkLivelockGuard(2, 0, 3), false);
});

test("checkLivelockGuard — returns true at limit with no new capacity", () => {
  assert.equal(checkLivelockGuard(3, 0, 3), true);
});

test("checkLivelockGuard — returns true above limit", () => {
  assert.equal(checkLivelockGuard(5, 0, 3), true);
});

test("checkLivelockGuard — returns false when new capacity arrived even at limit", () => {
  assert.equal(checkLivelockGuard(3, 1, 3), false);
});

test("checkLivelockGuard — uses LIVELOCK_PAUSE_LIMIT as default", () => {
  // At exactly LIVELOCK_PAUSE_LIMIT with no new capacity → livelock
  assert.equal(checkLivelockGuard(LIVELOCK_PAUSE_LIMIT, 0), true);
  // One below — no livelock
  assert.equal(checkLivelockGuard(LIVELOCK_PAUSE_LIMIT - 1, 0), false);
});

// ---------------------------------------------------------------------------
// advancePausedState helpers
// ---------------------------------------------------------------------------

function makePausedState(pause_count = 0, stranded = ["node-1"]) {
  return {
    kind: /** @type {"waiting_for_provider"} */ ("waiting_for_provider"),
    paused_at: "2026-01-01T00:00:00.000Z",
    pause_count,
    stranded_node_ids: stranded,
  };
}

// ---------------------------------------------------------------------------
// advancePausedState — transitions to running
// ---------------------------------------------------------------------------

test("advancePausedState — returns running when genuinely new providers arrive", () => {
  const current = makePausedState(1);
  const result = advancePausedState({
    current,
    rediscoveredProviders: ["p2"],
    settledExclusions: new Set(["p1"]),
  });
  assert.equal(result.kind, "running");
});

test("advancePausedState — resets pause_count on transition to running (kind=running has no pause_count)", () => {
  const current = makePausedState(2);
  const result = advancePausedState({
    current,
    rediscoveredProviders: ["p2"],
    settledExclusions: new Set(),
  });
  assert.equal(result.kind, "running");
  // running state has no pause_count property
  assert.ok(!("pause_count" in result));
});

// ---------------------------------------------------------------------------
// advancePausedState — stays paused (below livelock limit)
// ---------------------------------------------------------------------------

test("advancePausedState — increments pause_count when no new providers and below limit", () => {
  const current = makePausedState(0, ["n1", "n2"]);
  const result = advancePausedState({
    current,
    rediscoveredProviders: ["p1"],
    settledExclusions: new Set(["p1"]),
    livelockLimit: 3,
  });
  assert.equal(result.kind, "waiting_for_provider");
  if (result.kind === "waiting_for_provider") {
    assert.equal(result.pause_count, 1);
  }
});

test("advancePausedState — preserves stranded_node_ids while paused", () => {
  const current = makePausedState(1, ["n-alpha", "n-beta"]);
  const result = advancePausedState({
    current,
    rediscoveredProviders: [],
    settledExclusions: new Set(),
    livelockLimit: 5,
  });
  assert.equal(result.kind, "waiting_for_provider");
  if (result.kind === "waiting_for_provider") {
    assert.deepEqual(result.stranded_node_ids, ["n-alpha", "n-beta"]);
  }
});

test("advancePausedState — preserves paused_at timestamp while paused", () => {
  const current = makePausedState(1);
  const result = advancePausedState({
    current,
    rediscoveredProviders: [],
    settledExclusions: new Set(),
    livelockLimit: 5,
  });
  assert.equal(result.kind, "waiting_for_provider");
  if (result.kind === "waiting_for_provider") {
    assert.equal(result.paused_at, current.paused_at);
  }
});

// ---------------------------------------------------------------------------
// advancePausedState — transitions to terminal/livelock
// ---------------------------------------------------------------------------

test("advancePausedState — returns terminal/livelock when livelock guard triggers", () => {
  // pause_count is 2, limit is 3; next call increments to 3 → livelock
  const current = makePausedState(2, ["stranded-1"]);
  const result = advancePausedState({
    current,
    rediscoveredProviders: [],
    settledExclusions: new Set(),
    livelockLimit: 3,
  });
  assert.equal(result.kind, "terminal");
  if (result.kind === "terminal") {
    assert.equal(result.reason, "livelock");
    assert.deepEqual(result.stranded_node_ids, ["stranded-1"]);
  }
});

test("advancePausedState — carries stranded_node_ids into terminal state", () => {
  const stranded = ["node-A", "node-B", "node-C"];
  const current = makePausedState(2, stranded);
  const result = advancePausedState({
    current,
    rediscoveredProviders: [],
    settledExclusions: new Set(),
    livelockLimit: 3,
  });
  assert.equal(result.kind, "terminal");
  if (result.kind === "terminal") {
    assert.deepEqual(result.stranded_node_ids, stranded);
  }
});

// ---------------------------------------------------------------------------
// INV-S03 — settled exclusions never re-offered across multiple rounds
// ---------------------------------------------------------------------------

test("INV-S03 — settled exclusions are never re-offered across multiple re-discovery rounds", () => {
  // Round 1: p1 is offered and excluded (settled)
  const settled = new Set(["p1"]);

  // Round 2: re-discovery surfaces ['p1', 'p2']
  const genuinelyNew = filterNewProviders(["p1", "p2"], settled);
  assert.deepEqual(genuinelyNew, ["p2"]);

  // settled set is not mutated by filterNewProviders
  assert.equal(settled.size, 1);
  assert.ok(settled.has("p1"));
  assert.ok(!settled.has("p2"));
});
