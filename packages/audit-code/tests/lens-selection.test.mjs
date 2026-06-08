import test from "node:test";
import assert from "node:assert/strict";

const {
  resolveEffectiveLenses,
  validateLensSelection,
  MANDATORY_LENSES,
  isMandatoryLens,
  isLensEffective,
} = await import("../src/orchestrator/lensSelection.ts");

// ── MANDATORY_LENSES ─────────────────────────────────────────────────────────

test("MANDATORY_LENSES includes security, correctness, reliability, data_integrity", () => {
  const mandatory = new Set(MANDATORY_LENSES);
  assert.ok(mandatory.has("security"));
  assert.ok(mandatory.has("correctness"));
  assert.ok(mandatory.has("reliability"));
  assert.ok(mandatory.has("data_integrity"));
});

// ── resolveEffectiveLenses — defaults ────────────────────────────────────────

test("omitted selection resolves to the full all-lenses set", () => {
  const lenses = resolveEffectiveLenses(undefined);
  const set = new Set(lenses);
  for (const mandatory of MANDATORY_LENSES) {
    assert.ok(set.has(mandatory), `missing mandatory lens: ${mandatory}`);
  }
  // Should be 11 lenses (from LENSES const).
  assert.equal(lenses.length, 11);
});

test("null selection also resolves to the full set", () => {
  const lenses = resolveEffectiveLenses(null);
  assert.equal(lenses.length, 11);
});

// ── resolveEffectiveLenses — focused selection ────────────────────────────────

test("focused selection includes requested lens plus mandatory base lenses", () => {
  const lenses = resolveEffectiveLenses(["performance"]);
  const set = new Set(lenses);
  assert.ok(set.has("performance"));
  for (const mandatory of MANDATORY_LENSES) {
    assert.ok(set.has(mandatory), `missing mandatory lens: ${mandatory}`);
  }
});

test("focused selection de-duplicates lenses", () => {
  // correctness is both selected and mandatory.
  const lenses = resolveEffectiveLenses(["correctness", "correctness", "security"]);
  const seen = new Set();
  for (const lens of lenses) {
    assert.ok(!seen.has(lens), `duplicate lens: ${lens}`);
    seen.add(lens);
  }
});

test("resolved lenses are sorted in canonical LENSES registry order", () => {
  const lenses = resolveEffectiveLenses(["tests", "performance"]);
  // performance comes before tests in the canonical order.
  const perfIdx = lenses.indexOf("performance");
  const testsIdx = lenses.indexOf("tests");
  assert.ok(perfIdx < testsIdx, "performance should precede tests in canonical order");
});

test("unknown/invalid lenses in selection are silently filtered out", () => {
  const lenses = resolveEffectiveLenses(["performance", "not_a_lens"]);
  assert.ok(!lenses.includes("not_a_lens"));
  assert.ok(lenses.includes("performance"));
});

// ── validateLensSelection ─────────────────────────────────────────────────────

test("validateLensSelection returns empty issues for undefined", () => {
  assert.deepEqual(validateLensSelection(undefined), []);
});

test("validateLensSelection returns empty issues for null", () => {
  assert.deepEqual(validateLensSelection(null), []);
});

test("validateLensSelection returns empty issues for a valid lens array", () => {
  const issues = validateLensSelection(["security", "performance"]);
  assert.equal(issues.filter((i) => i.severity === "error").length, 0);
});

test("validateLensSelection rejects a non-array value", () => {
  const issues = validateLensSelection("security");
  assert.ok(issues.some((i) => i.severity === "error"));
});

test("validateLensSelection rejects unknown lens names", () => {
  const issues = validateLensSelection(["performance", "bogus_lens"]);
  assert.ok(issues.some((i) => i.path.includes("[1]")));
});

// ── isMandatoryLens ───────────────────────────────────────────────────────────

test("isMandatoryLens returns true for mandatory lenses", () => {
  assert.ok(isMandatoryLens("security"));
  assert.ok(isMandatoryLens("correctness"));
  assert.ok(isMandatoryLens("reliability"));
  assert.ok(isMandatoryLens("data_integrity"));
});

test("isMandatoryLens returns false for non-mandatory lenses", () => {
  assert.ok(!isMandatoryLens("performance"));
  assert.ok(!isMandatoryLens("tests"));
});

// ── isLensEffective ───────────────────────────────────────────────────────────

test("isLensEffective returns true for lenses in the effective set", () => {
  const effective = resolveEffectiveLenses(["performance"]);
  assert.ok(isLensEffective("performance", effective));
  assert.ok(isLensEffective("security", effective)); // mandatory
});

test("isLensEffective returns false for lenses not in the effective set", () => {
  const effective = resolveEffectiveLenses(["performance"]);
  assert.ok(!isLensEffective("architecture", effective));
});
