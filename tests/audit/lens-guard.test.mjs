import { test, expect } from "vitest";

const { ALL_LENSES, isLens } = await import("../../src/audit/types.ts");
const { LENSES } = await import("audit-tools/shared");

// Regression: a hand-copied lens list in flowRequeue.ts (and the legacy
// orchestrator.ts taskBuilder) omitted "observability", so isLens threw away a
// valid lens during flow requeue. Both now import the canonical guard.
test("isLens accepts every canonical lens, including observability", () => {
  // Count is read from the shared canonical vocabulary, not a magic literal:
  // audit's LENS_REGISTRY must match the single-sourced LENSES exactly.
  expect(ALL_LENSES.length).toBe(LENSES.length);
  expect(ALL_LENSES.includes("observability"), "observability must be canonical").toBeTruthy();
  expect(ALL_LENSES.includes("architecture"), "architecture must be canonical").toBeTruthy();
  for (const lens of ALL_LENSES) {
    expect(isLens(lens), `${lens} should be recognized as a valid lens`).toBeTruthy();
  }
});

test("isLens rejects non-lens values", () => {
  for (const value of ["", "nonsense", "Observability", null, undefined, 7, {}, []]) {
    expect(isLens(value), `${String(value)} should not be a lens`).toBe(false);
  }
});
