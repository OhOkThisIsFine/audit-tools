import { test, expect, describe } from "vitest";
import type { ReviewPacket } from "../../src/audit/types/reviewPlanning.js";

const { orderReviewPackets } = await import(
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

  test("canonical component order is stable task identity, independent of priority", () => {
    const laterHigh = packet("p-z", "high", ["src/cold.ts"]);
    const earlierLow = packet("p-a", "low", ["src/hot.ts"]);
    expect(orderReviewPackets([laterHigh, earlierLow]).map((p) => p.packet_id))
      .toEqual(["p-a", "p-z"]);
  });

  test("task count and input order cannot reorder canonical components", () => {
    const a = packet("p-a", "medium", ["src/a.ts"], 1);
    const b = packet("p-b", "medium", ["src/b.ts"], 3);
    expect(orderReviewPackets([a, b]).map((p) => p.packet_id)).toEqual(["p-a", "p-b"]);
    expect(orderReviewPackets([b, a]).map((p) => p.packet_id)).toEqual(["p-a", "p-b"]);
  });
});
