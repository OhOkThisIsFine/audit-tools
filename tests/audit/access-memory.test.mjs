import { test, expect, describe } from "vitest";

const { deriveAccessMemory } = await import(
  "../../src/audit/orchestrator/accessMemory.ts"
);
const { AccessMemorySchema, ACCESS_MEMORY_VERSION } = await import(
  "audit-tools/shared"
);

function makeResult(id, lens, paths, extra = {}) {
  return {
    task_id: `task-${id}`,
    unit_id: `unit-${id}`,
    pass_id: `pass:${lens}`,
    lens,
    file_coverage: paths.map((p) => ({ path: p, total_lines: 42 })),
    findings: [],
    ...extra,
  };
}

describe("deriveAccessMemory", () => {
  test("harvests frequency, recency (step ordinal), and sorted lenses per path", () => {
    const results = [
      makeResult("a", "correctness", ["src/b.ts", "src/a.ts"]), // ordinal 0
      makeResult("b", "security", ["src/a.ts"]), // ordinal 1
      makeResult("c", "correctness", ["src/a.ts"]), // ordinal 2
    ];

    const mem = deriveAccessMemory(results);

    expect(mem.version).toBe(ACCESS_MEMORY_VERSION);
    expect(mem.total_ordinals).toBe(3);
    // Paths are path-sorted, not insertion-ordered.
    expect(mem.paths.map((p) => p.path)).toEqual(["src/a.ts", "src/b.ts"]);

    const a = mem.paths.find((p) => p.path === "src/a.ts");
    expect(a.covered_count).toBe(3); // covered by ordinals 0,1,2
    expect(a.last_ordinal).toBe(2); // most recent covering ordinal
    expect(a.edited_count).toBe(0); // audit-side derive never edits
    expect(a.lenses).toEqual(["correctness", "security"]); // sorted, deduped
    expect(a.symbols).toBeUndefined(); // reserved for the path::symbol increment

    const b = mem.paths.find((p) => p.path === "src/b.ts");
    expect(b.covered_count).toBe(1);
    expect(b.last_ordinal).toBe(0);
    expect(b.lenses).toEqual(["correctness"]);
  });

  test("is deterministic — byte-identical serialization across repeated derivation", () => {
    const results = [
      makeResult("a", "security", ["z/c.ts", "a/x.ts"]),
      makeResult("b", "tests", ["a/x.ts", "m/y.ts"]),
    ];
    const first = JSON.stringify(deriveAccessMemory(results), null, 2);
    const second = JSON.stringify(deriveAccessMemory(results), null, 2);
    expect(first).toBe(second);
    // Paths serialize in sorted order regardless of first-seen order.
    const paths = deriveAccessMemory(results).paths.map((p) => p.path);
    expect(paths).toEqual([...paths].sort());
  });

  test("threads run_id when present on results", () => {
    const results = [makeResult("a", "correctness", ["src/a.ts"], { run_id: "run-7" })];
    expect(deriveAccessMemory(results).run_id).toBe("run-7");
    expect(deriveAccessMemory(results, { runId: "override" }).run_id).toBe("override");
  });

  test("empty ledger yields an empty, schema-valid record", () => {
    const mem = deriveAccessMemory([]);
    expect(mem.paths).toEqual([]);
    expect(mem.total_ordinals).toBe(0);
    expect(mem.run_id).toBeUndefined();
    expect(() => AccessMemorySchema.parse(mem)).not.toThrow();
  });

  test("output validates against the shared AccessMemory schema", () => {
    const results = [
      makeResult("a", "correctness", ["src/a.ts", "src/b.ts"]),
      makeResult("b", "reliability", ["src/b.ts"]),
    ];
    expect(() => AccessMemorySchema.parse(deriveAccessMemory(results))).not.toThrow();
  });

  test("tolerates missing/empty file_coverage without counting phantom paths", () => {
    const results = [
      makeResult("a", "correctness", []),
      { ...makeResult("b", "security", ["src/a.ts"]), file_coverage: undefined },
      makeResult("c", "tests", ["src/a.ts"]),
    ];
    const mem = deriveAccessMemory(results);
    expect(mem.total_ordinals).toBe(3);
    expect(mem.paths.map((p) => p.path)).toEqual(["src/a.ts"]);
    expect(mem.paths[0].covered_count).toBe(1); // only ordinal 2 had the path
    expect(mem.paths[0].last_ordinal).toBe(2);
  });
});
