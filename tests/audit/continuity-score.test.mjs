import { test, expect, describe } from "vitest";

const { computeContinuityScores } = await import(
  "../../src/audit/orchestrator/continuityScore.ts"
);
const { buildReviewPackets, orderReviewPackets } = await import(
  "../../src/audit/orchestrator/reviewPackets.ts"
);

function accessMemory(paths, totalOrdinals) {
  return {
    version: 1,
    total_ordinals: totalOrdinals ?? paths.length,
    paths: paths.map((p) => ({
      path: p.path,
      covered_count: p.covered ?? 1,
      edited_count: p.edited ?? 0,
      last_ordinal: p.last ?? 0,
      lenses: p.lenses ?? ["correctness"],
    })),
  };
}

function graph(imports) {
  return { graphs: { imports: imports.map(([from, to]) => ({ from, to })) } };
}

describe("computeContinuityScores", () => {
  test("no access-memory or empty paths → empty map (no bias)", () => {
    expect(computeContinuityScores(undefined, undefined).size).toBe(0);
    expect(computeContinuityScores(accessMemory([], 0), undefined).size).toBe(0);
  });

  test("seeds covered files; a file with zero frequency contributes nothing", () => {
    const mem = accessMemory([
      { path: "src/a.ts", covered: 2, last: 1 },
      { path: "src/b.ts", covered: 0, edited: 0, last: 0 },
    ], 2);
    const scores = computeContinuityScores(mem, undefined);
    expect(scores.get("src/a.ts")).toBeGreaterThan(0);
    // src/b.ts has zero frequency → never seeded, no edges → absent/zero.
    expect(scores.get("src/b.ts") ?? 0).toBe(0);
  });

  test("recency: a more recently covered file outscores an older one (same frequency)", () => {
    const mem = accessMemory([
      { path: "src/old.ts", covered: 1, last: 0 },
      { path: "src/new.ts", covered: 1, last: 4 },
    ], 5);
    const scores = computeContinuityScores(mem, undefined);
    expect(scores.get("src/new.ts")).toBeGreaterThan(scores.get("src/old.ts"));
  });

  test("frequency: more coverage → higher score (same recency)", () => {
    const mem = accessMemory([
      { path: "src/hot.ts", covered: 5, last: 0 },
      { path: "src/cold.ts", covered: 1, last: 0 },
    ], 1);
    const scores = computeContinuityScores(mem, undefined);
    expect(scores.get("src/hot.ts")).toBeGreaterThan(scores.get("src/cold.ts"));
  });

  test("edited is weighted above covered", () => {
    const mem = accessMemory([
      { path: "src/edited.ts", covered: 0, edited: 1, last: 0 },
      { path: "src/read.ts", covered: 1, edited: 0, last: 0 },
    ], 1);
    const scores = computeContinuityScores(mem, undefined);
    expect(scores.get("src/edited.ts")).toBeGreaterThan(scores.get("src/read.ts"));
  });

  test("graph propagation: an unseeded structural neighbour of a touched file gets nonzero score", () => {
    const mem = accessMemory([{ path: "src/a.ts", covered: 3, last: 0 }], 1);
    const g = graph([["src/a.ts", "src/b.ts"]]); // b never touched
    const scores = computeContinuityScores(mem, g);
    expect(scores.get("src/b.ts") ?? 0).toBeGreaterThan(0);
    // The seeded, directly-touched file still outranks its propagated neighbour.
    expect(scores.get("src/a.ts")).toBeGreaterThan(scores.get("src/b.ts"));
  });

  test("deterministic — identical output across repeated derivation", () => {
    const mem = accessMemory([
      { path: "z/c.ts", covered: 2, last: 3 },
      { path: "a/x.ts", covered: 1, edited: 1, last: 5 },
    ], 6);
    const g = graph([["a/x.ts", "z/c.ts"], ["z/c.ts", "m/y.ts"]]);
    const first = [...computeContinuityScores(mem, g).entries()].sort();
    const second = [...computeContinuityScores(mem, g).entries()].sort();
    expect(first).toEqual(second);
  });

  test("no NaN when every seeded record is recency-underflowed to zero", () => {
    // A path last touched ~7000+ step-ordinals ago underflows 0.9^stepsAgo to 0,
    // so seedTotal is 0 → must degrade to an empty map, never NaN-poison scores.
    const mem = accessMemory([{ path: "src/a.ts", covered: 1, last: 0 }], 100000);
    const scores = computeContinuityScores(mem, undefined);
    for (const value of scores.values()) expect(Number.isNaN(value)).toBe(false);
  });
});

describe("orderReviewPackets — canonical packet ordering (the single-sourced sort)", () => {
  function packet(id, priority, files, taskCount = 1) {
    return {
      packet_id: id,
      task_ids: Array.from({ length: taskCount }, (_, i) => `${id}-t${i}`),
      lenses: ["correctness"],
      file_paths: files,
      file_line_counts: Object.fromEntries(files.map((f) => [f, 10])),
      total_lines: files.length * 10,
      priority,
      estimated_tokens: 100,
    };
  }

  test("priority always dominates continuity — a high-continuity LOW packet never precedes a low-continuity HIGH packet", () => {
    const high = packet("p-high", "high", ["src/cold.ts"]);
    const low = packet("p-low", "low", ["src/hot.ts"]);
    const scores = new Map([
      ["src/hot.ts", 0.99],
      ["src/cold.ts", 0.01],
    ]);
    const ordered = orderReviewPackets([low, high], scores);
    expect(ordered[0].packet_id).toBe("p-high");
  });

  test("within a priority tier, higher continuity sorts first", () => {
    const a = packet("p-a", "medium", ["src/cold.ts"]);
    const b = packet("p-b", "medium", ["src/hot.ts"]);
    const scores = new Map([
      ["src/hot.ts", 0.9],
      ["src/cold.ts", 0.1],
    ]);
    const ordered = orderReviewPackets([a, b], scores);
    expect(ordered[0].packet_id).toBe("p-b");
  });

  test("no scores → priority → size → id, and reordering the input is idempotent", () => {
    const a = packet("p-a", "medium", ["src/a.ts"], 1);
    const b = packet("p-b", "medium", ["src/b.ts"], 3); // more tasks → sorts first on size
    expect(orderReviewPackets([a, b]).map((p) => p.packet_id)).toEqual(["p-b", "p-a"]);
    expect(orderReviewPackets([b, a]).map((p) => p.packet_id)).toEqual(["p-b", "p-a"]);
  });
});

describe("continuity bias in packet ordering", () => {
  function task(unit, file, lens = "correctness") {
    return {
      task_id: `task-${unit}`,
      unit_id: `unit-${unit}`,
      pass_id: `pass:${lens}`,
      lens,
      file_paths: [file],
      file_line_counts: { [file]: 50 },
      rationale: "review",
      priority: "medium",
      tags: [],
    };
  }

  test("higher-continuity packet sorts first within a priority tier; no scores → unbiased", () => {
    // Two independent single-file packets, same priority, no shared files/edges.
    const tasks = [task("lo", "src/lo.ts"), task("hi", "src/hi.ts")];
    const scores = new Map([
      ["src/hi.ts", 0.9],
      ["src/lo.ts", 0.1],
    ]);

    const biased = buildReviewPackets(tasks, { continuityScores: scores });
    expect(biased[0].file_paths).toContain("src/hi.ts");

    // Without scores the order falls back to the size/id tiebreak (deterministic),
    // and must NOT be influenced by continuity.
    const unbiased = buildReviewPackets(tasks, {});
    const unbiasedFirst = unbiased[0].file_paths[0];
    // Tiebreak is packet_id.localeCompare — independent of the score map.
    expect(["src/hi.ts", "src/lo.ts"]).toContain(unbiasedFirst);
    // The biased ordering put hi first; assert the bias actually changed nothing
    // about composition (same set of packets, just ordered differently).
    expect(new Set(biased.flatMap((p) => p.file_paths))).toEqual(
      new Set(unbiased.flatMap((p) => p.file_paths)),
    );
  });

  test("empty continuity scores behave identically to omitting them", () => {
    const tasks = [task("a", "src/a.ts"), task("b", "src/b.ts")];
    const withEmpty = buildReviewPackets(tasks, { continuityScores: new Map() });
    const without = buildReviewPackets(tasks, {});
    expect(withEmpty.map((p) => p.packet_id)).toEqual(without.map((p) => p.packet_id));
  });
});
