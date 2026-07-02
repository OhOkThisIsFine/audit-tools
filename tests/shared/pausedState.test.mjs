import { test, expect } from "vitest";

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
  expect(result).toEqual(["b", "c"]);
});

test("filterNewProviders — returns empty when all discovered are settled", () => {
  const result = filterNewProviders(["a"], new Set(["a", "b"]));
  expect(result).toEqual([]);
});

test("filterNewProviders — returns empty when discovered is empty", () => {
  const result = filterNewProviders([], new Set(["a"]));
  expect(result).toEqual([]);
});

test("filterNewProviders — returns all discovered when settled is empty", () => {
  const result = filterNewProviders(["x"], new Set());
  expect(result).toEqual(["x"]);
});

// ---------------------------------------------------------------------------
// checkLivelockGuard
// ---------------------------------------------------------------------------

test("checkLivelockGuard — returns false below limit", () => {
  expect(checkLivelockGuard(2, 0, 3)).toBe(false);
});

test("checkLivelockGuard — returns true at limit with no new capacity", () => {
  expect(checkLivelockGuard(3, 0, 3)).toBe(true);
});

test("checkLivelockGuard — returns true above limit", () => {
  expect(checkLivelockGuard(5, 0, 3)).toBe(true);
});

test("checkLivelockGuard — returns false when new capacity arrived even at limit", () => {
  expect(checkLivelockGuard(3, 1, 3)).toBe(false);
});

test("checkLivelockGuard — uses LIVELOCK_PAUSE_LIMIT as default", () => {
  // At exactly LIVELOCK_PAUSE_LIMIT with no new capacity → livelock
  expect(checkLivelockGuard(LIVELOCK_PAUSE_LIMIT, 0)).toBe(true);
  // One below — no livelock
  expect(checkLivelockGuard(LIVELOCK_PAUSE_LIMIT - 1, 0)).toBe(false);
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
  expect(result.kind).toBe("running");
});

test("advancePausedState — resets pause_count on transition to running (kind=running has no pause_count)", () => {
  const current = makePausedState(2);
  const result = advancePausedState({
    current,
    rediscoveredProviders: ["p2"],
    settledExclusions: new Set(),
  });
  expect(result.kind).toBe("running");
  // running state has no pause_count property
  expect(!("pause_count" in result)).toBeTruthy();
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
  expect(result.kind).toBe("waiting_for_provider");
  if (result.kind === "waiting_for_provider") {
    expect(result.pause_count).toBe(1);
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
  expect(result.kind).toBe("waiting_for_provider");
  if (result.kind === "waiting_for_provider") {
    expect(result.stranded_node_ids).toEqual(["n-alpha", "n-beta"]);
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
  expect(result.kind).toBe("waiting_for_provider");
  if (result.kind === "waiting_for_provider") {
    expect(result.paused_at).toBe(current.paused_at);
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
  expect(result.kind).toBe("terminal");
  if (result.kind === "terminal") {
    expect(result.reason).toBe("livelock");
    expect(result.stranded_node_ids).toEqual(["stranded-1"]);
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
  expect(result.kind).toBe("terminal");
  if (result.kind === "terminal") {
    expect(result.stranded_node_ids).toEqual(stranded);
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
  expect(genuinelyNew).toEqual(["p2"]);

  // settled set is not mutated by filterNewProviders
  expect(settled.size).toBe(1);
  expect(settled.has("p1")).toBeTruthy();
  expect(!settled.has("p2")).toBeTruthy();
});
