import test from "node:test";
import assert from "node:assert/strict";

const { ALL_LENSES, isLens } = await import("../src/types.ts");

// Regression: a hand-copied lens list in flowRequeue.ts (and the legacy
// orchestrator.ts taskBuilder) omitted "observability", so isLens threw away a
// valid lens during flow requeue. Both now import the canonical guard.
test("isLens accepts every canonical lens, including observability", () => {
  assert.equal(ALL_LENSES.length, 11);
  assert.ok(ALL_LENSES.includes("observability"), "observability must be canonical");
  assert.ok(ALL_LENSES.includes("architecture"), "architecture must be canonical");
  for (const lens of ALL_LENSES) {
    assert.ok(isLens(lens), `${lens} should be recognized as a valid lens`);
  }
});

test("isLens rejects non-lens values", () => {
  for (const value of ["", "nonsense", "Observability", null, undefined, 7, {}, []]) {
    assert.equal(isLens(value), false, `${String(value)} should not be a lens`);
  }
});
