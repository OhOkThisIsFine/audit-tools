import { describe, expect, it } from "vitest";
import {
  partitionWorkItems,
  type WorkPartitionItem,
} from "../../src/shared/decompose/workPartition.js";

function item(
  id: string,
  unitIds: string[],
  files: string[],
  semanticTags: string[] = ["lens:correctness"],
  role: WorkPartitionItem["role"] = "implementation",
): WorkPartitionItem {
  return { id, unitIds, files, semanticTags, estimatedTokens: 1, role };
}

describe("partitionWorkItems", () => {
  it("derives block size from the supplied token budget, not a finding-count ceiling", () => {
    const input = Array.from({ length: 40 }, (_, index) =>
      item(
        `F-${String(index + 1).padStart(3, "0")}`,
        ["coarse-unit"],
        [`src/file-${index + 1}.ts`],
      ),
    );

    const result = partitionWorkItems(input, { capacityTokens: 100_000 });

    expect(result.groups).toHaveLength(1);
  });

  it("uses declared parallelism without inventing a concurrency ceiling", () => {
    const input = Array.from({ length: 12 }, (_, index) =>
      item(`F-${index}`, ["coarse-unit"], [`src/file-${index}.ts`]),
    );

    const undeclared = partitionWorkItems(input, { capacityTokens: 100_000 });
    const declared = partitionWorkItems(input, {
      capacityTokens: 100_000,
      availableParallelism: 4,
    });

    expect(undeclared.groups).toHaveLength(1);
    expect(declared.groups).toHaveLength(4);
  });

  it("is deterministic, bounded, and conserves every item exactly once", () => {
    const input = Array.from({ length: 65 }, (_, index) =>
      item(
        `F-${String(index + 1).padStart(3, "0")}`,
        ["coarse-unit"],
        [`src/file-${index + 1}.ts`],
        [`lens:${index % 2 === 0 ? "correctness" : "tests"}`],
      ),
    );

    const forward = partitionWorkItems(input, { capacityTokens: 10 });
    const reverse = partitionWorkItems([...input].reverse(), {
      capacityTokens: 10,
    });

    expect(reverse).toEqual(forward);
    expect(forward.groups.length).toBeGreaterThan(1);
    expect(
      Math.max(...forward.groups.map((group) => group.estimatedTokens)),
    ).toBeLessThanOrEqual(10);
    expect(forward.groups.flatMap((group) => group.itemIds).sort()).toEqual(
      input.map((entry) => entry.id).sort(),
    );
    expect(new Set(forward.groups.flatMap((group) => group.itemIds)).size).toBe(
      input.length,
    );
  });

  it("preserves read overlap but distinguishes it from predicted write conflict", () => {
    const result = partitionWorkItems(
      [
        item("A", ["shared-unit"], ["src/a.ts"]),
        item("B", ["shared-unit"], ["src/b.ts"]),
        item("C", ["shared-unit"], ["src/a.ts"]),
      ],
      { capacityTokens: 1 },
    );

    expect(result.groups).toHaveLength(3);
    expect(
      result.seams.some(
        (seam) => seam.kind === "shared_context" && !seam.requiresPreparation,
      ),
    ).toBe(true);
    expect(
      result.seams.some(
        (seam) =>
          seam.kind === "predicted_write_conflict" &&
          seam.requiresPreparation &&
          seam.sharedFiles.includes("src/a.ts"),
      ),
    ).toBe(true);
  });

  it("turns a broad finding into a coordination obligation instead of an ownership hyperedge", () => {
    const local = Array.from({ length: 5 }, (_, index) =>
      item(`local-${index}`, [`u-${index}`], [`src/u-${index}/entry.ts`]),
    );
    const systemic = item(
      "systemic",
      local.map((entry) => entry.unitIds[0]!),
      local.map((entry) => entry.files[0]!),
      ["lens:architecture"],
      "coordination",
    );
    const result = partitionWorkItems([systemic, ...local], {
      capacityTokens: 2,
    });

    const coordination = result.groups.find((group) =>
      group.itemIds.includes("systemic"),
    );
    expect(coordination?.role).toBe("coordination");
    expect(coordination?.itemIds).toEqual(["systemic"]);
    expect(
      result.seams.some(
        (seam) =>
          seam.kind === "systemic_coordination" && seam.requiresPreparation,
      ),
    ).toBe(true);
  });
});
