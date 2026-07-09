/**
 * Shared finding-similarity helpers (src/shared/findingSimilarity.ts) — the
 * fuzzy-match tier extracted out of byte-identical private copies in
 * src/audit/reporting/mergeFindings.ts and
 * src/remediate/dedup/crossLensDedup.ts.
 */
import { test, expect } from "vitest";
import { wordJaccard, filePathOverlap, primaryPath } from "audit-tools/shared";

function findingWithFiles(...paths) {
  return { affected_files: paths.map((path) => ({ path })) };
}

test.each([
  ["identical strings", "hello world", "hello world", 1],
  ["completely disjoint strings", "hello world", "foo bar", 0],
  ["both empty", "", "", 0],
  ["one empty", "hello world", "", 0],
])("wordJaccard: %s", (_label, a, b, expected) => {
  expect(wordJaccard(a, b)).toBe(expected);
});

test("wordJaccard is case-insensitive and punctuation-insensitive", () => {
  expect(wordJaccard("Hello, World!", "hello world")).toBe(1);
});

test("wordJaccard: partial overlap is strictly between 0 and 1", () => {
  const score = wordJaccard("compiled dist output", "compiled dist artifacts");
  expect(score).toBeGreaterThan(0);
  expect(score).toBeLessThan(1);
});

test.each([
  ["identical single-file sets", ["a.ts"], ["a.ts"], 1],
  ["disjoint sets", ["a.ts"], ["b.ts"], 0],
  ["partial overlap", ["a.ts", "b.ts"], ["b.ts", "c.ts"], 1 / 3],
  ["both empty", [], [], 0],
])("filePathOverlap: %s", (_label, pathsA, pathsB, expected) => {
  expect(filePathOverlap(findingWithFiles(...pathsA), findingWithFiles(...pathsB))).toBeCloseTo(
    expected,
  );
});

test.each([
  ["first listed file", ["a.ts", "b.ts"], "a.ts"],
  ["no affected files", [], ""],
])("primaryPath: %s", (_label, paths, expected) => {
  expect(primaryPath(findingWithFiles(...paths))).toBe(expected);
});
