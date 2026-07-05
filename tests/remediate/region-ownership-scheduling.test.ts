import { describe, it, expect } from "vitest";
import {
  ownershipSubWaves,
  type OwnershipSchedulerNode,
} from "audit-tools/shared";

const ROOT = "/repo";

function ids(waves: OwnershipSchedulerNode[][]): string[][] {
  return waves.map((w) => w.map((n) => n.block_id));
}

describe("region-aware ownership scheduling (cofile_parallel_safe)", () => {
  it("(a) two same-file nodes both flagged => one sub-wave", () => {
    const level: OwnershipSchedulerNode[] = [
      { block_id: "B1", write_paths: ["src/x.ts"], cofile_parallel_safe: true },
      { block_id: "B2", write_paths: ["src/x.ts"], cofile_parallel_safe: true },
    ];
    const waves = ownershipSubWaves(level, ROOT);
    expect(ids(waves)).toEqual([["B1", "B2"]]);
  });

  it("(b) one flagged + one unflagged same-file => separate successive sub-waves", () => {
    const level: OwnershipSchedulerNode[] = [
      { block_id: "B1", write_paths: ["src/x.ts"], cofile_parallel_safe: true },
      { block_id: "B2", write_paths: ["src/x.ts"] }, // absent flag
    ];
    const waves = ownershipSubWaves(level, ROOT);
    expect(ids(waves)).toEqual([["B1"], ["B2"]]);

    // explicit false behaves identically to absent
    const level2: OwnershipSchedulerNode[] = [
      { block_id: "B1", write_paths: ["src/x.ts"], cofile_parallel_safe: false },
      { block_id: "B2", write_paths: ["src/x.ts"], cofile_parallel_safe: true },
    ];
    expect(ids(ownershipSubWaves(level2, ROOT))).toEqual([["B1"], ["B2"]]);
  });

  it("(c) different-file nodes still batch into one sub-wave", () => {
    const level: OwnershipSchedulerNode[] = [
      { block_id: "B1", write_paths: ["src/a.ts"] },
      { block_id: "B2", write_paths: ["src/b.ts"] },
    ];
    const waves = ownershipSubWaves(level, ROOT);
    expect(ids(waves)).toEqual([["B1", "B2"]]);
  });

  it("(d) identical input => identical partitions (determinism)", () => {
    const build = (): OwnershipSchedulerNode[] => [
      { block_id: "B3", write_paths: ["src/x.ts"], cofile_parallel_safe: true },
      { block_id: "B1", write_paths: ["src/x.ts"] },
      { block_id: "B2", write_paths: ["src/y.ts"] },
      { block_id: "B4", write_paths: ["src/x.ts"], cofile_parallel_safe: true },
    ];
    const r1 = ids(ownershipSubWaves(build(), ROOT));
    const r2 = ids(ownershipSubWaves(build(), ROOT));
    expect(r1).toEqual(r2);
    // B1 (unflagged) on x.ts serializes; B3+B4 (both flagged) co-batch; B2 free.
    expect(r1).toEqual([["B1", "B2"], ["B3", "B4"]]);
  });

  it("(e) rel/abs spellings of one path treated as same file via canonicalizeFilePath", () => {
    const level: OwnershipSchedulerNode[] = [
      { block_id: "B1", write_paths: ["src/x.ts"] },
      { block_id: "B2", write_paths: ["/repo/src/x.ts"] },
    ];
    // Same canonical file, neither flagged => must serialize (not co-batch).
    const waves = ownershipSubWaves(level, ROOT);
    expect(ids(waves)).toEqual([["B1"], ["B2"]]);

    // Same canonical file, both flagged => co-batch despite differing spellings.
    const level2: OwnershipSchedulerNode[] = [
      { block_id: "B1", write_paths: ["src/x.ts"], cofile_parallel_safe: true },
      { block_id: "B2", write_paths: ["/repo/src/x.ts"], cofile_parallel_safe: true },
    ];
    expect(ids(ownershipSubWaves(level2, ROOT))).toEqual([["B1", "B2"]]);
  });
});
