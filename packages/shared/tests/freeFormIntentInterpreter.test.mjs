import test from "node:test";
import assert from "node:assert/strict";

const { interpretFreeFormIntent } = await import(
  "../src/intent/freeFormIntentInterpreter.ts"
);

// ---------------------------------------------------------------------------
// Empty / blank input
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — empty string returns zero-weight result", () => {
  const r = interpretFreeFormIntent("");
  assert.deepStrictEqual(r.lensWeights, {});
  assert.deepStrictEqual(r.prioritySignals, []);
  assert.deepStrictEqual(r.scopeEmphasis, []);
  assert.deepStrictEqual(r.unencodableClauses, []);
});

test("interpretFreeFormIntent — blank string (spaces only) returns zero-weight result", () => {
  const r = interpretFreeFormIntent("   ");
  assert.deepStrictEqual(r.lensWeights, {});
  assert.deepStrictEqual(r.prioritySignals, []);
  assert.deepStrictEqual(r.scopeEmphasis, []);
  assert.deepStrictEqual(r.unencodableClauses, []);
});

// ---------------------------------------------------------------------------
// Single lens keyword → weight boost
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'focus on security' maps to security lens with boost", () => {
  const r = interpretFreeFormIntent("focus on security");
  assert.ok(
    (r.lensWeights.security ?? 0) >= 1.5,
    `expected security >= 1.5, got ${r.lensWeights.security}`
  );
  // No other lens keys should be present
  const keys = Object.keys(r.lensWeights);
  assert.ok(
    keys.every((k) => k === "security"),
    `unexpected lens keys: ${keys.join(", ")}`
  );
});

test("interpretFreeFormIntent — 'check performance' maps to performance lens with boost", () => {
  const r = interpretFreeFormIntent("check performance");
  assert.ok(
    (r.lensWeights.performance ?? 0) >= 1.5,
    `expected performance >= 1.5, got ${r.lensWeights.performance}`
  );
  const keys = Object.keys(r.lensWeights);
  assert.ok(
    keys.every((k) => k === "performance"),
    `unexpected lens keys: ${keys.join(", ")}`
  );
});

test("interpretFreeFormIntent — 'test coverage' maps to tests lens with boost", () => {
  const r = interpretFreeFormIntent("test coverage");
  assert.ok(
    (r.lensWeights.tests ?? 0) >= 1.5,
    `expected tests >= 1.5, got ${r.lensWeights.tests}`
  );
  const keys = Object.keys(r.lensWeights);
  assert.ok(
    keys.every((k) => k === "tests"),
    `unexpected lens keys: ${keys.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// Compound clause → multiple lenses
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'security and performance' maps both lenses with boosts", () => {
  const r = interpretFreeFormIntent("security and performance");
  assert.ok(
    (r.lensWeights.security ?? 0) >= 1.5,
    `expected security >= 1.5`
  );
  assert.ok(
    (r.lensWeights.performance ?? 0) >= 1.5,
    `expected performance >= 1.5`
  );
  const keys = Object.keys(r.lensWeights);
  assert.strictEqual(
    keys.length,
    2,
    `expected exactly 2 lens keys, got ${keys.join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// Scope emphasis
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'focus on the auth module' captured in scopeEmphasis", () => {
  const r = interpretFreeFormIntent("focus on the auth module");
  assert.ok(
    r.scopeEmphasis.length > 0,
    "expected scopeEmphasis to be non-empty"
  );
  assert.ok(
    r.scopeEmphasis.some((s) => /auth/i.test(s)),
    `expected scopeEmphasis to reference 'auth', got: ${JSON.stringify(r.scopeEmphasis)}`
  );
  // The clause contains 'auth' keyword which also maps to security lens, so
  // unencodableClauses may be empty (clause is partially encodable).
  // The key guarantee is scopeEmphasis is non-empty.
});

// ---------------------------------------------------------------------------
// Priority signals
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'urgent: fix the login flow' captured in prioritySignals", () => {
  const r = interpretFreeFormIntent("urgent: fix the login flow");
  assert.ok(
    r.prioritySignals.length > 0,
    "expected prioritySignals to be non-empty"
  );
  // lensWeights may or may not have entries depending on keyword overlap
  // (no requirement imposed here)
});

// ---------------------------------------------------------------------------
// Unencodable clause
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — 'freeze the public API of PackageX' goes to unencodableClauses", () => {
  const r = interpretFreeFormIntent("freeze the public API of PackageX");
  assert.ok(
    r.unencodableClauses.length > 0,
    "expected unencodableClauses to be non-empty"
  );
  assert.deepStrictEqual(r.lensWeights, {});
  assert.deepStrictEqual(r.scopeEmphasis, []);
});

// ---------------------------------------------------------------------------
// Mixed encodable + unencodable clauses are independent
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — security clause + unencodable clause processed independently", () => {
  const r = interpretFreeFormIntent(
    "review all security vulnerabilities. freeze the public API of PackageX"
  );
  // security should be encoded
  assert.ok(
    (r.lensWeights.security ?? 0) >= 1.5,
    `expected security lens boost, got ${JSON.stringify(r.lensWeights)}`
  );
  // unencodable clause should not suppress the encodable sibling
  assert.ok(
    r.unencodableClauses.length > 0,
    "expected unencodableClauses to be non-empty"
  );
});

// ---------------------------------------------------------------------------
// Verbatim string never appears in output
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent — verbatim input string never appears in any output field", () => {
  const input = "check security and performance thoroughly";
  const r = interpretFreeFormIntent(input);

  // lensWeights values are numbers
  for (const [k, v] of Object.entries(r.lensWeights)) {
    assert.strictEqual(
      typeof v,
      "number",
      `expected lensWeights.${k} to be a number, got ${typeof v}`
    );
  }

  // No string field equals the raw input
  const stringFields = [
    ...r.prioritySignals,
    ...r.scopeEmphasis,
    ...r.unencodableClauses,
  ];
  for (const s of stringFields) {
    assert.notStrictEqual(
      s,
      input,
      `verbatim input string escaped into output: ${s}`
    );
  }
});

// ---------------------------------------------------------------------------
// Export shape (smoke test that types are wired through shared index)
// ---------------------------------------------------------------------------

test("interpretFreeFormIntent is exported from the src index", async () => {
  const mod = await import("../src/index.ts");
  assert.strictEqual(
    typeof mod.interpretFreeFormIntent,
    "function",
    "interpretFreeFormIntent should be a function exported from src/index.ts"
  );
});
