import { expect, test } from "vitest";

import {
  buildTaskCoherencePartition,
} from "../../src/audit/orchestrator/partitionTaskGraph.js";
import type { TaskAffinityGraph } from "../../src/audit/orchestrator/taskAffinityGraph.js";

const GRAPH: TaskAffinityGraph = {
  schema_version: "task-affinity-graph/v1",
  nodes: [
    {
      task_id: "c",
      unit_id: "u2",
      lens: "security",
      file_paths: ["src/c.ts"],
      token_estimate: 30,
      risk_estimate: 0.3,
    },
    {
      task_id: "a",
      unit_id: "u1",
      lens: "security",
      file_paths: ["src/a.ts"],
      token_estimate: 10,
      risk_estimate: 0.1,
    },
    {
      task_id: "b",
      unit_id: "u1",
      lens: "reliability",
      file_paths: ["src/b.ts"],
      token_estimate: 20,
      risk_estimate: 0.2,
    },
  ],
  edges: [
    {
      from: "a",
      to: "b",
      kind: "same_unit",
      weight: 0.001,
      reason: "same_unit,same_dir",
    },
  ],
};

test("task partition projects canonical coherence components", () => {
  const result = buildTaskCoherencePartition(GRAPH);
  expect(result.coherence_trace.components).toEqual([["a", "b"], ["c"]]);
  expect(result.packets.map((packet) => packet.task_ids)).toEqual([
    ["a", "b"],
    ["c"],
  ]);
  expect(result.packets[0]).toMatchObject({
    packet_id: "packet-1",
    token_estimate: 30,
    risk_mass: 0.3,
    risk_score: 0.2,
  });
});

test("numeric weights and extra runtime arguments cannot change membership", () => {
  const changedWeight: TaskAffinityGraph = {
    ...GRAPH,
    edges: GRAPH.edges.map((edge) => ({ ...edge, weight: 1 })),
  };
  expect(buildTaskCoherencePartition(changedWeight, { arbitrary: "runtime metadata" })).toEqual(
    buildTaskCoherencePartition(GRAPH),
  );
});

test("permuted graph arrays yield byte-stable projected packets", () => {
  const reversed: TaskAffinityGraph = {
    ...GRAPH,
    nodes: [...GRAPH.nodes].reverse().map((node) => ({
      ...node,
      file_paths: [...node.file_paths].reverse(),
    })),
    edges: [...GRAPH.edges].reverse(),
  };
  expect(JSON.stringify(buildTaskCoherencePartition(reversed))).toBe(
    JSON.stringify(buildTaskCoherencePartition(GRAPH)),
  );
});
