// Shared obligation engine (A3) — the single-source ordered-obligation scan.
// Locks the selection semantics both orchestrators rely on: priority is the
// authority on order AND membership; only missing/stale are actionable.
import test from "node:test";
import assert from "node:assert/strict";
import { findFirstActionableObligation } from "../dist/index.js";

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
