import { test, expect } from "vitest";

const { interpretFreeFormIntent } = await import("../../src/shared/intent/freeFormIntentInterpreter.ts");

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
  expect(r.lensWeights.security > 0, "security clause must encode").toBeTruthy();
  expect(r.lensWeights.reliability > 0, "reliability clause must encode").toBeTruthy();
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
  const mod = await import("../../src/shared/index.ts");
  expect(typeof mod.interpretFreeFormIntent, "interpretFreeFormIntent should be a function exported from src/index.ts").toBe("function");
});
