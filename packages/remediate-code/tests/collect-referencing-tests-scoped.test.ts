/**
 * Tests for the packageRoot scoping parameter of collectReferencingTests.
 */
import { describe, it, expect } from "vitest";
import {
  collectReferencingTests,
  type TestFileEntry,
} from "../src/steps/dispatch.js";

function makeIndex(entries: { rel: string; content: string }[]): TestFileEntry[] {
  return entries;
}

describe("collectReferencingTests — packageRoot scoping", () => {
  const index = makeIndex([
    { rel: "packages/foo/tests/widget.test.ts", content: "import { widget } from '../src/widget'" },
    { rel: "packages/foo/tests/other.test.ts", content: "import { other } from '../src/other'" },
    { rel: "packages/bar/tests/widget.test.ts", content: "import { widget } from '../src/widget'" },
    { rel: "packages/bar/tests/unrelated.test.ts", content: "import { unrelated } from '../src/unrelated'" },
  ]);

  it("when packageRoot is 'packages/foo', only test files under packages/foo/ are returned", () => {
    const result = collectReferencingTests(
      index,
      ["packages/foo/src/widget.ts"],
      "packages/foo",
    );
    expect(result).toContain("packages/foo/tests/widget.test.ts");
    expect(result).not.toContain("packages/bar/tests/widget.test.ts");
  });

  it("excludes test files in packages/bar even if they contain a matching basename", () => {
    const result = collectReferencingTests(
      index,
      ["packages/foo/src/widget.ts"],
      "packages/foo",
    );
    expect(result.every((r) => r.startsWith("packages/foo/"))).toBe(true);
  });

  it("when packageRoot is omitted, all matching test files are returned (existing behavior)", () => {
    const result = collectReferencingTests(index, ["src/widget.ts"]);
    // Both foo and bar widget test files reference "widget"
    expect(result).toContain("packages/foo/tests/widget.test.ts");
    expect(result).toContain("packages/bar/tests/widget.test.ts");
  });

  it("when packageRoot is 'packages/bar', only bar test files are considered", () => {
    const result = collectReferencingTests(
      index,
      ["packages/bar/src/widget.ts"],
      "packages/bar",
    );
    expect(result).toContain("packages/bar/tests/widget.test.ts");
    expect(result).not.toContain("packages/foo/tests/widget.test.ts");
  });

  it("returns empty array when no test files match within the scoped package", () => {
    const result = collectReferencingTests(
      index,
      ["packages/foo/src/totally-absent-module.ts"],
      "packages/foo",
    );
    expect(result).toEqual([]);
  });

  it("does not include the source file itself even if it is in the test index", () => {
    const indexWithSelf = makeIndex([
      ...index,
      { rel: "packages/foo/src/widget.ts", content: "export function widget() {}" },
    ]);
    const result = collectReferencingTests(
      indexWithSelf,
      ["packages/foo/src/widget.ts"],
      "packages/foo",
    );
    expect(result).not.toContain("packages/foo/src/widget.ts");
  });

  it("handles Windows-style backslash paths in sourceFiles by normalizing them", () => {
    const result = collectReferencingTests(
      index,
      // Windows-style path — should still match
      ["packages\\foo\\src\\widget.ts"],
      "packages/foo",
    );
    expect(result).toContain("packages/foo/tests/widget.test.ts");
    expect(result).not.toContain("packages/bar/tests/widget.test.ts");
  });

  it("empty sourceFiles returns empty result regardless of packageRoot", () => {
    expect(collectReferencingTests(index, [], "packages/foo")).toEqual([]);
  });

  it("empty index returns empty result regardless of packageRoot", () => {
    expect(collectReferencingTests([], ["packages/foo/src/widget.ts"], "packages/foo")).toEqual([]);
  });
});
