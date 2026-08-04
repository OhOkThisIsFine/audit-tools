import { test, expect } from "vitest";
import type { Finding, UnitManifest } from "../../src/audit/types.js";
import type { FindingSeverity, CriticalFlowManifest } from "audit-tools/shared";

const { buildWorkBlockPartition, buildWorkBlocks } = await import("../../src/audit/reporting/workBlocks.js");
const KNOWN_CONTEXT_BUDGET = 100_000;

// Minimal Finding shape — buildWorkBlocks only reads id, severity, and
// affected_files[].path at runtime.
function finding(
  id: string,
  severity: FindingSeverity,
  files: string[],
  systemic = false,
): Finding {
  return {
    id,
    title: id,
    category: "test",
    severity,
    confidence: "high",
    lens: "correctness",
    summary: id,
    affected_files: files.map((path) => ({ path })),
    systemic,
  };
}

function unitManifest(units: { unit_id: string; files: string[] }[]): UnitManifest {
  return {
    units: units.map((u) => ({
      unit_id: u.unit_id,
      name: u.unit_id,
      files: u.files,
      required_lenses: [],
    })),
  };
}

test("buildWorkBlocks keeps a small cohesive shared-unit cluster together", () => {
  const blocks = buildWorkBlocks({
    contextBudgetTokens: KNOWN_CONTEXT_BUDGET,
    findings: [
      finding("F1", "high", ["src/a.ts"]),
      finding("F2", "low", ["src/b.ts"]),
    ],
    // Shared-unit affinity keeps a small cohesive pair together without making
    // that unit an unbounded transitive-closure edge.
    unitManifest: unitManifest([
      { unit_id: "unit-shared", files: ["src/a.ts", "src/b.ts"] },
    ]),
  });

  expect(blocks.length).toBe(1);
  expect([...blocks[0].finding_ids].sort()).toEqual(["F1", "F2"]);
  expect(blocks[0].unit_ids.includes("unit-shared")).toBeTruthy();
});

test("buildWorkBlocks bounds a coarse shared unit without discarding overlap", () => {
  const findings = Array.from({ length: 33 }, (_, index) =>
    finding(`F-${String(index + 1).padStart(2, "0")}`, "medium", [
      `src/audit/file-${index + 1}.ts`,
    ]),
  );
  const blocks = buildWorkBlocks({
    findings,
    contextBudgetTokens: 500,
    unitManifest: unitManifest([
      {
        unit_id: "src-audit",
        files: findings.flatMap((entry) =>
          entry.affected_files.map((file) => file.path),
        ),
      },
    ]),
  });
  const roomy = buildWorkBlocks({
    findings,
    contextBudgetTokens: 100_000,
    unitManifest: unitManifest([
      {
        unit_id: "src-audit",
        files: findings.flatMap((entry) =>
          entry.affected_files.map((file) => file.path),
        ),
      },
    ]),
  });

  expect(blocks.length).toBeGreaterThan(1);
  expect(roomy).toHaveLength(1);
  expect(blocks.length).toBeGreaterThan(roomy.length);
  expect(blocks.every((block) => block.unit_ids.includes("src-audit"))).toBe(true);
  expect(blocks.flatMap((block) => block.finding_ids).sort()).toEqual(
    findings.map((entry) => entry.id).sort(),
  );

  const topology = buildWorkBlockPartition({
    findings,
    contextBudgetTokens: 500,
    unitManifest: unitManifest([
      {
        unit_id: "src-audit",
        files: findings.flatMap((entry) =>
          entry.affected_files.map((file) => file.path),
        ),
      },
    ]),
  });
  expect(topology.seams.length).toBeGreaterThan(0);
  expect(topology.seams.every((seam) => seam.kind === "shared_context")).toBe(true);
  expect(topology.seams.every((seam) => !seam.requires_preparation)).toBe(true);
});

test("buildWorkBlockPartition counts unique affected-file context against capacity", () => {
  const findings = [
    finding("F-A", "medium", ["src/a.ts"]),
    finding("F-B", "medium", ["src/b.ts"]),
  ];
  const units = unitManifest([
    { unit_id: "shared", files: ["src/a.ts", "src/b.ts"] },
  ]);

  const metadataOnly = buildWorkBlockPartition({
    findings,
    unitManifest: units,
    contextBudgetTokens: 1_100,
  });
  const withSourceContext = buildWorkBlockPartition({
    findings,
    unitManifest: units,
    contextBudgetTokens: 1_100,
    sizeIndex: { "src/a.ts": 4_000, "src/b.ts": 4_000 },
  });

  expect(metadataOnly.blocks).toHaveLength(1);
  expect(withSourceContext.blocks).toHaveLength(2);
});

test("buildWorkBlockPartition emits a required seam for cross-block file overlap", () => {
  const findings = Array.from({ length: 33 }, (_, index) =>
    finding(`F-${index + 1}`, "medium", [
      "src/shared.ts",
      `src/leaf-${index + 1}.ts`,
    ]),
  );
  const topology = buildWorkBlockPartition({
    findings,
    contextBudgetTokens: 500,
  });

  expect(topology.blocks.length).toBeGreaterThan(1);
  expect(
    topology.seams.some(
      (seam) =>
        seam.kind === "predicted_write_conflict" &&
        seam.requires_preparation &&
        seam.shared_files.includes("src/shared.ts"),
    ),
  ).toBe(true);
});

test("buildWorkBlockPartition isolates a systemic finding as coordination work", () => {
  const files = Array.from({ length: 20 }, (_, index) => `src/u-${index % 4}/f-${index}.ts`);
  const systemic = finding("SYSTEMIC", "high", files, true);
  const locals = Array.from({ length: 4 }, (_, index) =>
    finding(`LOCAL-${index}`, "medium", [`src/u-${index}/f-${index}.ts`]),
  );
  const topology = buildWorkBlockPartition({
    findings: [systemic, ...locals],
    contextBudgetTokens: KNOWN_CONTEXT_BUDGET,
    unitManifest: unitManifest(
      Array.from({ length: 4 }, (_, index) => ({
        unit_id: `u-${index}`,
        files: files.filter((file) => file.startsWith(`src/u-${index}/`)),
      })),
    ),
  });

  const coordination = topology.blocks.find((block) => block.finding_ids.includes("SYSTEMIC"));
  expect(coordination?.role).toBe("coordination");
  expect(coordination?.finding_ids).toEqual(["SYSTEMIC"]);
  expect(
    topology.seams.some(
      (seam) => seam.kind === "systemic_coordination" && seam.requires_preparation,
    ),
  ).toBe(true);
});

test("buildWorkBlocks derives depends_on from graphBundle import edges across blocks", () => {
  const blocks = buildWorkBlocks({
    contextBudgetTokens: KNOWN_CONTEXT_BUDGET,
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
    availableParallelism: 2,
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
  if (blockA === undefined || blockB === undefined) {
    throw new Error("expected blocks owning src/a.ts and src/b.ts");
  }
  expect(blockA.id).toBe("block-1");
  expect(blockB.id).toBe("block-2");
  // The block owning the 'from' file depends on the block owning the 'to' file.
  expect(blockA.depends_on).toEqual(["block-2"]);
  // No reverse edge supplied → the 'to' block has no dependency.
  expect(blockB.depends_on).toEqual([]);
});

test("buildWorkBlocks re-indexes block ids sequentially after severity sort", () => {
  const blocks = buildWorkBlocks({
    contextBudgetTokens: KNOWN_CONTEXT_BUDGET,
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
    availableParallelism: 3,
  });

  expect(blocks.length).toBe(3);
  // Ordered highest severity first, with ids re-indexed in that order.
  expect(blocks.map((b) => b.max_severity)).toEqual(["critical", "medium", "low"]);
  expect(blocks.map((b) => b.id)).toEqual(["block-1", "block-2", "block-3"]);
});

test("buildWorkBlocks returns [] for empty findings (early-return guard)", () => {
  expect(buildWorkBlocks({ findings: [] })).toEqual([]);
});

test("buildWorkBlocks refuses non-empty findings when capacity is unknown", () => {
  expect(() =>
    buildWorkBlocks({ findings: [finding("F1", "high", ["src/a.ts"])] }),
  ).toThrow(/usable context budget is unknown/i);
});

test("buildWorkBlocks falls back to file:<path> units when no unitManifest is supplied", () => {
  // No unitManifest -> each affected file's owned unit is `file:<path>`. Two
  // findings on the same file share that fallback key and group into one block.
  const sameFile = buildWorkBlocks({
    contextBudgetTokens: KNOWN_CONTEXT_BUDGET,
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
    contextBudgetTokens: KNOWN_CONTEXT_BUDGET,
    findings: [
      finding("F-A", "high", ["src/a.ts"]),
      finding("F-B", "low", ["src/b.ts"]),
    ],
    availableParallelism: 2,
  });
  expect(distinctFiles.length).toBe(2);
  const blockA = distinctFiles.find((b) => b.owned_files.includes("src/a.ts"));
  const blockB = distinctFiles.find((b) => b.owned_files.includes("src/b.ts"));
  if (blockA === undefined || blockB === undefined) {
    throw new Error("expected blocks owning src/a.ts and src/b.ts");
  }
  expect(blockA.unit_ids.includes("file:src/a.ts")).toBeTruthy();
  expect(blockB.unit_ids.includes("file:src/b.ts")).toBeTruthy();
});

test("buildWorkBlocks derives depends_on from criticalFlows paths across blocks", () => {
  const criticalFlows: CriticalFlowManifest = {
    flows: [
      {
        id: "flow-1",
        name: "flow-1",
        entrypoints: [],
        paths: ["src/a.ts", "src/b.ts"],
        concerns: [],
      },
    ],
  };
  const blocks = buildWorkBlocks({
    contextBudgetTokens: KNOWN_CONTEXT_BUDGET,
    findings: [
      finding("F-A", "high", ["src/a.ts"]),
      finding("F-B", "low", ["src/b.ts"]),
    ],
    unitManifest: unitManifest([
      { unit_id: "unit-a", files: ["src/a.ts"] },
      { unit_id: "unit-b", files: ["src/b.ts"] },
    ]),
    availableParallelism: 2,
    criticalFlows,
  });

  expect(blocks.length).toBe(2);
  const blockA = blocks.find((b) => b.owned_files.includes("src/a.ts"));
  const blockB = blocks.find((b) => b.owned_files.includes("src/b.ts"));
  if (blockA === undefined || blockB === undefined) {
    throw new Error("expected blocks owning src/a.ts and src/b.ts");
  }
  // Flow blocks are ordered by id; the earlier block depends on the later one.
  expect(blockA.id).toBe("block-1");
  expect(blockB.id).toBe("block-2");
  expect(blockA.depends_on).toEqual(["block-2"]);
  expect(blockB.depends_on).toEqual([]);
});
