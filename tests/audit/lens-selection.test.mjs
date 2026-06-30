import test from "node:test";
import assert from "node:assert/strict";

const {
  resolveEffectiveLenses,
  MANDATORY_LENSES,
  isMandatoryLens,
} = await import("../../src/audit/orchestrator/lensSelection.ts");
const { LENSES } = await import("audit-tools/shared");

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
  // Full set == the shared canonical lens vocabulary (no magic literal).
  assert.equal(lenses.length, LENSES.length);
});

test("null selection also resolves to the full set", () => {
  const lenses = resolveEffectiveLenses(null);
  assert.equal(lenses.length, LENSES.length);
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

test("custom (non-canonical) lenses in selection are preserved after canonical lenses", () => {
  const lenses = resolveEffectiveLenses(["performance", "whimsy"]);
  assert.ok(lenses.includes("whimsy"));
  assert.ok(lenses.includes("performance"));
  assert.ok(lenses.indexOf("performance") < lenses.indexOf("whimsy"));
});

test("custom lenses are de-duplicated", () => {
  const lenses = resolveEffectiveLenses(["whimsy", "whimsy", "performance"]);
  assert.equal(lenses.filter((l) => l === "whimsy").length, 1);
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

// ── TST-4510f094: exclude-then-re-union round-trip ────────────────────────────

test("TST-4510f094: resolveEffectiveLenses restores mandatory lenses stripped by an exclude filter (two-call pattern)", () => {
  // planningExecutors.ts applies this exact pattern:
  //   const resolved = resolveEffectiveLenses(baseSelected ?? null);
  //   const afterExclude = resolved.filter(l => !excludeSet.has(l));
  //   effectiveLenses = resolveEffectiveLenses(afterExclude);
  //
  // Explicitly excluding a mandatory lens ('security') in the first call strips
  // it from afterExclude. The second resolveEffectiveLenses call must re-union
  // it back into the result.
  const first = resolveEffectiveLenses(null); // all lenses
  const afterExclude = first.filter((l) => l !== "security");
  assert.ok(!afterExclude.includes("security"), "afterExclude must not contain security");

  const second = resolveEffectiveLenses(afterExclude);
  assert.ok(
    second.includes("security"),
    "second resolveEffectiveLenses call must restore mandatory 'security' lens",
  );
  for (const mandatory of MANDATORY_LENSES) {
    assert.ok(
      second.includes(mandatory),
      `mandatory lens '${mandatory}' must be present after exclude-then-re-union round-trip`,
    );
  }
});

test("TST-4510f094: excluding all non-mandatory lenses does not drop mandatory lenses on re-union", () => {
  // Simulate excluding everything except one optional lens — mandatory lenses
  // must survive the second resolveEffectiveLenses call regardless.
  const onlyOptional = ["performance"];
  const afterExclude = onlyOptional.filter((l) => !MANDATORY_LENSES.includes(l));
  const second = resolveEffectiveLenses(afterExclude);
  for (const mandatory of MANDATORY_LENSES) {
    assert.ok(
      second.includes(mandatory),
      `mandatory lens '${mandatory}' must be present even when all other lenses are excluded`,
    );
  }
});
