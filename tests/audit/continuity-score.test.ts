import { test, expect, describe } from "vitest";
import type { AuditTask } from "../../src/audit/types.js";
import type { ReviewPacket } from "../../src/audit/types/reviewPlanning.js";

const { buildReviewPacketPlanningData, orderReviewPackets } = await import(
  "../../src/audit/orchestrator/reviewPackets.js"
);

describe("orderReviewPackets — canonical packet ordering (the single-sourced sort)", () => {
  function packet(
    id: string,
    priority: ReviewPacket["priority"],
    files: string[],
    taskCount = 1,
  ): ReviewPacket {
    return {
      packet_id: id,
      task_ids: Array.from({ length: taskCount }, (_, i) => `${id}-t${i}`),
      unit_ids: [`${id}-unit`],
      pass_ids: [`${id}-pass`],
      lenses: ["correctness"],
      file_paths: files,
      file_line_counts: Object.fromEntries(files.map((f) => [f, 10])),
      total_lines: files.length * 10,
      priority,
      quality: {
        cohesion_score: 1,
        internal_edge_count: 0,
        boundary_edge_count: 0,
        unexplained_file_count: 0,
      },
      rationale: "review",
      estimated_tokens: 100,
    };
  }

  test("canonical component order is stable task identity, independent of priority and continuity", () => {
    const laterHigh = packet("p-z", "high", ["src/cold.ts"]);
    const earlierLow = packet("p-a", "low", ["src/hot.ts"]);
    const scores = new Map([
      ["src/cold.ts", 0.99],
      ["src/hot.ts", 0.01],
    ]);
    expect(orderReviewPackets([laterHigh, earlierLow], scores).map((p) => p.packet_id))
      .toEqual(["p-a", "p-z"]);
  });

  test("optional continuity scores cannot reorder canonical components", () => {
    const a = packet("p-a", "medium", ["src/cold.ts"]);
    const b = packet("p-b", "medium", ["src/hot.ts"]);
    const scores = new Map([
      ["src/hot.ts", 0.9],
      ["src/cold.ts", 0.1],
    ]);
    expect(orderReviewPackets([b, a], scores).map((p) => p.packet_id))
      .toEqual(["p-a", "p-b"]);
  });

  test("task count and input order cannot reorder canonical components", () => {
    const a = packet("p-a", "medium", ["src/a.ts"], 1);
    const b = packet("p-b", "medium", ["src/b.ts"], 3);
    expect(orderReviewPackets([a, b]).map((p) => p.packet_id)).toEqual(["p-a", "p-b"]);
    expect(orderReviewPackets([b, a]).map((p) => p.packet_id)).toEqual(["p-a", "p-b"]);
  });
});

describe("continuity scores do not bias packet ordering", () => {
  function task(unit: string, file: string, lens = "correctness"): AuditTask {
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

  test("review packets keep the same canonical order with or without scores", () => {
    // Two independent single-file packets, same priority, no shared files/edges.
    const tasks = [task("lo", "src/lo.ts"), task("hi", "src/hi.ts")];
    const scores = new Map([
      ["src/hi.ts", 0.9],
      ["src/lo.ts", 0.1],
    ]);

    const biased = buildReviewPacketPlanningData(tasks, { continuityScores: scores }).packets;
    const unbiased = buildReviewPacketPlanningData(tasks, {}).packets;
    expect(biased.map((p) => p.packet_id)).toEqual(unbiased.map((p) => p.packet_id));
    expect(biased.map((p) => p.file_paths)).toEqual(unbiased.map((p) => p.file_paths));
  });

  test("empty continuity scores behave identically to omitting them", () => {
    const tasks = [task("a", "src/a.ts"), task("b", "src/b.ts")];
    const withEmpty = buildReviewPacketPlanningData(tasks, { continuityScores: new Map() }).packets;
    const without = buildReviewPacketPlanningData(tasks, {}).packets;
    expect(withEmpty.map((p) => p.packet_id)).toEqual(without.map((p) => p.packet_id));
  });
});
