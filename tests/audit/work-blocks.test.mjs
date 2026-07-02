import { test, expect } from "vitest";

const { buildWorkBlocks } = await import("../../src/audit/reporting/workBlocks.ts");

// Minimal Finding shape — buildWorkBlocks only reads id, severity, and
// affected_files[].path at runtime.
function finding(id, severity, files) {
  return {
    id,
    title: id,
    category: "test",
    severity,
    confidence: "high",
    lens: "correctness",
    summary: id,
    affected_files: files.map((path) => ({ path })),
  };
}

function unitManifest(units) {
  return {
    units: units.map((u) => ({
      unit_id: u.unit_id,
      name: u.unit_id,
      files: u.files,
      required_lenses: [],
    })),
  };
}

test("buildWorkBlocks groups findings sharing a unit into one block via union-find", () => {
  const blocks = buildWorkBlocks({
    findings: [
      finding("F1", "high", ["src/a.ts"]),
      finding("F2", "low", ["src/b.ts"]),
    ],
    // Both files belong to the same unit, so the union-find must merge the two
    // findings into a single block.
    unitManifest: unitManifest([
      { unit_id: "unit-shared", files: ["src/a.ts", "src/b.ts"] },
    ]),
  });

  expect(blocks.length).toBe(1);
  expect([...blocks[0].finding_ids].sort()).toEqual(["F1", "F2"]);
  expect(blocks[0].unit_ids.includes("unit-shared")).toBeTruthy();
});

test("buildWorkBlocks derives depends_on from graphBundle import edges across blocks", () => {
  const blocks = buildWorkBlocks({
    findings: [
      // Distinct units → distinct blocks. Severities chosen so the post-sort
      // ids are deterministic: high → block-1, low → block-2.
      finding("F-A", "high", ["src/a.ts"]),
      finding("F-B", "low", ["src/b.ts"]),
    ],
    unitManifest: unitManifest([
      { unit_id: "unit-a", files: ["src/a.ts"] },
      { unit_id: "unit-b", files: ["src/b.ts"] },
    ]),
    graphBundle: {
      graphs: {
        imports: [{ from: "src/a.ts", to: "src/b.ts", kind: "import" }],
        calls: [],
        references: [],
        routes: [],
      },
    },
  });

  expect(blocks.length).toBe(2);
  const blockA = blocks.find((b) => b.owned_files.includes("src/a.ts"));
  const blockB = blocks.find((b) => b.owned_files.includes("src/b.ts"));
  expect(blockA.id).toBe("block-1");
  expect(blockB.id).toBe("block-2");
  // The block owning the 'from' file depends on the block owning the 'to' file.
  expect(blockA.depends_on).toEqual(["block-2"]);
  // No reverse edge supplied → the 'to' block has no dependency.
  expect(blockB.depends_on).toEqual([]);
});

test("buildWorkBlocks re-indexes block ids sequentially after severity sort", () => {
  const blocks = buildWorkBlocks({
    findings: [
      finding("F-low", "low", ["src/low.ts"]),
      finding("F-crit", "critical", ["src/crit.ts"]),
      finding("F-med", "medium", ["src/med.ts"]),
    ],
    // Each file is its own unit → three separate single-finding blocks.
    unitManifest: unitManifest([
      { unit_id: "u-low", files: ["src/low.ts"] },
      { unit_id: "u-crit", files: ["src/crit.ts"] },
      { unit_id: "u-med", files: ["src/med.ts"] },
    ]),
  });

  expect(blocks.length).toBe(3);
  // Ordered highest severity first, with ids re-indexed in that order.
  expect(blocks.map((b) => b.max_severity)).toEqual(["critical", "medium", "low"]);
  expect(blocks.map((b) => b.id)).toEqual(["block-1", "block-2", "block-3"]);
});

test("buildWorkBlocks returns [] for empty findings (early-return guard)", () => {
  expect(buildWorkBlocks({ findings: [] })).toEqual([]);
});

test("buildWorkBlocks falls back to file:<path> units when no unitManifest is supplied", () => {
  // No unitManifest -> each affected file's owned unit is `file:<path>`. Two
  // findings on the same file share that fallback key and group into one block.
  const sameFile = buildWorkBlocks({
    findings: [
      finding("F1", "high", ["src/shared.ts"]),
      finding("F2", "low", ["src/shared.ts"]),
    ],
  });
  expect(sameFile.length).toBe(1);
  expect(sameFile[0].unit_ids.includes("file:src/shared.ts")).toBeTruthy();
  expect([...sameFile[0].finding_ids].sort()).toEqual(["F1", "F2"]);

  // Two findings on distinct files -> distinct file:<path> units -> two blocks.
  const distinctFiles = buildWorkBlocks({
    findings: [
      finding("F-A", "high", ["src/a.ts"]),
      finding("F-B", "low", ["src/b.ts"]),
    ],
  });
  expect(distinctFiles.length).toBe(2);
  const blockA = distinctFiles.find((b) => b.owned_files.includes("src/a.ts"));
  const blockB = distinctFiles.find((b) => b.owned_files.includes("src/b.ts"));
  expect(blockA.unit_ids.includes("file:src/a.ts")).toBeTruthy();
  expect(blockB.unit_ids.includes("file:src/b.ts")).toBeTruthy();
});

test("buildWorkBlocks derives depends_on from criticalFlows paths across blocks", () => {
  const blocks = buildWorkBlocks({
    findings: [
      finding("F-A", "high", ["src/a.ts"]),
      finding("F-B", "low", ["src/b.ts"]),
    ],
    unitManifest: unitManifest([
      { unit_id: "unit-a", files: ["src/a.ts"] },
      { unit_id: "unit-b", files: ["src/b.ts"] },
    ]),
    criticalFlows: {
      flows: [
        {
          flow_id: "flow-1",
          name: "flow-1",
          paths: ["src/a.ts", "src/b.ts"],
        },
      ],
    },
  });

  expect(blocks.length).toBe(2);
  const blockA = blocks.find((b) => b.owned_files.includes("src/a.ts"));
  const blockB = blocks.find((b) => b.owned_files.includes("src/b.ts"));
  // Flow blocks are ordered by id; the earlier block depends on the later one.
  expect(blockA.id).toBe("block-1");
  expect(blockB.id).toBe("block-2");
  expect(blockA.depends_on).toEqual(["block-2"]);
  expect(blockB.depends_on).toEqual([]);
});
