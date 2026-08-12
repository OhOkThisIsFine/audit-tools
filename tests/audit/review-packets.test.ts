import { expect, test } from "vitest";

import type { AuditTask } from "../../src/audit/types.js";
import {
  buildAuditPlanMetrics,
  buildReviewPackets,
  orderTasksForPacketReview,
} from "../../src/audit/orchestrator/reviewPackets.js";

function task(
  taskId: string,
  file: string,
  overrides: Partial<AuditTask> = {},
): AuditTask {
  return {
    task_id: taskId,
    unit_id: taskId,
    pass_id: `pass:${taskId}`,
    lens: "correctness",
    file_paths: [file],
    file_line_counts: { [file]: 10 },
    rationale: `Review ${file}.`,
    priority: "medium",
    token_estimate: 100,
    risk_estimate: 0.2,
    ...overrides,
  };
}

test("review packets materialize canonical shared-coherence components", () => {
  const tasks = [
    task("c", "other/c.ts", { lens: "security" }),
    task("b", "src/shared.ts", { lens: "reliability" }),
    task("a", "src/shared.ts", { lens: "security", priority: "high" }),
  ];
  const packets = buildReviewPackets(tasks);

  expect(packets.map((packet) => packet.task_ids)).toEqual([
    ["a", "b"],
    ["c"],
  ]);
  expect(packets[0]).toMatchObject({
    unit_ids: ["a", "b"],
    file_paths: ["src/shared.ts"],
    priority: "high",
  });
});

test("import/call/reference adjacency is a membership signal", () => {
  const tasks = [
    task("a", "src/a.ts", { lens: "security" }),
    task("b", "lib/b.ts", { lens: "reliability" }),
  ];
  const packets = buildReviewPackets(tasks, {
    graphBundle: {
      graphs: {
        imports: [{ from: "src/a.ts", to: "lib/b.ts", kind: "imports" }],
      },
    },
  });
  expect(packets.map((packet) => packet.task_ids)).toEqual([["a", "b"]]);
  expect(packets[0].quality.internal_edge_count).toBe(1);
});

test("directory and lens similarity below threshold does not invent a cluster", () => {
  const packets = buildReviewPackets([
    task("a", "src/a.ts", { lens: "security" }),
    task("b", "src/b.ts", { lens: "security" }),
  ]);
  expect(packets.map((packet) => packet.task_ids)).toEqual([["a"], ["b"]]);
});

test("task order and plan metrics consume the same canonical components", () => {
  const tasks = [
    task("z", "src/z.ts"),
    task("a", "src/shared.ts", { unit_id: "shared" }),
    task("b", "other/b.ts", { unit_id: "shared" }),
  ];
  expect(orderTasksForPacketReview(tasks).map((entry) => entry.task_id)).toEqual([
    "a",
    "b",
    "z",
  ]);
  const metrics = buildAuditPlanMetrics(tasks, {
    generatedAt: new Date("2026-04-22T00:00:00Z"),
  });
  expect(metrics).toMatchObject({
    task_count: 3,
    packet_count: 2,
    estimated_agent_reduction: 1,
  });
});
