import { test, expect } from "vitest";

const { interpretFreeFormIntent } = await import("../../src/shared/intent/freeFormIntentInterpreter.js");
const { scopeClausePolarity, SCOPE_PATTERNS } = await import("../../src/shared/intent/sharedIntentData.js");

// ---------------------------------------------------------------------------
// Empty / blank input
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — empty string returns zero-weight result", () => {
  const r = interpretFreeFormIntent("");
  expect(r.lensWeights).toEqual({});
  expect(r.prioritySignals).toEqual([]);
  expect(r.scopeEmphasis).toEqual([]);
  expect(r.unencodableClauses).toEqual([]);
});

test("interpretFreeFormIntent — blank string (spaces only) returns zero-weight result", () => {
  const r = interpretFreeFormIntent("   ");
  expect(r.lensWeights).toEqual({});
  expect(r.prioritySignals).toEqual([]);
  expect(r.scopeEmphasis).toEqual([]);
  expect(r.unencodableClauses).toEqual([]);
});

// ---------------------------------------------------------------------------
// Decimal / version tokens must not be split on their internal period
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — a version token (5.1) is not split into a bogus '1' clause", () => {
  const r = interpretFreeFormIntent("freeze behaviour on Windows PowerShell 5.1");
  // Regression: splitting on every '.' turned "...5.1" into "...5" + "1", and the
  // stray "1" surfaced as a spurious unencodable clause.
  expect(!r.unencodableClauses.includes("1"), `"5.1" must not fragment into a "1" clause: ${JSON.stringify(r.unencodableClauses)}`).toBeTruthy();
  expect(r.unencodableClauses.some((c) => c.includes("5.1")), `the version must survive intact in one clause: ${JSON.stringify(r.unencodableClauses)}`).toBeTruthy();
});

test("interpretFreeFormIntent — sentence-ending periods still split clauses", () => {
  // The digit-guard must not disable ordinary sentence splitting.
  const r = interpretFreeFormIntent("focus on security. also review reliability");
  expect((r.lensWeights.security ?? 0) > 0, "security clause must encode").toBeTruthy();
  expect((r.lensWeights.reliability ?? 0) > 0, "reliability clause must encode").toBeTruthy();
});

test("interpretFreeFormIntent — periods inside file paths do not split clauses (open-bugs.md case)", () => {
  // A "." splits only before whitespace/end-of-input, so a path/extension token
  // must survive whole — the exact clause the 2026-07-30 run fragmented into a
  // spurious "md) …" constraint candidate.
  const r = interpretFreeFormIntent("(docs/backlog/open-bugs.md) rather than duplicating them");

  const hasFragmentStartingWithMd = r.unencodableClauses.some((c) => /^md\)?/.test(c));
  expect(!hasFragmentStartingWithMd, `period in filename must not fragment the clause; unencodable: ${JSON.stringify(r.unencodableClauses)}`).toBeTruthy();
});

test("interpretFreeFormIntent — sentence-ending period followed by space still splits", () => {
  const r = interpretFreeFormIntent("look at open-bugs.md there. also check the config");

  // If the sentence boundary stopped splitting, both sentences would survive as
  // ONE unencodable clause containing both halves.
  const singleBigClause = r.unencodableClauses.some((c) => c.includes("md there") && c.includes("also"));
  expect(!singleBigClause, `a ". " boundary must still split; unencodable: ${JSON.stringify(r.unencodableClauses)}`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Single lens keyword → weight boost
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'focus on security' maps to security lens with boost", () => {
  const r = interpretFreeFormIntent("focus on security");
  expect((r.lensWeights.security ?? 0) >= 1.5, `expected security >= 1.5, got ${r.lensWeights.security}`).toBeTruthy();
  // No other lens keys should be present
  const keys = Object.keys(r.lensWeights);
  expect(keys.every((k) => k === "security"), `unexpected lens keys: ${keys.join(", ")}`).toBeTruthy();
});

test("interpretFreeFormIntent — 'check performance' maps to performance lens with boost", () => {
  const r = interpretFreeFormIntent("check performance");
  expect((r.lensWeights.performance ?? 0) >= 1.5, `expected performance >= 1.5, got ${r.lensWeights.performance}`).toBeTruthy();
  const keys = Object.keys(r.lensWeights);
  expect(keys.every((k) => k === "performance"), `unexpected lens keys: ${keys.join(", ")}`).toBeTruthy();
});

test("interpretFreeFormIntent — 'test coverage' maps to tests lens with boost", () => {
  const r = interpretFreeFormIntent("test coverage");
  expect((r.lensWeights.tests ?? 0) >= 1.5, `expected tests >= 1.5, got ${r.lensWeights.tests}`).toBeTruthy();
  const keys = Object.keys(r.lensWeights);
  expect(keys.every((k) => k === "tests"), `unexpected lens keys: ${keys.join(", ")}`).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Compound clause → multiple lenses
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'security and performance' maps both lenses with boosts", () => {
  const r = interpretFreeFormIntent("security and performance");
  expect((r.lensWeights.security ?? 0) >= 1.5, `expected security >= 1.5`).toBeTruthy();
  expect((r.lensWeights.performance ?? 0) >= 1.5, `expected performance >= 1.5`).toBeTruthy();
  const keys = Object.keys(r.lensWeights);
  expect(keys.length, `expected exactly 2 lens keys, got ${keys.join(", ")}`).toBe(2);
});

// ---------------------------------------------------------------------------
// Scope emphasis
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'focus on the auth module' captured in scopeEmphasis", () => {
  const r = interpretFreeFormIntent("focus on the auth module");
  expect(r.scopeEmphasis.length > 0, "expected scopeEmphasis to be non-empty").toBeTruthy();
  expect(r.scopeEmphasis.some((s) => /auth/i.test(s)), `expected scopeEmphasis to reference 'auth', got: ${JSON.stringify(r.scopeEmphasis)}`).toBeTruthy();
  // The clause contains 'auth' keyword which also maps to security lens, so
  // unencodableClauses may be empty (clause is partially encodable).
  // The key guarantee is scopeEmphasis is non-empty.
});

// ---------------------------------------------------------------------------
// Scope-clause POLARITY (CP-NODE-16 / COR-a0648a7d): an exclusion clause must be
// tagged "exclude" and land in the dedicated scopeExclusions field, never merged
// into scopeEmphasis, and must never register a positive lens weight.
// ---------------------------------------------------------------------------

test("scopeClausePolarity — exclusion lead-in verbs are tagged 'exclude'", () => {
  for (const clause of ["ignore vendor/", "skip tests/", "exclude generated code", "ignoring node_modules"]) {
    expect(scopeClausePolarity(clause), `expected 'exclude' polarity for: ${clause}`).toBe("exclude");
  }
});

test("scopeClausePolarity — inclusion lead-in verbs are tagged 'include'", () => {
  for (const clause of ["focus on the auth module", "prioritise src/api", "only audit src/", "limited to packages/core"]) {
    expect(scopeClausePolarity(clause), `expected 'include' polarity for: ${clause}`).toBe("include");
  }
});

test("scopeClausePolarity — a non-scope clause has no polarity", () => {
  expect(scopeClausePolarity("freeze the public API of PackageX")).toBeNull();
});

test("scopeClausePolarity agrees with SCOPE_PATTERNS on which clauses are scope clauses", () => {
  // SCOPE_PATTERNS is DERIVED from the polarity-tagged entry list, so the
  // polarity-blind view and the polarity-aware view can never disagree.
  const clauses = [
    "ignore vendor/",
    "focus on the auth module",
    "only audit src/",
    "freeze the public API of PackageX",
    "urgent",
  ];
  for (const clause of clauses) {
    const blindMatch = SCOPE_PATTERNS.some((p) => p.test(clause));
    expect(scopeClausePolarity(clause) !== null, `polarity/SCOPE_PATTERNS disagree on: ${clause}`).toBe(blindMatch);
  }
});

test("interpretFreeFormIntent — 'ignore vendor/' lands in scopeExclusions, not scopeEmphasis", () => {
  const r = interpretFreeFormIntent("ignore vendor/");
  expect(r.scopeExclusions.some((s) => /vendor/i.test(s)), `expected scopeExclusions to reference 'vendor', got: ${JSON.stringify(r.scopeExclusions)}`).toBeTruthy();
  expect(r.scopeEmphasis, "an exclusion clause must never be merged into scopeEmphasis").toEqual([]);
});

test("interpretFreeFormIntent — an inclusion clause stays out of scopeExclusions", () => {
  const r = interpretFreeFormIntent("focus on the auth module");
  expect(r.scopeExclusions, "an inclusion clause must never land in scopeExclusions").toEqual([]);
  expect(r.scopeEmphasis.length > 0, "expected the inclusion clause in scopeEmphasis").toBeTruthy();
});

test("interpretFreeFormIntent — an exclusion clause records NO positive lens weight", () => {
  // "performance" is a lens keyword, but "ignore performance issues" asks for it
  // to be de-emphasised — a polarity-blind keyword scan boosted it instead.
  const r = interpretFreeFormIntent("ignore performance issues");
  expect(r.lensWeights.performance, `an exclusion clause must not boost its lens, got ${JSON.stringify(r.lensWeights)}`).toBeUndefined();
  expect(r.scopeExclusions.length > 0, "the exclusion clause must still be captured as a scope exclusion").toBeTruthy();

  // The inclusion counterpart is unchanged — the guard is polarity-gated, not a blanket off-switch.
  const included = interpretFreeFormIntent("check performance");
  expect((included.lensWeights.performance ?? 0) >= 1.5, `expected performance >= 1.5, got ${included.lensWeights.performance}`).toBeTruthy();
});

test("interpretFreeFormIntent — mixed intent splits inclusion and exclusion into their own fields", () => {
  const r = interpretFreeFormIntent("focus on src/api. ignore vendor/");
  expect(r.scopeEmphasis.some((s) => /src\/api/i.test(s)), `scopeEmphasis: ${JSON.stringify(r.scopeEmphasis)}`).toBeTruthy();
  expect(r.scopeExclusions.some((s) => /vendor/i.test(s)), `scopeExclusions: ${JSON.stringify(r.scopeExclusions)}`).toBeTruthy();
  expect(r.scopeEmphasis.some((s) => /vendor/i.test(s)), "the excluded scope must not appear in scopeEmphasis").toBeFalsy();
});

// ---------------------------------------------------------------------------
// Priority signals
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'urgent: fix the login flow' captured in prioritySignals", () => {
  const r = interpretFreeFormIntent("urgent: fix the login flow");
  expect(r.prioritySignals.length > 0, "expected prioritySignals to be non-empty").toBeTruthy();
  // lensWeights may or may not have entries depending on keyword overlap
  // (no requirement imposed here)
});

// ---------------------------------------------------------------------------
// Unencodable clause
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'freeze the public API of PackageX' goes to unencodableClauses", () => {
  const r = interpretFreeFormIntent("freeze the public API of PackageX");
  expect(r.unencodableClauses.length > 0, "expected unencodableClauses to be non-empty").toBeTruthy();
  expect(r.lensWeights).toEqual({});
  expect(r.scopeEmphasis).toEqual([]);
});

// ---------------------------------------------------------------------------
// Mixed encodable + unencodable clauses are independent
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — security clause + unencodable clause processed independently", () => {
  const r = interpretFreeFormIntent(
    "review all security vulnerabilities. freeze the public API of PackageX"
  );
  // security should be encoded
  expect((r.lensWeights.security ?? 0) >= 1.5, `expected security lens boost, got ${JSON.stringify(r.lensWeights)}`).toBeTruthy();
  // unencodable clause should not suppress the encodable sibling
  expect(r.unencodableClauses.length > 0, "expected unencodableClauses to be non-empty").toBeTruthy();
});

// ---------------------------------------------------------------------------
// Verbatim string never appears in output
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — verbatim input string never appears in any output field", () => {
  const input = "check security and performance thoroughly";
  const r = interpretFreeFormIntent(input);

  // lensWeights values are numbers
  for (const [k, v] of Object.entries(r.lensWeights)) {
    expect(typeof v, `expected lensWeights.${k} to be a number, got ${typeof v}`).toBe("number");
  }

  // No string field equals the raw input
  const stringFields = [
    ...r.prioritySignals,
    ...r.scopeEmphasis,
    ...r.unencodableClauses,
  ];
  for (const s of stringFields) {
    expect(s, `verbatim input string escaped into output: ${s}`).not.toBe(input);
  }
});

// ---------------------------------------------------------------------------
// Export shape (smoke test that types are wired through shared index)
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent is exported from the src index", async () => {
  const mod = await import("../../src/shared/index.js");
  expect(typeof mod.interpretFreeFormIntent, "interpretFreeFormIntent should be a function exported from src/index.ts").toBe("function");
});
