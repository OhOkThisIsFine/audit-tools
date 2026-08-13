import { expect, test } from "vitest";

import type { Finding, UnitManifest } from "../../src/audit/types.js";
import type { FindingSeverity } from "audit-tools/shared";
import {
  buildWorkBlockPartition,
  buildWorkBlocks,
} from "../../src/audit/reporting/workBlocks.js";

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
      finding("b", "medium", ["src/b.ts"]),
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
  const [block] = buildWorkBlocks({
    findings: [
      finding("a", "high", ["src/shared.ts"]),
      finding("b", "medium", ["src\\shared.ts"]),
    ],
    sizeIndex: { "src/shared.ts": 100 },
  });

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
