import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMatchesJsonSchema } from "./helpers/auditSchemaRegistry.mjs";

const { buildTaskAffinityGraph } = await import(
  "../src/orchestrator/taskAffinityGraph.ts"
);

const here = dirname(fileURLToPath(import.meta.url));
async function loadSchema(name) {
  return JSON.parse(await readFile(join(here, "..", "schemas", name), "utf8"));
}

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
  assert.equal(graph.nodes.length, 4);
  const n1 = graph.nodes.find((n) => n.task_id === "t1");
  assert.equal(n1.token_estimate, 100);
  assert.equal(n1.risk_estimate, 0.8);
});

test("same file + different lens yields a cross_lens_same_file edge (dominant)", () => {
  const graph = buildTaskAffinityGraph(TASKS);
  const e = edgeBetween(graph, "t1", "t2");
  assert.ok(e, "expected an edge between t1 and t2");
  assert.equal(e.kind, "cross_lens_same_file");
  assert.equal(e.weight, 0.85); // different lens → no same_lens bonus
  // contributing kinds are recorded for transparency
  assert.ok(e.reason.includes("same_unit"));
  assert.ok(e.reason.includes("same_flow"));
});

test("same directory + same lens yields a same_dir edge with the lens bonus", () => {
  const graph = buildTaskAffinityGraph(TASKS);
  const e = edgeBetween(graph, "t1", "t3"); // both dir "", both security
  assert.ok(e, "expected an edge between t1 and t3");
  assert.equal(e.kind, "same_dir");
  assert.equal(e.weight, 0.4); // 0.35 + 0.05 same_lens bonus
  assert.ok(e.reason.includes("same_lens"));
});

test("a task with no shared file/unit/dir/flow has no edges", () => {
  const graph = buildTaskAffinityGraph(TASKS);
  const touchingT4 = graph.edges.filter(
    (e) => e.from === "t4" || e.to === "t4",
  );
  assert.equal(touchingT4.length, 0);
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
  assert.ok(e, "expected a call_adjacent edge from the import edge");
  assert.equal(e.kind, "call_adjacent");
});

test("graph validates against task_affinity_graph.schema.json", async () => {
  const schema = await loadSchema("task_affinity_graph.schema.json");
  const graph = buildTaskAffinityGraph(TASKS);
  assertMatchesJsonSchema(schema, graph, "task_affinity_graph");
});
