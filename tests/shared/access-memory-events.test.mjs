import { test, expect, describe } from "vitest";

const { deriveAccessMemoryFromEvents, AccessMemorySchema } = await import(
  "../../src/shared/index.ts"
);

function ev(path, edited, ordinal, lens) {
  return { path, edited, ordinal, ...(lens ? { lens } : {}) };
}

describe("deriveAccessMemoryFromEvents (shared core)", () => {
  test("splits covered vs edited counts and takes max ordinal as recency", () => {
    const mem = deriveAccessMemoryFromEvents(
      [
        ev("src/a.ts", false, 0, "correctness"),
        ev("src/a.ts", true, 2), // an edit at a later ordinal
        ev("src/a.ts", false, 1, "security"),
        ev("src/b.ts", true, 3),
      ],
      { totalOrdinals: 4 },
    );
    const a = mem.paths.find((p) => p.path === "src/a.ts");
    expect(a.covered_count).toBe(2);
    expect(a.edited_count).toBe(1);
    expect(a.last_ordinal).toBe(2); // max across all a-touches, not last-seen
    expect(a.lenses).toEqual(["correctness", "security"]);

    const b = mem.paths.find((p) => p.path === "src/b.ts");
    expect(b.covered_count).toBe(0);
    expect(b.edited_count).toBe(1);
    expect(b.last_ordinal).toBe(3);
  });

  test("path-sorted output; deterministic regardless of event order", () => {
    const events = [
      ev("z/c.ts", true, 1),
      ev("a/x.ts", false, 0, "tests"),
      ev("m/y.ts", true, 2),
    ];
    const forward = deriveAccessMemoryFromEvents(events, { totalOrdinals: 3 });
    const reversed = deriveAccessMemoryFromEvents([...events].reverse(), { totalOrdinals: 3 });
    expect(forward.paths.map((p) => p.path)).toEqual(["a/x.ts", "m/y.ts", "z/c.ts"]);
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reversed));
  });

  test("ignores empty paths; empty stream → empty schema-valid record", () => {
    const mem = deriveAccessMemoryFromEvents(
      [ev("", false, 0), ev("src/a.ts", true, 0)],
      { totalOrdinals: 1, runId: "run-9" },
    );
    expect(mem.paths.map((p) => p.path)).toEqual(["src/a.ts"]);
    expect(mem.run_id).toBe("run-9");
    expect(() => AccessMemorySchema.parse(mem)).not.toThrow();

    const empty = deriveAccessMemoryFromEvents([], { totalOrdinals: 0 });
    expect(empty.paths).toEqual([]);
    expect(empty.run_id).toBeUndefined();
    expect(() => AccessMemorySchema.parse(empty)).not.toThrow();
  });
});
