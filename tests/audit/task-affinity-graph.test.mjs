import { test, expect } from "vitest";

const { buildTaskAffinityGraph, TaskAffinityGraphSchema } = await import("../../src/audit/orchestrator/taskAffinityGraph.ts");

const task = (over) => ({
  task_id: "t",
  unit_id: "u",
  pass_id: "p",
  lens: "correctness",
  file_paths: ["a.ts"],
  rationale: "r",
  token_estimate: 100,
  risk_estimate: 0.4,
  ...over,
});

const TASKS = [
  task({
    task_id: "t1",
    unit_id: "u1",
    lens: "security",
    file_paths: ["a.ts"],
    tags: ["critical_flow:f1"],
    token_estimate: 100,
    risk_estimate: 0.8,
  }),
  task({
    task_id: "t2",
    unit_id: "u1",
    lens: "correctness",
    file_paths: ["a.ts"],
    tags: ["critical_flow:f1"],
    token_estimate: 100,
    risk_estimate: 0.7,
  }),
  task({
    task_id: "t3",
    unit_id: "u2",
    lens: "security",
    file_paths: ["b.ts"],
    token_estimate: 50,
    risk_estimate: 0.6,
  }),
  task({
    task_id: "t4",
    unit_id: "u3",
    lens: "tests",
    file_paths: ["sub/c.ts"],
    token_estimate: 30,
    risk_estimate: 0.15,
  }),
];

function edgeBetween(graph, a, b) {
  const [from, to] = a < b ? [a, b] : [b, a];
  return graph.edges.find((e) => e.from === from && e.to === to);
}

test("buildTaskAffinityGraph carries frozen estimates onto nodes", () => {
  const graph = buildTaskAffinityGraph(TASKS);
  expect(graph.nodes.length).toBe(4);
  const n1 = graph.nodes.find((n) => n.task_id === "t1");
  expect(n1.token_estimate).toBe(100);
  expect(n1.risk_estimate).toBe(0.8);
});

test("same file + different lens yields a cross_lens_same_file edge (dominant)", () => {
  const graph = buildTaskAffinityGraph(TASKS);
  const e = edgeBetween(graph, "t1", "t2");
  expect(e, "expected an edge between t1 and t2").toBeTruthy();
  expect(e.kind).toBe("cross_lens_same_file");
  expect(e.weight).toBe(0.85); // different lens → no same_lens bonus
  // contributing kinds are recorded for transparency
  expect(e.reason.includes("same_unit")).toBeTruthy();
  expect(e.reason.includes("same_flow")).toBeTruthy();
});

test("same directory + same lens yields a same_dir edge with the lens bonus", () => {
  const graph = buildTaskAffinityGraph(TASKS);
  const e = edgeBetween(graph, "t1", "t3"); // both dir "", both security
  expect(e, "expected an edge between t1 and t3").toBeTruthy();
  expect(e.kind).toBe("same_dir");
  expect(e.weight).toBe(0.4); // 0.35 + 0.05 same_lens bonus
  expect(e.reason.includes("same_lens")).toBeTruthy();
});

test("a task with no shared file/unit/dir/flow has no edges", () => {
  const graph = buildTaskAffinityGraph(TASKS);
  const touchingT4 = graph.edges.filter(
    (e) => e.from === "t4" || e.to === "t4",
  );
  expect(touchingT4.length).toBe(0);
});

test("call_adjacent edges derive from the graph bundle (best-effort, path endpoints)", () => {
  const graph = buildTaskAffinityGraph(
    [
      task({ task_id: "x1", unit_id: "ux", file_paths: ["dirx/one.ts"] }),
      task({ task_id: "x2", unit_id: "uy", file_paths: ["diry/two.ts"] }),
    ],
    {
      graphBundle: {
        graphs: {
          imports: [{ from: "dirx/one.ts", to: "diry/two.ts" }],
        },
      },
    },
  );
  const e = edgeBetween(graph, "x1", "x2");
  expect(e, "expected a call_adjacent edge from the import edge").toBeTruthy();
  expect(e.kind).toBe("call_adjacent");
});

// TST-3ba2ef76: overlapping but not identical file sets — partial overlap must produce
// a cross_lens_same_file edge when the tasks share at least one file.
test("tasks with overlapping but not identical file sets get a cross_lens_same_file edge for the shared file", () => {
  // t-x has [a.ts, b.ts]; t-y has [b.ts, c.ts] — they share b.ts only.
  const overlap = buildTaskAffinityGraph([
    task({ task_id: "t-x", unit_id: "ux", lens: "security", file_paths: ["a.ts", "b.ts"] }),
    task({ task_id: "t-y", unit_id: "uy", lens: "correctness", file_paths: ["b.ts", "c.ts"] }),
  ]);
  const e = edgeBetween(overlap, "t-x", "t-y");
  expect(e, "expected an edge between tasks sharing one file").toBeTruthy();
  expect(e.kind, "shared file with different lens → cross_lens_same_file").toBe("cross_lens_same_file");
});

test("tasks with fully disjoint file sets and different units/dirs have no affinity edge", () => {
  const disjoint = buildTaskAffinityGraph([
    task({ task_id: "t-p", unit_id: "up", lens: "security", file_paths: ["dirA/x.ts"] }),
    task({ task_id: "t-q", unit_id: "uq", lens: "security", file_paths: ["dirB/y.ts"] }),
  ]);
  const e = edgeBetween(disjoint, "t-p", "t-q");
  expect(e, "fully disjoint tasks with different dirs must have no edge").toBe(undefined);
});

test("graph validates against TaskAffinityGraphSchema", () => {
  const graph = buildTaskAffinityGraph(TASKS);
  const result = TaskAffinityGraphSchema.safeParse(graph);
  expect(result.success, `task affinity graph should satisfy schema: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`).toBeTruthy();
});
