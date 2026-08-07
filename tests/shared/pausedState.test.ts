import { test, expect, vi } from "vitest";

// CP-NODE-3(a)/(b) no-I/O proof: replace node:fs/promises for THIS test file
// with a proxy that throws on any property access. vi.spyOn cannot patch a
// live ES module namespace (Node's fs/promises exports are non-configurable),
// so vi.mock is the only way to make an accidental fs call fail loudly rather
// than silently succeed/no-op. pausedState.ts's compiled output has zero
// runtime imports (its only reference to the providers layer is an
// `import type`, fully erased), so no test below should ever reach this mock.
vi.mock("node:fs/promises", () => {
  const throwing = (methodName: string) => () => {
    throw new Error(`unexpected node:fs/promises.${methodName} call from pausedState.ts`);
  };
  return new Proxy(
    { __esModule: true },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        return throwing(prop);
      },
    },
  );
});

import {
  filterNewProviders,
  checkLivelockGuard,
  advancePausedState,
  classifyProviderConstructionAttempt,
  LIVELOCK_PAUSE_LIMIT,
  type RollingEngineLifecycleState,
} from "../../src/shared/rolling/pausedState.js";

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

function makePausedState(
  pause_count = 0,
  stranded: string[] = ["node-1"],
): Extract<RollingEngineLifecycleState, { kind: "waiting_for_provider" }> {
  return {
    kind: "waiting_for_provider",
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

// ---------------------------------------------------------------------------
// CP-NODE-3(a) — explicit clear-persisted-state directive
// ---------------------------------------------------------------------------

test("CP-NODE-3(a) — a resume transition (kind=running) carries clear_persisted_state: true", () => {
  const current = makePausedState(1);
  const result = advancePausedState({
    current,
    rediscoveredProviders: ["p2"],
    settledExclusions: new Set(["p1"]),
  });
  expect(result.kind).toBe("running");
  expect(result.clear_persisted_state).toBe(true);
});

test("CP-NODE-3(a) — a terminal/livelock promotion carries clear_persisted_state: true", () => {
  const current = makePausedState(2, ["stranded-1"]);
  const result = advancePausedState({
    current,
    rediscoveredProviders: [],
    settledExclusions: new Set(),
    livelockLimit: 3,
  });
  expect(result.kind).toBe("terminal");
  expect(result.clear_persisted_state).toBe(true);
});

test("CP-NODE-3(a) — a continued-pause transition (kind=waiting_for_provider) does NOT carry the clear directive", () => {
  const current = makePausedState(0, ["n1", "n2"]);
  const result = advancePausedState({
    current,
    rediscoveredProviders: ["p1"],
    settledExclusions: new Set(["p1"]),
    livelockLimit: 3,
  });
  expect(result.kind).toBe("waiting_for_provider");
  expect(result.clear_persisted_state).toBe(false);
});

test("CP-NODE-3(a)/(b) — advancePausedState and classifyProviderConstructionAttempt never touch the filesystem, on any branch", () => {
  // node:fs/promises is replaced module-wide (see the vi.mock above) with a
  // proxy that throws on ANY property access — so if pausedState.ts (or
  // anything it pulls in at runtime) touched the filesystem on any branch
  // below, this test would throw instead of silently passing.

  // running branch
  advancePausedState({
    current: makePausedState(1),
    rediscoveredProviders: ["p2"],
    settledExclusions: new Set(["p1"]),
  });
  // waiting_for_provider (continued-pause) branch
  advancePausedState({
    current: makePausedState(0),
    rediscoveredProviders: [],
    settledExclusions: new Set(),
    livelockLimit: 3,
  });
  // terminal/livelock branch
  advancePausedState({
    current: makePausedState(2),
    rediscoveredProviders: [],
    settledExclusions: new Set(),
    livelockLimit: 3,
  });
  // classifyProviderConstructionAttempt: success branch
  classifyProviderConstructionAttempt(() => {}, ["n1"]);
  // classifyProviderConstructionAttempt: construction-failure branch
  classifyProviderConstructionAttempt(() => {
    const err = new Error("missing required config") as Error & {
      launchOutcome: { outcome: string };
    };
    err.launchOutcome = { outcome: "construction_failed" };
    throw err;
  }, ["n1"]);
  // classifyProviderConstructionAttempt: unrelated-throw branch (caught here,
  // it is expected to propagate — see the dedicated test below).
  try {
    classifyProviderConstructionAttempt(() => {
      throw new Error("unrelated failure");
    }, ["n1"]);
  } catch {
    // expected — see "propagates an unclassified error unchanged" below
  }

  // Reaching here without the mocked fs/promises proxy throwing IS the proof.
  expect(true).toBe(true);
});

// ---------------------------------------------------------------------------
// CP-NODE-3(b) — classifyProviderConstructionAttempt
// ---------------------------------------------------------------------------

function throwConstructionFailure(): never {
  const err = new Error("missing required config for provider 'codex'") as Error & {
    launchOutcome: {
      contract_version: string;
      outcome: string;
      retryable: boolean;
      kind: string;
      provider: string;
      reason: string;
    };
  };
  err.launchOutcome = {
    contract_version: "provider-launch-outcome-envelope/v1alpha1",
    outcome: "construction_failed",
    retryable: false,
    kind: "missing_required_config",
    provider: "codex",
    reason: err.message,
  };
  throw err;
}

test("classifyProviderConstructionAttempt — returns null when construction succeeds (no throw)", () => {
  let called = false;
  const result = classifyProviderConstructionAttempt(() => {
    called = true;
  }, ["n1"]);
  expect(called).toBe(true);
  expect(result).toBeNull();
});

test("classifyProviderConstructionAttempt — a synchronous construction_failed throw classifies directly to terminal/configuration", () => {
  const result = classifyProviderConstructionAttempt(throwConstructionFailure, ["n1", "n2"]);
  expect(result).not.toBeNull();
  expect(result?.kind).toBe("terminal");
  if (result?.kind === "terminal") {
    expect(result.reason).toBe("configuration");
    expect(result.stranded_node_ids).toEqual(["n1", "n2"]);
    expect(result.clear_persisted_state).toBe(true);
  }
});

test("classifyProviderConstructionAttempt — construction-failure classification never increments pause_count or re-enters re-discovery", () => {
  // This function's signature takes no `current` waiting_for_provider state
  // and calls neither filterNewProviders nor checkLivelockGuard — structurally,
  // there is no pause_count for it to increment and no re-discovery step for
  // it to re-enter. The returned terminal carries no pause_count field at all.
  const result = classifyProviderConstructionAttempt(throwConstructionFailure, ["n1"]);
  expect(result).not.toBeNull();
  expect("pause_count" in (result as object)).toBe(false);
});

test("classifyProviderConstructionAttempt — returns a fresh stranded_node_ids array (does not alias the input)", () => {
  const input = ["n1", "n2"];
  const result = classifyProviderConstructionAttempt(throwConstructionFailure, input);
  expect(result?.kind).toBe("terminal");
  if (result?.kind === "terminal") {
    expect(result.stranded_node_ids).toEqual(input);
    expect(result.stranded_node_ids).not.toBe(input);
    // Mutating the caller's array after the call must not affect the returned state.
    input.push("n3");
    expect(result.stranded_node_ids).toEqual(["n1", "n2"]);
  }
});

test("classifyProviderConstructionAttempt — propagates an unclassified error unchanged (does not swallow it)", () => {
  const original = new Error("some unrelated synchronous failure");
  expect(() => classifyProviderConstructionAttempt(() => {
    throw original;
  }, ["n1"])).toThrowError(original);
});

test("classifyProviderConstructionAttempt — propagates a throw whose launchOutcome is present but not construction_failed", () => {
  const err = new Error("rate limited") as Error & { launchOutcome: { outcome: string } };
  err.launchOutcome = { outcome: "rate_limited" };
  expect(() => classifyProviderConstructionAttempt(() => {
    throw err;
  }, ["n1"])).toThrowError(err);
});
