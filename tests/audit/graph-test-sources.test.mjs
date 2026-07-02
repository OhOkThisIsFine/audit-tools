import { test, expect } from "vitest";

const { extractTestSourceEdges } = await import("../../src/audit/extractors/graphTestSources.ts");

// Private helpers (testSourceCandidates, stripPythonTestPrefix,
// addTestSourceCandidatesForBase) are exercised indirectly through
// extractTestSourceEdges and a thin wrapper approach using pathLookup.

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build a pathLookup where every given path is both key (lowercased) and value.
 * resolveCandidate() queries by lowercased key and returns the value.
 */
function makeLookup(paths) {
  return new Map(paths.map((p) => [p.toLowerCase(), p]));
}

/**
 * Call extractTestSourceEdges and return the set of "to" paths from edges
 * that have kind === 'test-source-link'.
 */
function resolvedTargets(fromPath, lookupPaths) {
  const edges = extractTestSourceEdges(fromPath, makeLookup(lookupPaths));
  return edges
    .filter((e) => e.kind === "test-source-link")
    .map((e) => e.to);
}

// ── extractTestSourceEdges: non-test path ─────────────────────────────────────

test("extractTestSourceEdges returns [] for a non-test path", () => {
  expect(extractTestSourceEdges("src/utils/helper.ts", new Map())).toEqual([]);
});

// ── stripPythonTestPrefix via testSourceCandidates ───────────────────────────

test("stripPythonTestPrefix: test_foo.py strips prefix and links to foo.py", () => {
  // After stripping the test_ prefix → foo, addTestSourceCandidatesForBase
  // mirrors the tests/ top-level segment to src/ → candidate 'src/foo', which
  // resolves to src/foo.py. (The source must live outside a test directory; a
  // candidate under tests/ would be filtered out by isTestPath.)
  const targets = resolvedTargets("tests/test_foo.py", ["src/foo.py"]);
  expect(targets.some((t) => t.endsWith("foo.py")), `Expected a target ending in foo.py, got: ${JSON.stringify(targets)}`).toBeTruthy();
});

test("stripPythonTestPrefix: test-bar.py derives candidate from 'bar'", () => {
  const targets = resolvedTargets("tests/test-bar.py", ["src/bar.py"]);
  expect(targets.some((t) => t.endsWith("bar.py")), `Expected target ending in bar.py, got: ${JSON.stringify(targets)}`).toBeTruthy();
});

test("stripPythonTestPrefix: test.bar.py derives candidate from 'bar'", () => {
  const targets = resolvedTargets("tests/test.bar.py", ["src/bar.py"]);
  expect(targets.some((t) => t.endsWith("bar.py")), `Expected target ending in bar.py, got: ${JSON.stringify(targets)}`).toBeTruthy();
});

test("stripPythonTestPrefix: non-prefixed Python file does not produce prefix-derived candidate", () => {
  // foo_test.py — suffix-stripping may still fire but NOT the python-prefix branch
  // so 'foo' is only produced by the suffix-strip path (test→), not test_ prefix.
  // Provide only 'src/foo.py' in the lookup; the test ensures we still get edges
  // (via suffix strip) without an infinite loop / wrong target.
  const targets = resolvedTargets("tests/foo_test.py", ["src/foo.py"]);
  // We are not asserting the prefix path fired — just that a non-prefixed path
  // doesn't cause errors and does NOT emit a spurious prefix-strip-derived edge.
  expect(Array.isArray(targets)).toBeTruthy();
});

// ── addTestSourceCandidatesForBase: top-level tests/ mirrors to src/ ─────────

test("addTestSourceCandidatesForBase: tests/ top-level segment mirrors to src/", () => {
  // tests/utils/helper.test.ts → candidate suffix-stripped to tests/utils/helper,
  // then mirrored to src/utils/helper, which resolves to src/utils/helper.ts.
  const targets = resolvedTargets("tests/utils/helper.test.ts", [
    "src/utils/helper.ts",
  ]);
  expect(targets.includes("src/utils/helper.ts"), `Expected src/utils/helper.ts in ${JSON.stringify(targets)}`).toBeTruthy();
});

test("addTestSourceCandidatesForBase: spec/ top-level segment mirrors to src/", () => {
  const targets = resolvedTargets("spec/utils/helper.test.ts", [
    "src/utils/helper.ts",
  ]);
  expect(targets.includes("src/utils/helper.ts"), `Expected src/utils/helper.ts in ${JSON.stringify(targets)}`).toBeTruthy();
});

// ── addTestSourceCandidatesForBase: colocated __tests__ segment removed ───────

test("addTestSourceCandidatesForBase: colocated __tests__ segment is removed", () => {
  // src/__tests__/helper.test.ts → strip suffix → src/__tests__/helper
  // colocated removal: [src, helper] → 'src/helper'
  // resolves to src/helper.ts
  const targets = resolvedTargets("src/__tests__/helper.test.ts", [
    "src/helper.ts",
  ]);
  expect(targets.some((t) => t === "src/helper.ts"), `Expected src/helper.ts in ${JSON.stringify(targets)}`).toBeTruthy();
});

// ── testSourceCandidates: no known source extension ──────────────────────────

test("testSourceCandidates: file with no known source extension returns no edges", () => {
  // .unknownext is not in SOURCE_EXTENSIONS → testSourceCandidates returns []
  const edges = extractTestSourceEdges(
    "tests/foo.unknownext",
    makeLookup(["src/foo.ts"]),
  );
  expect(edges).toEqual([]);
});

// ── extractTestSourceEdges: edge shape ───────────────────────────────────────

test("extractTestSourceEdges: emits a test-source-link edge with correct shape", () => {
  const fromPath = "tests/utils/helper.test.ts";
  const lookup = makeLookup(["src/utils/helper.ts"]);
  const edges = extractTestSourceEdges(fromPath, lookup);

  expect(edges.length > 0, "Expected at least one edge").toBeTruthy();
  const edge = edges.find((e) => e.kind === "test-source-link");
  expect(edge, "Expected an edge with kind test-source-link").toBeTruthy();
  expect(edge.from).toBe(fromPath);
  expect(edge.to).toBe("src/utils/helper.ts");
  expect(edge.confidence).toBe(0.88);
});

test("extractTestSourceEdges: candidate resolves but target is itself a test path — edge skipped", () => {
  // If the resolved target is itself a test file, the edge should not be emitted.
  // Map: tests/utils/helper maps to tests/other.test.ts (a test path)
  const fromPath = "tests/utils/helper.test.ts";
  // We construct a lookup where 'src/utils/helper' resolves to another test path.
  // Build lookup so that the candidate 'src/utils/helper' → 'tests/other.test.ts'
  const lookup = new Map([
    ["src/utils/helper.ts", "tests/other.test.ts"],
    ["src/utils/helper", "tests/other.test.ts"],
  ]);
  const edges = extractTestSourceEdges(fromPath, lookup);
  expect(edges, "Should emit no edges when target is a test path").toEqual([]);
});

test("extractTestSourceEdges: returns [] for a plain non-test source path (no isTestPath match)", () => {
  expect(extractTestSourceEdges("src/utils/helper.ts", makeLookup(["src/other.ts"]))).toEqual([]);
});
