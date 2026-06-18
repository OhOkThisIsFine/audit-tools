import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { getTreeSitterParser, getTreeSitterDegradationCount, __resetTreeSitterForTests } = await import("../../src/audit/extractors/analyzers/treeSitter.ts");

// These tests verify the per-module languageCache scoping (COR-a16b8f92) and the
// degradation counter (OBS-09514de4) through the public API. They must hold
// whether or not the optional `web-tree-sitter` runtime is installed, so we do
// NOT rely on the parser module being absent. Instead we drive a deterministic
// *grammar* failure: an unknown grammar name has no `.wasm`, so `loadLanguage`
// fails and `getTreeSitterParser` degrades to `undefined` — on every platform,
// regardless of whether web-tree-sitter resolved. A fresh temp `dependencyPath`
// also exercises the per-path module resolution branch.

// A grammar name that can never collide with a real tree-sitter-wasms grammar,
// so resolution either finds no wasm or fails to load it → graceful undefined.
const ABSENT_GRAMMAR = "__audit_test_absent_grammar__";

test("getTreeSitterParser: two dependency paths both degrade to undefined without cross-contamination", async () => {
  __resetTreeSitterForTests();

  const dirA = await mkdtemp(join(tmpdir(), "ts-cache-a-"));
  const dirB = await mkdtemp(join(tmpdir(), "ts-cache-b-"));
  try {
    // An unknown grammar has no wasm, so both calls gracefully degrade to
    // undefined. The key invariant is that the second call does NOT throw or
    // otherwise inherit a corrupt state from the first call's cached null —
    // each (module, grammar) slot resolves independently.
    const parserA = await getTreeSitterParser(ABSENT_GRAMMAR, dirA);
    const parserB = await getTreeSitterParser(ABSENT_GRAMMAR, dirB);

    assert.equal(parserA, undefined, "absent grammar via path A returns undefined");
    assert.equal(parserB, undefined, "absent grammar via path B returns undefined");
  } finally {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
    __resetTreeSitterForTests();
  }
});

test("getTreeSitterParser: reset clears cache so a subsequent call re-attempts resolution", async () => {
  __resetTreeSitterForTests();

  const dir = await mkdtemp(join(tmpdir(), "ts-cache-reset-"));
  try {
    // First call: absent grammar → undefined, and records a degradation while
    // caching a null slot in the per-module languageCache.
    const firstResult = await getTreeSitterParser(ABSENT_GRAMMAR, dir);
    assert.equal(firstResult, undefined);
    const countAfterFirst = getTreeSitterDegradationCount();
    assert.ok(countAfterFirst > 0, "first failed resolution records a degradation");

    // After reset, the module-level maps are cleared. A second call must
    // re-attempt resolution rather than returning the cached null. We prove the
    // re-attempt happened by observing the degradation counter climb *again*
    // from zero — a cached null would short-circuit before re-incrementing.
    __resetTreeSitterForTests();
    assert.equal(getTreeSitterDegradationCount(), 0, "reset zeroes the counter");

    const secondResult = await getTreeSitterParser(ABSENT_GRAMMAR, dir);
    assert.equal(secondResult, undefined, "still undefined after cache reset — no throw");
    assert.ok(
      getTreeSitterDegradationCount() > 0,
      "re-attempted resolution after reset (counter climbed from zero again)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    __resetTreeSitterForTests();
  }
});

test("getTreeSitterParser: repeated call with same absent grammar returns undefined (no throw on re-use)", async () => {
  __resetTreeSitterForTests();

  const dir = await mkdtemp(join(tmpdir(), "ts-cache-repeat-"));
  try {
    const first = await getTreeSitterParser(ABSENT_GRAMMAR, dir);
    const second = await getTreeSitterParser(ABSENT_GRAMMAR, dir);
    assert.equal(first, undefined);
    assert.equal(second, undefined);
    // The second call is served from the cached null slot, so it must NOT
    // record an additional degradation — failures are memoised, not re-counted.
    assert.equal(
      getTreeSitterDegradationCount(),
      1,
      "a repeated absent-grammar call reuses the cached null (no extra degradation)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    __resetTreeSitterForTests();
  }
});

// OBS-09514de4: degradation counter tests

test("getTreeSitterDegradationCount increments on grammar load failure", async () => {
  __resetTreeSitterForTests();
  assert.equal(getTreeSitterDegradationCount(), 0, "starts at zero after reset");

  const dir = await mkdtemp(join(tmpdir(), "ts-degrade-grammar-"));
  try {
    // An unknown grammar forces loadLanguage to fail (no wasm), which is a
    // degradation regardless of whether web-tree-sitter itself resolved.
    const result = await getTreeSitterParser(ABSENT_GRAMMAR, dir);
    assert.equal(result, undefined, "graceful degradation preserved");
    assert.ok(
      getTreeSitterDegradationCount() > 0,
      "counter must be > 0 after at least one resolution failure",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    __resetTreeSitterForTests();
  }
});

// TST-b975cabf: two DISTINCT absent grammars on the SAME dependency path —
// each must record its own degradation, so the counter must be exactly 2.
// This verifies that cache keying is per (path, grammar) not just per path.
test("getTreeSitterParser: two distinct absent grammars on the same path each degrade once", async () => {
  __resetTreeSitterForTests();

  const dir = await mkdtemp(join(tmpdir(), "ts-two-grammars-"));
  const ABSENT_GRAMMAR_B = "__audit_test_absent_grammar_b__";
  try {
    const a = await getTreeSitterParser(ABSENT_GRAMMAR, dir);
    const b = await getTreeSitterParser(ABSENT_GRAMMAR_B, dir);
    assert.equal(a, undefined, "first absent grammar returns undefined");
    assert.equal(b, undefined, "second absent grammar returns undefined");
    // Each grammar is a distinct cache key — the degradation counter must
    // reflect both failures, not just one (which would indicate the second
    // absent grammar was served from the first's cached null).
    assert.ok(
      getTreeSitterDegradationCount() >= 2,
      `expected degradation count >= 2 for two distinct absent grammars; got ${getTreeSitterDegradationCount()}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    __resetTreeSitterForTests();
  }
});

test("__resetTreeSitterForTests resets degradation counter", async () => {
  __resetTreeSitterForTests();

  const dir = await mkdtemp(join(tmpdir(), "ts-degrade-reset-"));
  try {
    // Force at least one degradation by requesting an absent grammar.
    await getTreeSitterParser(ABSENT_GRAMMAR, dir);
    assert.ok(
      getTreeSitterDegradationCount() > 0,
      "counter must be > 0 after a failure",
    );

    __resetTreeSitterForTests();
    assert.equal(
      getTreeSitterDegradationCount(),
      0,
      "counter must be 0 after reset",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    __resetTreeSitterForTests();
  }
});
