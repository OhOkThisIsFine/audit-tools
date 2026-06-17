// Shared obligation engine (A3) — the single-source ordered-obligation scan.
// Locks the selection semantics both orchestrators rely on: priority is the
// authority on order AND membership; only missing/stale are actionable.
import test from "node:test";
import assert from "node:assert/strict";
import {
  findFirstActionableObligation,
  findNextObligation,
  advance,
  DEFAULT_MAX_TRANSITIONS,
} from "../dist/index.js";

const PRIORITY = ["a", "b", "c", "d"];

test("selects the first actionable (missing/stale) obligation in priority order", () => {
  const obligations = [
    { id: "a", state: "satisfied" },
    { id: "b", state: "stale" },
    { id: "c", state: "missing" },
  ];
  // b precedes c in PRIORITY and is stale → b wins even though c is missing.
  assert.equal(findFirstActionableObligation(PRIORITY, obligations)?.id, "b");
});

test("priority order — not array order — decides the winner", () => {
  const obligations = [
    { id: "c", state: "missing" },
    { id: "b", state: "missing" },
  ];
  // Array lists c first, but b is earlier in PRIORITY.
  assert.equal(findFirstActionableObligation(PRIORITY, obligations)?.id, "b");
});

test("treats only missing and stale as actionable", () => {
  for (const state of ["present", "satisfied", "blocked"]) {
    const obligations = [{ id: "a", state }];
    assert.equal(
      findFirstActionableObligation(PRIORITY, obligations),
      undefined,
      `${state} must be non-actionable`,
    );
  }
  for (const state of ["missing", "stale"]) {
    const obligations = [{ id: "a", state }];
    assert.equal(
      findFirstActionableObligation(PRIORITY, obligations)?.id,
      "a",
      `${state} must be actionable`,
    );
  }
});

test("returns undefined when every obligation is non-actionable", () => {
  const obligations = [
    { id: "a", state: "satisfied" },
    { id: "b", state: "present" },
  ];
  assert.equal(findFirstActionableObligation(PRIORITY, obligations), undefined);
});

test("priority is the authority on membership — an obligation absent from priority is never selected", () => {
  const obligations = [{ id: "z", state: "missing" }];
  assert.equal(findFirstActionableObligation(PRIORITY, obligations), undefined);
});

test("priority ids with no matching obligation are skipped", () => {
  const obligations = [{ id: "d", state: "missing" }];
  // a, b, c have no obligation; scan skips them and reaches d.
  assert.equal(findFirstActionableObligation(PRIORITY, obligations)?.id, "d");
});

test("returns the same object reference (callers read .reason / domain fields)", () => {
  const target = { id: "b", state: "missing", reason: "because" };
  const result = findFirstActionableObligation(PRIORITY, [target]);
  assert.equal(result, target);
  assert.equal(result?.reason, "because");
});

// --- findNextObligation: the derive()-driven scan over function obligations ---

test("findNextObligation derives each obligation's state then scans in priority order", () => {
  const defs = [
    { id: "a", derive: () => "satisfied", execute: async () => ({ kind: "emit", step: "a" }) },
    { id: "b", derive: () => "missing", execute: async () => ({ kind: "emit", step: "b" }) },
    { id: "c", derive: () => "missing", execute: async () => ({ kind: "emit", step: "c" }) },
  ];
  // a is satisfied; b precedes c in PRIORITY → b is selected.
  assert.equal(findNextObligation(PRIORITY, defs, {})?.id, "b");
});

test("findNextObligation passes state into derive so selection tracks the live state", () => {
  const defs = [
    { id: "a", derive: (s) => (s.phase === "x" ? "missing" : "satisfied"), execute: async () => ({ kind: "emit", step: "a" }) },
    { id: "b", derive: (s) => (s.phase === "y" ? "missing" : "satisfied"), execute: async () => ({ kind: "emit", step: "b" }) },
  ];
  assert.equal(findNextObligation(PRIORITY, defs, { phase: "x" })?.id, "a");
  assert.equal(findNextObligation(PRIORITY, defs, { phase: "y" })?.id, "b");
  assert.equal(findNextObligation(PRIORITY, defs, { phase: "z" }), undefined);
});

// --- advance: the transition/emit drive loop ---

test("advance returns the first actionable obligation's emit (one bounded unit)", async () => {
  let bExecuted = 0;
  const engine = {
    priority: PRIORITY,
    obligations: [
      { id: "a", derive: () => "missing", execute: async () => ({ kind: "emit", step: "step-a" }) },
      { id: "b", derive: () => "missing", execute: async () => { bExecuted++; return { kind: "emit", step: "step-b" }; } },
    ],
  };
  const { step } = await advance(engine, {}, {});
  // emit-only engine stops after exactly one unit; the lower-priority b never runs.
  assert.equal(step, "step-a");
  assert.equal(bExecuted, 0);
});

test("advance folds a transition into a re-scan within one call", async () => {
  const engine = {
    priority: ["a", "b"],
    obligations: [
      { id: "a", derive: (s) => (s.status === "start" ? "missing" : "satisfied"), execute: async (s) => ({ kind: "transition", state: { ...s, status: "mid" } }) },
      { id: "b", derive: (s) => (s.status === "mid" ? "missing" : "satisfied"), execute: async () => ({ kind: "emit", step: "step-b" }) },
    ],
  };
  const { state, step } = await advance(engine, { status: "start" }, {});
  // a transitions start→mid, then the re-scan selects b which emits — one call.
  assert.equal(step, "step-b");
  assert.equal(state.status, "mid");
});

test("advance returns step:null when nothing is actionable (run complete)", async () => {
  const engine = {
    priority: ["a"],
    obligations: [{ id: "a", derive: () => "satisfied", execute: async () => ({ kind: "emit", step: "never" }) }],
  };
  const { step } = await advance(engine, {}, {});
  assert.equal(step, null);
});

test("advance carries an emit's mutated state back to the caller", async () => {
  const engine = {
    priority: ["a"],
    obligations: [{ id: "a", derive: () => "missing", execute: async (s) => ({ kind: "emit", step: "s", state: { ...s, closed: true } }) }],
  };
  const { state, step } = await advance(engine, { closed: false }, {});
  assert.equal(step, "s");
  assert.equal(state.closed, true);
});

test("advance leaves state unchanged when an emit omits state", async () => {
  const original = { keep: 1 };
  const engine = {
    priority: ["a"],
    obligations: [{ id: "a", derive: () => "missing", execute: async () => ({ kind: "emit", step: "s" }) }],
  };
  const { state } = await advance(engine, original, {});
  assert.equal(state, original);
});

test("advance threads ctx into execute", async () => {
  let seen;
  const engine = {
    priority: ["a"],
    obligations: [{ id: "a", derive: () => "missing", execute: async (_s, ctx) => { seen = ctx; return { kind: "emit", step: "s" }; } }],
  };
  await advance(engine, {}, { dep: 42 });
  assert.deepEqual(seen, { dep: 42 });
});

test("advance throws when transitions exceed maxTransitions (cycle backstop)", async () => {
  const engine = {
    priority: ["loop"],
    // Always actionable, always transitions to a fresh object that is still
    // actionable → never reaches emit/completion.
    obligations: [{ id: "loop", derive: () => "missing", execute: async (s) => ({ kind: "transition", state: { ...s } }) }],
  };
  await assert.rejects(
    () => advance(engine, {}, {}, { maxTransitions: 5 }),
    /exceeded maxTransitions \(5\).*"loop".*cycle/s,
  );
});

test("advance default transition cap is exported and finite", () => {
  assert.equal(typeof DEFAULT_MAX_TRANSITIONS, "number");
  assert.ok(DEFAULT_MAX_TRANSITIONS > 0 && Number.isFinite(DEFAULT_MAX_TRANSITIONS));
});
