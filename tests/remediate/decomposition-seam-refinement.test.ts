import { describe, it, expect } from "vitest";
import {
  mergeBlocksSharingFiles,
} from "../../src/remediate/phases/plan.js";
import type { Finding, RemediationBlock } from "../../src/remediate/state/types.js";

function finding(id: string, paths: string[]): Finding {
  return {
    id,
    title: `Finding ${id}`,
    summary: `summary ${id}`,
    lens: "correctness",
    severity: "medium",
    confidence: "high",
    affected_files: paths.map((p) => ({ path: p })),
    evidence: [`${paths[0]}:1 — evidence`],
  } as unknown as Finding;
}

function block(
  id: string,
  items: string[],
  extra: Partial<RemediationBlock> = {},
): RemediationBlock {
  return {
    block_id: id,
    items,
    parallel_safe: true,
    touched_files: [],
    ...extra,
  } as RemediationBlock;
}

describe("A3 decomposition seam refinement — mergeBlocksSharingFiles", () => {
  it("keeps N independent same-file findings as N separate blocks, each cofile_parallel_safe", () => {
    const findings = [
      finding("F-1", ["src/A.ts"]),
      finding("F-2", ["src/A.ts"]),
      finding("F-3", ["src/A.ts"]),
    ];
    const blocks = [
      block("B-001", ["F-1"]),
      block("B-002", ["F-2"]),
      block("B-003", ["F-3"]),
    ];

    const result = mergeBlocksSharingFiles(blocks, findings, ".");

    // Not collapsed into one unioned block.
    expect(result).toHaveLength(3);
    expect(result.map((b) => b.block_id).sort()).toEqual([
      "B-001",
      "B-002",
      "B-003",
    ]);
    for (const b of result) {
      expect(b.cofile_parallel_safe).toBe(true);
      expect(b.items).toHaveLength(1);
    }
  });

  it("canonical file identity: different spellings of one file still share (via canonicalizeFilePath)", () => {
    const findings = [
      finding("F-1", ["src/A.ts"]),
      finding("F-2", ["./src/A.ts"]),
    ];
    const blocks = [block("B-001", ["F-1"]), block("B-002", ["F-2"])];

    const result = mergeBlocksSharingFiles(blocks, findings, ".");

    expect(result).toHaveLength(2);
    for (const b of result) expect(b.cofile_parallel_safe).toBe(true);
  });

  it("does NOT flag blocks that touch genuinely different files", () => {
    const findings = [
      finding("F-1", ["src/A.ts"]),
      finding("F-2", ["src/B.ts"]),
    ];
    const blocks = [block("B-001", ["F-1"]), block("B-002", ["F-2"])];

    const result = mergeBlocksSharingFiles(blocks, findings, ".");

    expect(result).toHaveLength(2);
    for (const b of result) expect(b.cofile_parallel_safe).toBeUndefined();
  });

  it("two dependency-ordered same-file blocks still serialize (neither flagged parallel-safe)", () => {
    const findings = [
      finding("F-1", ["src/A.ts"]),
      finding("F-2", ["src/A.ts"]),
    ];
    const blocks = [
      block("B-001", ["F-1"]),
      block("B-002", ["F-2"], { dependencies: ["B-001"] }),
    ];

    const result = mergeBlocksSharingFiles(blocks, findings, ".");

    // Still two separate blocks, still ordered by the dependency edge, and NOT
    // flagged parallel-safe (they must serialize).
    expect(result).toHaveLength(2);
    for (const b of result) expect(b.cofile_parallel_safe).toBeUndefined();
    const b2 = result.find((b) => b.block_id === "B-002")!;
    expect(b2.dependencies).toEqual(["B-001"]);
  });

  it("INV-A3-08: a single finding whose fix spans multiple regions of one file stays ONE block", () => {
    // One finding, one file — represents a multi-region fix in a single block.
    const findings = [finding("F-1", ["src/A.ts"])];
    const blocks = [block("B-001", ["F-1"])];

    const result = mergeBlocksSharingFiles(blocks, findings, ".");

    expect(result).toHaveLength(1);
    expect(result[0].items).toEqual(["F-1"]);
    // A lone block (nothing else shares its file) is not flagged.
    expect(result[0].cofile_parallel_safe).toBeUndefined();
  });
});
