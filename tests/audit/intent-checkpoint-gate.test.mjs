import test from "node:test";
import assert from "node:assert/strict";

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
  assert.equal(a, b, "volatile + whitespace differences normalize identically");
});

test("absent vs present is a real difference", () => {
  assert.notEqual(
    normalizeCheckpointValue(undefined),
    normalizeCheckpointValue(checkpoint()),
  );
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
  assert.equal(res.verdict, "unchanged");
  assert.equal(res.judged, false);
  assert.equal(judgeCalls, 0, "no judge call when normal forms match");
});

test("differing forms => judge runs; uncertain/non-boolean is fail-safe changed", async () => {
  const res = await intentCheckpointEquivalenceGate({
    prior: checkpoint({ intent_summary: "full-audit" }),
    next: checkpoint({ intent_summary: "security-only" }),
    judge: () => undefined, // non-boolean => fail-safe
    judgeId: "host",
  });
  assert.equal(res.verdict, "changed");
  assert.equal(res.judged, true);
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
  assert.equal(res.verdict, "changed");
});

test("explicit true => unchanged", async () => {
  const res = await intentCheckpointEquivalenceGate({
    prior: checkpoint({ intent_summary: "a" }),
    next: checkpoint({ intent_summary: "a (reworded)" }),
    judge: () => true,
    judgeId: "host",
  });
  assert.equal(res.verdict, "unchanged");
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
  assert.equal(r1.verdict, "changed");
  assert.equal(r2.verdict, "changed");
  assert.equal(judgeCalls, 1, "second call is a cache hit");
  assert.equal(r2.judged, false);
});

test("gate_version is local (no probe) and changes with judgeId/config", () => {
  const v1 = computeGateVersion({ judgeId: "host" });
  const v2 = computeGateVersion({ judgeId: "other-model" });
  assert.notEqual(v1, v2, "judge id participates");
  const v3 = computeGateVersion({
    judgeId: "host",
    normalizeConfig: { ...DEFAULT_NORMALIZE_CONFIG, version: "v2" },
  });
  assert.notEqual(v1, v3, "normalize config participates");
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
  assert.equal(res.verdict, "changed");
  assert.equal(res.usedFallback, false);
  assert.deepEqual(committed, ["changed"]);
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
  assert.equal(res.verdict, "unchanged");
  assert.equal(res.usedFallback, false);
  assert.ok(gateCalls >= 2, "re-derived after interleave");
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
  assert.equal(res.usedFallback, true, "fell back after exhausting attempts");
  assert.equal(res.verdict, "changed");
});
