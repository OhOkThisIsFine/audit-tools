import { expect, test } from "vitest";

import type { Finding, UnitManifest } from "../../src/audit/types.js";
import type { FindingSeverity } from "audit-tools/shared";
import { buildWorkBlockPartition } from "../../src/audit/reporting/workBlocks.js";

function finding(
  id: string,
  severity: FindingSeverity,
  files: string[],
  options: { lens?: Finding["lens"]; systemic?: boolean } = {},
): Finding {
  return {
    id,
    title: id,
    category: "test",
    severity,
    confidence: "high",
    lens: options.lens ?? "correctness",
    summary: id,
    affected_files: files.map((path) => ({ path })),
    systemic: options.systemic,
  };
}

function unitManifest(units: { unit_id: string; files: string[] }[]): UnitManifest {
  return {
    units: units.map((unit) => ({
      unit_id: unit.unit_id,
      name: unit.unit_id,
      files: unit.files,
      required_lenses: [],
    })),
  };
}

test("work blocks are one-to-one projections of canonical components", () => {
  const partition = buildWorkBlockPartition({
    findings: [
      finding("c", "low", ["other/c.ts"]),
      finding("b", "medium", ["src/b.ts", "src/a.ts"]),
      finding("a", "high", ["src/a.ts"]),
    ],
    unitManifest: unitManifest([
      { unit_id: "shared", files: ["src/a.ts", "src/b.ts"] },
    ]),
  });

  expect(partition.coherence_trace.components).toEqual([["a", "b"], ["c"]]);
  expect(partition.blocks.map((block) => block.finding_ids)).toEqual([
    ["a", "b"],
    ["c"],
  ]);
  expect(partition.blocks.map((block) => block.id)).toEqual([
    "block-1",
    "block-2",
  ]);
});

// ── Findings-draw eligibility: shared_file AND same_lens ──────────────────────
// Owner decision 2026-08-19. The disjunctive any-class-clears-60 rule collapsed a
// 3,230-finding run into 2 components (99.97% in one). Each half of the
// conjunction is pinned in BOTH directions so neither can be dropped silently.

test("findings sharing only a unit do not merge", () => {
  const partition = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/a.ts"]),
      finding("b", "medium", ["src/b.ts"]),
    ],
    unitManifest: unitManifest([
      { unit_id: "shared", files: ["src/a.ts", "src/b.ts"] },
    ]),
  });

  expect(partition.coherence_trace.components).toEqual([["a"], ["b"]]);
});

test("findings sharing a file but not a lens do not merge", () => {
  const partition = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/shared.ts"], { lens: "security" }),
      finding("b", "medium", ["src/shared.ts"], { lens: "reliability" }),
    ],
  });

  expect(partition.coherence_trace.components).toEqual([["a"], ["b"]]);
});

test("findings sharing a file and a lens merge", () => {
  const partition = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/shared.ts"], { lens: "security" }),
      finding("b", "medium", ["src/shared.ts"], { lens: "security" }),
    ],
  });

  expect(partition.coherence_trace.components).toEqual([["a", "b"]]);
});

test("call adjacency alone does not merge findings", () => {
  const partition = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/a.ts"], { lens: "security" }),
      finding("b", "medium", ["src/b.ts"], { lens: "security" }),
    ],
    graphBundle: {
      graphs: {
        imports: [{ from: "src/a.ts", to: "src/b.ts", kind: "imports" }],
        calls: [],
        references: [],
      },
    },
  });

  expect(partition.coherence_trace.components).toEqual([["a"], ["b"]]);
});

test("systemic presentation changes role without changing membership", () => {
  const regular = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/shared.ts"]),
      finding("b", "medium", ["src/shared.ts"]),
    ],
  });
  const systemic = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/shared.ts"], { systemic: true }),
      finding("b", "medium", ["src/shared.ts"]),
    ],
  });

  expect(systemic.coherence_trace).toEqual(regular.coherence_trace);
  expect(systemic.blocks[0]).toMatchObject({
    role: "coordination",
    finding_ids: ["a", "b"],
  });
});

test("advisory estimates count canonical unique physical file bytes once", () => {
  const [block] = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/shared.ts"]),
      finding("b", "medium", ["src\\shared.ts"]),
    ],
    sizeIndex: { "src/shared.ts": 100 },
  }).blocks;

  expect(block.owned_files).toEqual(["src/shared.ts"]);
  expect(block.unit_ids).toEqual([]);
  expect(block.token_estimate).toBe(900 + 2 * 600 + 25);
});

test("empty findings produce a complete empty trace and projection", () => {
  expect(buildWorkBlockPartition({ findings: [] })).toEqual({
    coherence_trace: {
      normalized_items: [],
      components: [],
    },
    blocks: [],
    seams: [],
  });
});

// ── Per-file aggregated seams ────────────────────────────────────────────────
// Owner decision 2026-08-19, a deliberate schema change: one seam per CONTESTED
// FILE listing every block that touches it, replacing the O(blocks²) pairwise
// seam. A contested file is by definition a predicted write conflict, so every
// emitted seam requires preparation; the unit-only "shared_context" pairwise
// seam is dropped as vacuous.

function contestedFileFindings(): Finding[] {
  return [
    finding("s1", "high", ["src/contested.ts"], { lens: "security" }),
    finding("s2", "medium", ["src/contested.ts"], { lens: "reliability" }),
    finding("s3", "low", ["src/contested.ts", "src/second.ts"], {
      lens: "performance",
    }),
    finding("s4", "medium", ["src/second.ts"], { lens: "tests" }),
  ];
}

test("one seam per contested file lists every block that touches it", () => {
  const partition = buildWorkBlockPartition({ findings: contestedFileFindings() });

  // Four distinct lenses over two files → four singleton blocks.
  expect(partition.blocks.map((block) => block.finding_ids)).toEqual([
    ["s1"],
    ["s2"],
    ["s3"],
    ["s4"],
  ]);

  const blockOf = (findingId: string): string =>
    partition.blocks.find((block) => block.finding_ids.includes(findingId))!.id;

  expect(partition.seams.map((seam) => seam.file)).toEqual([
    "src/contested.ts",
    "src/second.ts",
  ]);
  expect(partition.seams[0]!.block_ids).toEqual(
    [blockOf("s1"), blockOf("s2"), blockOf("s3")].sort(),
  );
  expect(partition.seams[1]!.block_ids).toEqual(
    [blockOf("s3"), blockOf("s4")].sort(),
  );
  for (const seam of partition.seams) {
    expect(seam.kind).toBe("predicted_write_conflict");
    expect(seam.requires_preparation).toBe(true);
    expect(seam.rationale).toContain(seam.file);
  }
});

test("seam ids are content-derived and stable under input permutation", () => {
  const forward = buildWorkBlockPartition({ findings: contestedFileFindings() });
  const reversed = buildWorkBlockPartition({
    findings: [...contestedFileFindings()].reverse(),
  });

  expect(reversed.seams).toEqual(forward.seams);
  for (const seam of forward.seams) {
    expect(seam.id).toMatch(/^seam-[0-9a-f]{12}$/u);
  }
  expect(new Set(forward.seams.map((seam) => seam.id)).size).toBe(
    forward.seams.length,
  );
  // Not positional: the id is a function of the contested file alone, so a run
  // that emits the SAME file in a different seam position keeps the same id.
  const subset = buildWorkBlockPartition({
    findings: contestedFileFindings().filter((f) => f.id !== "s4"),
  });
  expect(subset.seams.map((seam) => seam.id)).toEqual([forward.seams[0]!.id]);
});

test("a unit-only overlap emits no seam", () => {
  const partition = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/a.ts"], { lens: "security" }),
      finding("b", "medium", ["src/b.ts"], { lens: "reliability" }),
    ],
    unitManifest: unitManifest([
      { unit_id: "shared", files: ["src/a.ts", "src/b.ts"] },
    ]),
  });

  expect(partition.blocks).toHaveLength(2);
  expect(partition.blocks.every((block) => block.unit_ids.includes("shared"))).toBe(
    true,
  );
  expect(partition.seams).toEqual([]);
});

test("a coordination participant makes the contested file a systemic seam", () => {
  const partition = buildWorkBlockPartition({
    findings: [
      finding("a", "high", ["src/contested.ts"], {
        lens: "security",
        systemic: true,
      }),
      finding("b", "medium", ["src/contested.ts"], { lens: "reliability" }),
    ],
  });

  expect(partition.seams).toHaveLength(1);
  expect(partition.seams[0]).toMatchObject({
    file: "src/contested.ts",
    kind: "systemic_coordination",
    requires_preparation: true,
  });
});

test("a same-file clique that splits on unit contrast contests the file as a seam", () => {
  // Six findings on one file with one lens form a complete eligible graph, but
  // their secondary evidence disagrees (two units), so refinement cuts it. The
  // halves then both own `src/one.ts` — exactly the case the seam contract must
  // catch, since nothing else records that they collide on a write path.
  const partition = buildWorkBlockPartition({
    findings: [
      finding("k1", "high", ["src/one.ts", "alpha/a.ts"], { lens: "security" }),
      finding("k2", "medium", ["src/one.ts", "alpha/a.ts"], { lens: "security" }),
      finding("k3", "medium", ["src/one.ts", "alpha/a.ts"], { lens: "security" }),
      finding("k4", "medium", ["src/one.ts", "beta/b.ts"], { lens: "security" }),
      finding("k5", "medium", ["src/one.ts", "beta/b.ts"], { lens: "security" }),
      finding("k6", "low", ["src/one.ts", "beta/b.ts"], { lens: "security" }),
    ],
    unitManifest: unitManifest([
      { unit_id: "uA", files: ["alpha/a.ts"] },
      { unit_id: "uB", files: ["beta/b.ts"] },
    ]),
  });

  expect(partition.coherence_trace.components).toEqual([
    ["k1", "k2", "k3"],
    ["k4", "k5", "k6"],
  ]);
  expect(partition.blocks.map((block) => block.finding_ids)).toEqual([
    ["k1", "k2", "k3"],
    ["k4", "k5", "k6"],
  ]);
  expect(partition.seams).toHaveLength(1);
  expect(partition.seams[0]).toMatchObject({
    file: "src/one.ts",
    kind: "predicted_write_conflict",
    requires_preparation: true,
    block_ids: ["block-1", "block-2"],
  });
});
