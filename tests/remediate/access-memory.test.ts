import { describe, it, expect } from "vitest";
import { deriveRemediationAccessMemory } from "../../src/remediate/state/accessMemory.js";
import { makeState } from "./test-helpers.js";

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
