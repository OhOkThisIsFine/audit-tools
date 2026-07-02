import { test, expect } from "vitest";

const {
  normalizeCheckpointValue,
  computeGateVersion,
  intentCheckpointEquivalenceGate,
  runIntentCheckpointGate,
  DEFAULT_NORMALIZE_CONFIG,
} = await import("../../src/audit/orchestrator/intentCheckpointGate.ts");

function checkpoint(over = {}) {
  return {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: "2026-06-24T00:00:00.000Z",
    confirmed_by: "host",
    scope_summary: "Root: /x, files in scope: 10",
    intent_summary: "full-audit",
    ...over,
  };
}

test("normalize ignores volatile fields and whitespace", () => {
  const a = normalizeCheckpointValue(checkpoint());
  const b = normalizeCheckpointValue(
    checkpoint({
      confirmed_at: "2099-01-01T00:00:00.000Z",
      intent_summary: "  full-audit  ",
    }),
  );
  expect(a, "volatile + whitespace differences normalize identically").toBe(b);
});

test("absent vs present is a real difference", () => {
  expect(normalizeCheckpointValue(undefined)).not.toBe(normalizeCheckpointValue(checkpoint()));
});

test("equal normal forms => unchanged without judge call", async () => {
  let judgeCalls = 0;
  const res = await intentCheckpointEquivalenceGate({
    prior: checkpoint(),
    next: checkpoint({ confirmed_at: "2099-01-01T00:00:00.000Z" }),
    judge: () => {
      judgeCalls += 1;
      return true;
    },
    judgeId: "host",
  });
  expect(res.verdict).toBe("unchanged");
  expect(res.judged).toBe(false);
  expect(judgeCalls, "no judge call when normal forms match").toBe(0);
});

test("differing forms => judge runs; uncertain/non-boolean is fail-safe changed", async () => {
  const res = await intentCheckpointEquivalenceGate({
    prior: checkpoint({ intent_summary: "full-audit" }),
    next: checkpoint({ intent_summary: "security-only" }),
    judge: () => undefined, // non-boolean => fail-safe
    judgeId: "host",
  });
  expect(res.verdict).toBe("changed");
  expect(res.judged).toBe(true);
});

test("judge throw => fail-safe changed", async () => {
  const res = await intentCheckpointEquivalenceGate({
    prior: checkpoint({ intent_summary: "a" }),
    next: checkpoint({ intent_summary: "b" }),
    judge: () => {
      throw new Error("boom");
    },
    judgeId: "host",
  });
  expect(res.verdict).toBe("changed");
});

test("explicit true => unchanged", async () => {
  const res = await intentCheckpointEquivalenceGate({
    prior: checkpoint({ intent_summary: "a" }),
    next: checkpoint({ intent_summary: "a (reworded)" }),
    judge: () => true,
    judgeId: "host",
  });
  expect(res.verdict).toBe("unchanged");
});

test("verdict cached on (prior,new,gate_version); judge runs once", async () => {
  let judgeCalls = 0;
  const store = new Map();
  const cache = { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  const args = {
    prior: checkpoint({ intent_summary: "a" }),
    next: checkpoint({ intent_summary: "b" }),
    judge: () => {
      judgeCalls += 1;
      return false;
    },
    judgeId: "host",
    cache,
  };
  const r1 = await intentCheckpointEquivalenceGate(args);
  const r2 = await intentCheckpointEquivalenceGate(args);
  expect(r1.verdict).toBe("changed");
  expect(r2.verdict).toBe("changed");
  expect(judgeCalls, "second call is a cache hit").toBe(1);
  expect(r2.judged).toBe(false);
});

test("gate_version is local (no probe) and changes with judgeId/config", () => {
  const v1 = computeGateVersion({ judgeId: "host" });
  const v2 = computeGateVersion({ judgeId: "other-model" });
  expect(v1, "judge id participates").not.toBe(v2);
  const v3 = computeGateVersion({
    judgeId: "host",
    normalizeConfig: { ...DEFAULT_NORMALIZE_CONFIG, version: "v2" },
  });
  expect(v1, "normalize config participates").not.toBe(v3);
});

test("lock interleave: clean run commits, no fallback", async () => {
  let token = "t0";
  const committed = [];
  const res = await runIntentCheckpointGate({
    withLock: (fn) => fn(),
    readLedgerToken: () => token,
    gate: async () => ({ verdict: "changed", gateVersion: "gv" }),
    commit: async (v) => {
      committed.push(v);
      return v;
    },
  });
  expect(res.verdict).toBe("changed");
  expect(res.usedFallback).toBe(false);
  expect(committed).toEqual(["changed"]);
});

test("lock interleave: token moves during judge => re-derive, then commit", async () => {
  let token = "t0";
  let gateCalls = 0;
  const res = await runIntentCheckpointGate({
    withLock: (fn) => fn(),
    readLedgerToken: () => token,
    gate: async () => {
      gateCalls += 1;
      // First judge run: simulate an interleaved append by moving the token,
      // but only once so the second attempt commits cleanly.
      if (gateCalls === 1) token = "t1";
      return { verdict: "unchanged", gateVersion: "gv" };
    },
    commit: async (v) => v,
    maxAttempts: 3,
  });
  expect(res.verdict).toBe("unchanged");
  expect(res.usedFallback).toBe(false);
  expect(gateCalls >= 2, "re-derived after interleave").toBeTruthy();
});

test("lock interleave: persistent contention => lock-across-judge fallback commits", async () => {
  let token = 0;
  const res = await runIntentCheckpointGate({
    withLock: (fn) => fn(),
    // Token moves on every read => every attempt sees an interleave.
    readLedgerToken: () => `t${token++}`,
    gate: async () => ({ verdict: "changed", gateVersion: "gv" }),
    commit: async (v) => v,
    maxAttempts: 2,
  });
  expect(res.usedFallback, "fell back after exhausting attempts").toBe(true);
  expect(res.verdict).toBe("changed");
});
