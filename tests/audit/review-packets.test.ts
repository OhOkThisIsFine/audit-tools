import { expect, test } from "vitest";

import type { AuditTask } from "../../src/audit/types.js";
import {
  buildAuditPlanMetrics,
  buildPacket,
  buildReviewPacketPlanningData,
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
  const packets = buildReviewPacketPlanningData(tasks).packets;

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
  const packets = buildReviewPacketPlanningData(tasks, {
    graphBundle: {
      graphs: {
        imports: [{ from: "src/a.ts", to: "lib/b.ts", kind: "imports" }],
      },
    },
  }).packets;
  expect(packets.map((packet) => packet.task_ids)).toEqual([["a", "b"]]);
  expect(packets[0].quality.internal_edge_count).toBe(1);
});

test("directory and lens similarity below threshold does not invent a cluster", () => {
  const packets = buildReviewPacketPlanningData([
    task("a", "src/a.ts", { lens: "security" }),
    task("b", "src/b.ts", { lens: "security" }),
  ]).packets;
  expect(packets.map((packet) => packet.task_ids)).toEqual([["a"], ["b"]]);
});

test("task order and plan metrics consume the same canonical components", () => {
  const tasks = [
    task("z", "src/z.ts"),
    task("a", "src/shared.ts", { unit_id: "shared" }),
    task("b", "other/b.ts", { unit_id: "shared" }),
  ];
  // Packet order is the review order: the packetization walks tasks in the
  // canonical component order the metrics projection also consumes.
  expect(
    buildReviewPacketPlanningData(tasks).packets.flatMap((packet) => packet.task_ids),
  ).toEqual(["a", "b", "z"]);
  const metrics = buildAuditPlanMetrics(tasks, {
    generatedAt: new Date("2026-04-22T00:00:00Z"),
  });
  expect(metrics).toMatchObject({
    task_count: 3,
    packet_count: 2,
    estimated_agent_reduction: 1,
  });
});

// Counts the underlying membership work, not time or calls to Array.includes.
for (const [name, memberships] of [
  ["one wide task", [Array.from({ length: 64 }, (_, i) => `p${i}`)]],
  ["many single-file tasks", Array.from({ length: 64 }, (_, i) => [`p${i}`])],
  ["overlapping duplicate memberships", Array.from({ length: 16 }, (_, i) => ["shared", "shared", `p${i}`])],
] as const) {
  test(`buildPacket indexes first owners with bounded membership work: ${name}`, () => {
    let reads = 0;
    const tasks = memberships.map((paths, i) => task(`t${i}`, "unused", {
      file_paths: new Proxy([...paths], {
        get(target, property, receiver) {
          if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
          return Reflect.get(target, property, receiver);
        },
      }),
    }));
    const allPaths = memberships.flat();
    const bound = 8 * allPaths.length + 4 * new Set(allPaths).size;
    reads = 0;
    buildPacket(tasks, 0);
    const packetReads = reads;
    expect(packetReads).toBeLessThanOrEqual(bound);
  });
}

function packetFixtureTask(id: string, files: string[], overrides: Partial<AuditTask> = {}): AuditTask {
  return task(id, "unused", { file_paths: files, file_line_counts: {}, rationale: "review", ...overrides });
}

test("buildPacket preserves the entire canonical packet and its serialized field order", () => {
  const tasks = [
    packetFixtureTask("b", ["shared", "zero", "src/a.ts", "./src/a.ts", "src\\a.ts", "Src/a.ts"], {
      unit_id: "other", lens: "security", priority: "high", tags: ["z", "a"],
      file_line_counts: { shared: 99, zero: 99, "src/a.ts": 3, "./src/a.ts": 4, "src\\a.ts": 5, "Src/a.ts": 6 },
    }),
    packetFixtureTask("a", ["shared", "zero", "shared", "one", "five"], {
      unit_id: "unit / A", tags: ["a"], file_line_counts: { zero: 0, one: 9, five: 10 },
    }),
  ];
  const materialize = (input: AuditTask[]) => buildPacket(input, 2,
    { shared: 7, zero: 100 }, { shared: 0, one: 1, five: 5 },
    [{ from: "one", to: "five", kind: "imports", confidence: 0.9, reason: "fixture" },
      { from: "one", to: "outside", kind: "imports" }],
    { graphs: { routes: [{ method: "GET", path: "/one", handler: "one" }] } },
  );
  // Captured from the pinned pre-index implementation.
  const serialized = "{\"packet_id\":\"unit-A:security-correctness:packet-3-59b271ae1b\",\"task_ids\":[\"a\",\"b\"],\"unit_ids\":[\"other\",\"unit / A\"],\"pass_ids\":[\"pass:a\",\"pass:b\"],\"lenses\":[\"security\",\"correctness\"],\"file_paths\":[\"./src/a.ts\",\"Src/a.ts\",\"five\",\"one\",\"shared\",\"src/a.ts\",\"src\\\\a.ts\",\"zero\"],\"file_line_counts\":{\"./src/a.ts\":4,\"Src/a.ts\":6,\"five\":10,\"one\":9,\"shared\":7,\"src/a.ts\":3,\"src\\\\a.ts\":5,\"zero\":0},\"total_lines\":44,\"priority\":\"high\",\"tags\":[\"a\",\"z\"],\"entrypoints\":[\"GET /one -> one\"],\"key_edges\":[{\"from\":\"one\",\"to\":\"five\",\"confidence\":0.9,\"kind\":\"imports\",\"reason\":\"fixture\"}],\"boundary_files\":[\"outside\"],\"quality\":{\"cohesion_score\":0.143,\"internal_edge_count\":1,\"boundary_edge_count\":1,\"unexplained_file_count\":6},\"rationale\":\"Review 8 related file(s) across 2 lens(es): security, correctness. Key graph edges explain 1 internal relationship(s).\",\"estimated_tokens\":1003}";
  const expected = JSON.parse(serialized);
  for (const input of [tasks, [...tasks].reverse()]) {
    expect(materialize(input)).toStrictEqual(expected);
    expect(JSON.stringify(materialize(input))).toBe(serialized);
  }
});

test("buildPacket preserves boundary-only and empty-scope serialization and omissions", () => {
  {
    const serialized = "{\"packet_id\":\"boundary:correctness:packet-1-931534c0c1\",\"task_ids\":[\"boundary\"],\"unit_ids\":[\"boundary\"],\"pass_ids\":[\"pass:boundary\"],\"lenses\":[\"correctness\"],\"file_paths\":[\"p\"],\"file_line_counts\":{\"p\":0},\"total_lines\":0,\"priority\":\"medium\",\"boundary_files\":[\"outside\"],\"quality\":{\"cohesion_score\":1,\"internal_edge_count\":0,\"boundary_edge_count\":1,\"unexplained_file_count\":0},\"rationale\":\"review Boundary context is available for 1 adjacent file(s).\",\"estimated_tokens\":900}";
    const packet = buildPacket([packetFixtureTask("boundary", ["p"])], 0, undefined, undefined, [{ from: "p", to: "outside", kind: "imports" }]);
    expect(packet).toStrictEqual({ ...JSON.parse(serialized), tags: undefined, entrypoints: undefined, key_edges: undefined });
    expect(JSON.stringify(packet)).toBe(serialized);
  }
  {
    const serialized = "{\"packet_id\":\"empty:correctness:packet-1-2e1cfa82b0\",\"task_ids\":[\"empty\"],\"unit_ids\":[\"empty\"],\"pass_ids\":[\"pass:empty\"],\"lenses\":[\"correctness\"],\"file_paths\":[],\"file_line_counts\":{},\"total_lines\":0,\"priority\":\"medium\",\"quality\":{\"cohesion_score\":1,\"internal_edge_count\":0,\"boundary_edge_count\":0,\"unexplained_file_count\":0},\"rationale\":\"review\",\"estimated_tokens\":900}";
    const packet = buildPacket([packetFixtureTask("empty", [])], 0);
    expect(packet).toStrictEqual({ ...JSON.parse(serialized), tags: undefined, entrypoints: undefined, key_edges: undefined, boundary_files: undefined });
    expect(JSON.stringify(packet)).toBe(serialized);
  }
  expect(() => buildPacket([], 0)).toThrow("Cannot materialize an empty review-packet component.");
  expect(buildReviewPacketPlanningData([]).packets).toEqual([]);
});

test("equal task IDs keep incoming owner order and first-owner missing counts never borrow later counts", () => {
  const missing = packetFixtureTask("same", ["p"]);
  const present = packetFixtureTask("same", ["p"], { file_line_counts: { p: 11 } });
  expect(buildPacket([missing, present], 0).file_line_counts).toEqual({ p: 0 });
  expect(buildPacket([missing, present], 0, { p: 3 }).estimated_tokens).toBe(912);
  expect(buildPacket([present, missing], 0, { p: 3 }).estimated_tokens).toBe(944);
  const zero = packetFixtureTask("same", ["p"], { file_line_counts: { p: 0 } });
  expect(buildPacket([zero, present], 0, { p: 3 }).estimated_tokens).toBe(900);
});

test("packet graph context is rebuilt from current inputs on every planning call", () => {
  const tasks = [task("a", "src/a.ts")];
  const graphBundle = {
    graphs: {
      imports: [{ from: "src/a.ts", to: "outside.ts", kind: "imports" }],
      routes: [{ handler: "src/a.ts", path: "/before", method: "GET" }],
    },
  };
  const before = buildReviewPacketPlanningData(tasks, { graphBundle });
  graphBundle.graphs.imports[0]!.to = "new-outside.ts";
  graphBundle.graphs.routes[0]!.path = "/after";
  const after = buildReviewPacketPlanningData(tasks, { graphBundle });
  expect(before.packets[0]!.entrypoints).toEqual(["GET /before -> src/a.ts"]);
  expect(after.packets[0]!.entrypoints).toEqual(["GET /after -> src/a.ts"]);
  expect(before.packets[0]!.boundary_files).toEqual(["outside.ts"]);
  expect(after.packets[0]!.boundary_files).toEqual(["new-outside.ts"]);
  expect(after.packets[0]).toMatchObject(buildPacket(tasks, 0, undefined, undefined, after.graphEdges, graphBundle));
});

test("sparse packet planning visits source routes once per call", () => {
  const tasks = Array.from({ length: 500 }, (_, i) => task(`task-${i}`, `p${i}/file.ts`));
  let routeReads = 0;
  const routes = new Proxy(tasks.map(item => ({ handler: item.file_paths[0]!, path: "/route" })), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)) routeReads += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  const planning = buildReviewPacketPlanningData(tasks, { graphBundle: { graphs: { routes } } });
  expect(planning.packets).toHaveLength(500);
  expect(routeReads).toBe(500);
});
