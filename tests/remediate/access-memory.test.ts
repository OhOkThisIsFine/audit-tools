import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deriveRemediationAccessMemory,
  readRemediationAccessMemory,
  computeBlockContinuityScores,
} from "../../src/remediate/state/accessMemory.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import { makeState } from "./test-helpers.js";

/** Minimal RemediationBlock stub carrying just the scheduler-relevant surface. */
const block = (block_id: string, touched_files: string[]): RemediationBlock =>
  ({ block_id, items: [], touched_files, parallel_safe: false }) as unknown as RemediationBlock;
const scopeOf = (b: RemediationBlock) => b.touched_files ?? [];

/** Wrap the shared makeState with the plan.blocks + items shape this harvest reads. */
function stateWith(
  blocks: Array<{
    block_id: string;
    items: string[];
    touched_files: string[];
    phase_ordinal?: number;
  }>,
  items: Record<string, { status: string; block_id: string; touched_files?: string[] }>,
  planId = "plan-1",
) {
  return makeState({
    plan: {
      plan_id: planId,
      findings: [],
      blocks: blocks.map((b) => ({ parallel_safe: false, ...b })),
      project_type: "node",
      candidate_closing_actions: [],
    },
    items: Object.fromEntries(
      Object.entries(items).map(([id, v]) => [
        id,
        {
          finding_id: id,
          status: v.status,
          block_id: v.block_id,
          ...(v.touched_files ? { item_spec: { touched_files: v.touched_files } } : {}),
        },
      ]),
    ),
  });
}

describe("deriveRemediationAccessMemory", () => {
  it("counts a resolved item's edit surface; excludes resolved_no_change, blocked, and pending", () => {
    const state = stateWith(
      [
        { block_id: "b1", items: ["f1"], touched_files: ["src/a.ts", "src/b.ts"], phase_ordinal: 0 },
        { block_id: "b2", items: ["f2"], touched_files: ["src/nochange.ts"], phase_ordinal: 1 },
        { block_id: "b3", items: ["f3"], touched_files: ["src/blocked.ts"], phase_ordinal: 2 },
      ],
      {
        f1: { status: "resolved", block_id: "b1" }, // real edit → counts (block fallback)
        f2: { status: "resolved_no_change", block_id: "b2" }, // zero diff → excluded
        f3: { status: "blocked", block_id: "b3" }, // not landed → excluded
      },
    );

    const mem = deriveRemediationAccessMemory(state);

    expect(mem.paths.map((p) => p.path)).toEqual(["src/a.ts", "src/b.ts"]);
    for (const rec of mem.paths) {
      expect(rec.edited_count).toBe(1);
      expect(rec.covered_count).toBe(0); // remediate harvest never sets covered
    }
    expect(mem.run_id).toBe("plan-1");
    expect(mem.total_ordinals).toBe(3); // full block count = stable recency denominator
    expect(mem.paths[0].last_ordinal).toBe(0); // b1 at ordinal 0
  });

  it("prefers per-item item_spec.touched_files over the block surface", () => {
    const state = stateWith(
      [{ block_id: "b1", items: ["f1", "f2"], touched_files: ["src/whole-block.ts"], phase_ordinal: 0 }],
      {
        f1: { status: "resolved", block_id: "b1", touched_files: ["src/only-f1.ts"] },
        f2: { status: "blocked", block_id: "b1" }, // blocked sibling contributes nothing
      },
    );
    const mem = deriveRemediationAccessMemory(state);
    // Only f1's own surface — NOT the block's whole declared surface, and not f2's.
    expect(mem.paths.map((p) => p.path)).toEqual(["src/only-f1.ts"]);
  });

  it("orders blocks by (phase_ordinal, block_id) for a deterministic recency ordinal", () => {
    const state = stateWith(
      [
        { block_id: "z", items: ["f1"], touched_files: ["src/z.ts"], phase_ordinal: 0 },
        { block_id: "a", items: ["f2"], touched_files: ["src/a.ts"], phase_ordinal: 0 },
      ],
      { f1: { status: "resolved", block_id: "z" }, f2: { status: "resolved", block_id: "a" } },
    );
    const mem = deriveRemediationAccessMemory(state);
    // Same phase → block_id tiebreak: "a" is ordinal 0, "z" is ordinal 1.
    expect(mem.paths.find((p) => p.path === "src/a.ts")!.last_ordinal).toBe(0);
    expect(mem.paths.find((p) => p.path === "src/z.ts")!.last_ordinal).toBe(1);
  });

  it("tolerates missing touched_files (never throws the merge) and is deterministic", () => {
    // Block with no touched_files field at all + resolved item → no crash, no paths.
    const noSurface = deriveRemediationAccessMemory(
      stateWith([{ block_id: "b1", items: ["f1"], touched_files: undefined as never }], {
        f1: { status: "resolved", block_id: "b1" },
      }),
    );
    expect(noSurface.paths).toEqual([]);

    const empty = deriveRemediationAccessMemory(stateWith([], {}));
    expect(empty.paths).toEqual([]);
    expect(empty.total_ordinals).toBe(0);

    const state = stateWith(
      [{ block_id: "b1", items: ["f1"], touched_files: ["src/b.ts", "src/a.ts"], phase_ordinal: 0 }],
      { f1: { status: "resolved", block_id: "b1" } },
    );
    expect(JSON.stringify(deriveRemediationAccessMemory(state))).toBe(
      JSON.stringify(deriveRemediationAccessMemory(state)),
    );
  });
});

describe("readRemediationAccessMemory (consumer, increment 2d)", () => {
  it("returns undefined when the file is absent (first pass, before any merge)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-read-"));
    try {
      expect(await readRemediationAccessMemory(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips a valid harvested record, and degrades malformed JSON to undefined (no bias, no throw)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-read-"));
    try {
      const state = stateWith(
        [{ block_id: "b1", items: ["f1"], touched_files: ["src/a.ts"], phase_ordinal: 0 }],
        { f1: { status: "resolved", block_id: "b1" } },
      );
      const mem = deriveRemediationAccessMemory(state);
      writeFileSync(join(dir, "access_memory.json"), JSON.stringify(mem));
      const read = await readRemediationAccessMemory(dir);
      expect(read?.paths.map((p) => p.path)).toEqual(["src/a.ts"]);

      // Corrupt the file → the reader must degrade to undefined, never throw.
      writeFileSync(join(dir, "access_memory.json"), "{ not valid json");
      expect(await readRemediationAccessMemory(dir)).toBeUndefined();

      // Structurally-wrong-but-valid JSON → schema-reject to undefined.
      writeFileSync(join(dir, "access_memory.json"), JSON.stringify({ nope: true }));
      expect(await readRemediationAccessMemory(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeBlockContinuityScores (consumer, increment 2d)", () => {
  it("no access-memory ⇒ empty map (no bias)", () => {
    const scores = computeBlockContinuityScores(undefined, [block("B-1", ["src/a.ts"])], scopeOf);
    expect(scores.size).toBe(0);
  });

  it("scores a block whose files were edited; a block touching untouched files is absent from the map", () => {
    // Harvest a record where src/a.ts was edited (resolved item), src/z.ts never was.
    const mem = deriveRemediationAccessMemory(
      stateWith(
        [{ block_id: "b1", items: ["f1"], touched_files: ["src/a.ts"], phase_ordinal: 0 }],
        { f1: { status: "resolved", block_id: "b1" } },
      ),
    );
    const scores = computeBlockContinuityScores(
      mem,
      [block("B-hit", ["src/a.ts"]), block("B-miss", ["src/z.ts"])],
      scopeOf,
    );
    expect(scores.get("B-hit")).toBeGreaterThan(0);
    expect(scores.has("B-miss")).toBe(false);
  });

  it("seed-only recency: a block on the more-recently-edited file outranks one on an older edit", () => {
    // Two phases: src/old.ts edited at ordinal 0, src/new.ts at ordinal 1 (more recent).
    const mem = deriveRemediationAccessMemory(
      stateWith(
        [
          { block_id: "b1", items: ["f1"], touched_files: ["src/old.ts"], phase_ordinal: 0 },
          { block_id: "b2", items: ["f2"], touched_files: ["src/new.ts"], phase_ordinal: 1 },
        ],
        {
          f1: { status: "resolved", block_id: "b1" },
          f2: { status: "resolved", block_id: "b2" },
        },
      ),
    );
    const scores = computeBlockContinuityScores(
      mem,
      [block("B-old", ["src/old.ts"]), block("B-new", ["src/new.ts"])],
      scopeOf,
    );
    expect(scores.get("B-new")!).toBeGreaterThan(scores.get("B-old")!);
  });
});
