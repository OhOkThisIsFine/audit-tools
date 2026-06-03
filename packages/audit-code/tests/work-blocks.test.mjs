import test from "node:test";
import assert from "node:assert/strict";

const { buildWorkBlocks } = await import("../dist/reporting/workBlocks.js");

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

  assert.equal(blocks.length, 1);
  assert.deepEqual([...blocks[0].finding_ids].sort(), ["F1", "F2"]);
  assert.ok(blocks[0].unit_ids.includes("unit-shared"));
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

  assert.equal(blocks.length, 2);
  const blockA = blocks.find((b) => b.owned_files.includes("src/a.ts"));
  const blockB = blocks.find((b) => b.owned_files.includes("src/b.ts"));
  assert.equal(blockA.id, "block-1");
  assert.equal(blockB.id, "block-2");
  // The block owning the 'from' file depends on the block owning the 'to' file.
  assert.deepEqual(blockA.depends_on, ["block-2"]);
  // No reverse edge supplied → the 'to' block has no dependency.
  assert.deepEqual(blockB.depends_on, []);
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

  assert.equal(blocks.length, 3);
  // Ordered highest severity first, with ids re-indexed in that order.
  assert.deepEqual(
    blocks.map((b) => b.max_severity),
    ["critical", "medium", "low"],
  );
  assert.deepEqual(
    blocks.map((b) => b.id),
    ["block-1", "block-2", "block-3"],
  );
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

  assert.equal(blocks.length, 2);
  const blockA = blocks.find((b) => b.owned_files.includes("src/a.ts"));
  const blockB = blocks.find((b) => b.owned_files.includes("src/b.ts"));
  // Flow blocks are ordered by id; the earlier block depends on the later one.
  assert.equal(blockA.id, "block-1");
  assert.equal(blockB.id, "block-2");
  assert.deepEqual(blockA.depends_on, ["block-2"]);
  assert.deepEqual(blockB.depends_on, []);
});
