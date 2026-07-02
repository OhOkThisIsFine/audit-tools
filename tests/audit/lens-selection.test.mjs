import { test, expect } from "vitest";

const {
  resolveEffectiveLenses,
  MANDATORY_LENSES,
  isMandatoryLens,
} = await import("../../src/audit/orchestrator/lensSelection.ts");
const { LENSES } = await import("audit-tools/shared");

// ── MANDATORY_LENSES ─────────────────────────────────────────────────────────

test("MANDATORY_LENSES includes security, correctness, reliability, data_integrity", () => {
  const mandatory = new Set(MANDATORY_LENSES);
  expect(mandatory.has("security")).toBeTruthy();
  expect(mandatory.has("correctness")).toBeTruthy();
  expect(mandatory.has("reliability")).toBeTruthy();
  expect(mandatory.has("data_integrity")).toBeTruthy();
});

// ── resolveEffectiveLenses — defaults ────────────────────────────────────────

test("omitted selection resolves to the full all-lenses set", () => {
  const lenses = resolveEffectiveLenses(undefined);
  const set = new Set(lenses);
  for (const mandatory of MANDATORY_LENSES) {
    expect(set.has(mandatory), `missing mandatory lens: ${mandatory}`).toBeTruthy();
  }
  // Full set == the shared canonical lens vocabulary (no magic literal).
  expect(lenses.length).toBe(LENSES.length);
});

test("null selection also resolves to the full set", () => {
  const lenses = resolveEffectiveLenses(null);
  expect(lenses.length).toBe(LENSES.length);
});

// ── resolveEffectiveLenses — focused selection ────────────────────────────────

test("focused selection includes requested lens plus mandatory base lenses", () => {
  const lenses = resolveEffectiveLenses(["performance"]);
  const set = new Set(lenses);
  expect(set.has("performance")).toBeTruthy();
  for (const mandatory of MANDATORY_LENSES) {
    expect(set.has(mandatory), `missing mandatory lens: ${mandatory}`).toBeTruthy();
  }
});

test("focused selection de-duplicates lenses", () => {
  // correctness is both selected and mandatory.
  const lenses = resolveEffectiveLenses(["correctness", "correctness", "security"]);
  const seen = new Set();
  for (const lens of lenses) {
    expect(!seen.has(lens), `duplicate lens: ${lens}`).toBeTruthy();
    seen.add(lens);
  }
});

test("resolved lenses are sorted in canonical LENSES registry order", () => {
  const lenses = resolveEffectiveLenses(["tests", "performance"]);
  // performance comes before tests in the canonical order.
  const perfIdx = lenses.indexOf("performance");
  const testsIdx = lenses.indexOf("tests");
  expect(perfIdx < testsIdx, "performance should precede tests in canonical order").toBeTruthy();
});

test("custom (non-canonical) lenses in selection are preserved after canonical lenses", () => {
  const lenses = resolveEffectiveLenses(["performance", "whimsy"]);
  expect(lenses.includes("whimsy")).toBeTruthy();
  expect(lenses.includes("performance")).toBeTruthy();
  expect(lenses.indexOf("performance") < lenses.indexOf("whimsy")).toBeTruthy();
});

test("custom lenses are de-duplicated", () => {
  const lenses = resolveEffectiveLenses(["whimsy", "whimsy", "performance"]);
  expect(lenses.filter((l) => l === "whimsy").length).toBe(1);
});

// ── isMandatoryLens ───────────────────────────────────────────────────────────

test("isMandatoryLens returns true for mandatory lenses", () => {
  expect(isMandatoryLens("security")).toBeTruthy();
  expect(isMandatoryLens("correctness")).toBeTruthy();
  expect(isMandatoryLens("reliability")).toBeTruthy();
  expect(isMandatoryLens("data_integrity")).toBeTruthy();
});

test("isMandatoryLens returns false for non-mandatory lenses", () => {
  expect(!isMandatoryLens("performance")).toBeTruthy();
  expect(!isMandatoryLens("tests")).toBeTruthy();
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
  expect(!afterExclude.includes("security"), "afterExclude must not contain security").toBeTruthy();

  const second = resolveEffectiveLenses(afterExclude);
  expect(second.includes("security"), "second resolveEffectiveLenses call must restore mandatory 'security' lens").toBeTruthy();
  for (const mandatory of MANDATORY_LENSES) {
    expect(second.includes(mandatory), `mandatory lens '${mandatory}' must be present after exclude-then-re-union round-trip`).toBeTruthy();
  }
});

test("TST-4510f094: excluding all non-mandatory lenses does not drop mandatory lenses on re-union", () => {
  // Simulate excluding everything except one optional lens — mandatory lenses
  // must survive the second resolveEffectiveLenses call regardless.
  const onlyOptional = ["performance"];
  const afterExclude = onlyOptional.filter((l) => !MANDATORY_LENSES.includes(l));
  const second = resolveEffectiveLenses(afterExclude);
  for (const mandatory of MANDATORY_LENSES) {
    expect(second.includes(mandatory), `mandatory lens '${mandatory}' must be present even when all other lenses are excluded`).toBeTruthy();
  }
});
