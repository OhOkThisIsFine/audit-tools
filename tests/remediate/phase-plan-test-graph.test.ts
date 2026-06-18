import { describe, it, expect } from "vitest";
import { deriveBlocksFromTestGraph } from "../../src/remediate/phases/plan.js";
import type { Finding } from "../../src/remediate/state/types.js";

function makeFinding(id: string, paths: string[]): Finding {
  return {
    id,
    title: id,
    category: "correctness",
    severity: "low",
    confidence: "high",
    lens: "correctness",
    summary: `summary for ${id}`,
    affected_files: paths.map((path) => ({ path })),
  };
}

describe("deriveBlocksFromTestGraph", () => {
  it("single finding with no test overlap is not useful", () => {
    const findings = [makeFinding("F-1", ["src/foo.ts"])];
    const { blocks, useful } = deriveBlocksFromTestGraph(findings, []);
    // One finding → one block; no consolidation, so 1 < 1 is false.
    expect(blocks).toHaveLength(1);
    expect(useful).toBe(false);
  });

  it("single finding with matching test files is still not useful", () => {
    const findings = [makeFinding("F-1", ["src/foo.ts"])];
    // A test file shares the "foo.ts" segment, but a lone finding can never be
    // consolidated, so useful must remain false (1 < 1 is false).
    const { blocks, useful } = deriveBlocksFromTestGraph(findings, [
      "tests/foo.ts",
    ]);
    expect(blocks).toHaveLength(1);
    expect(useful).toBe(false);
  });

  it("multiple findings grouped by shared tests is useful", () => {
    const findings = [
      makeFinding("F-1", ["src/shared/alpha.ts"]),
      makeFinding("F-2", ["src/shared/beta.ts"]),
    ];
    // Both source files share the "shared" segment with this test file, so both
    // are covered by it and land in the same block: blocks.length (1) < 2.
    const { blocks, useful } = deriveBlocksFromTestGraph(findings, [
      "tests/shared/all.ts",
    ]);
    expect(blocks).toHaveLength(1);
    expect(useful).toBe(true);
  });

  it("multiple findings with no shared tests is not useful", () => {
    const findings = [
      makeFinding("F-1", ["alpha/one.ts"]),
      makeFinding("F-2", ["beta/two.ts"]),
    ];
    // Disjoint coverage: each source matches only its own test, so the findings
    // stay in separate blocks (blocks.length === findings.length).
    const { blocks, useful } = deriveBlocksFromTestGraph(findings, [
      "alpha/one.test.ts",
      "beta/two.test.ts",
    ]);
    expect(blocks).toHaveLength(2);
    expect(useful).toBe(false);
  });
});
