import test from "node:test";
import assert from "node:assert/strict";

const { partitionTaskGraph } = await import(
  "../src/orchestrator/partitionTaskGraph.ts"
);
const { buildTaskAffinityGraph } = await import(
  "../src/orchestrator/taskAffinityGraph.ts"
);

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

// Three tasks all sharing one unit + file (strongly coupled).
const COUPLED = buildTaskAffinityGraph([
  task({ task_id: "t1", unit_id: "u1", lens: "security", file_paths: ["a.ts"], token_estimate: 100, risk_estimate: 0.3 }),
  task({ task_id: "t2", unit_id: "u1", lens: "correctness", file_paths: ["a.ts"], token_estimate: 100, risk_estimate: 0.3 }),
  task({ task_id: "t3", unit_id: "u1", lens: "reliability", file_paths: ["a.ts"], token_estimate: 100, risk_estimate: 0.3 }),
]);

test("a generous token+risk budget merges coupled tasks into one packet", () => {
  const packets = partitionTaskGraph(COUPLED, {
    contextTokenBudget: 100000,
    riskMassBudget: 100,
  });
  assert.equal(packets.length, 1);
  assert.deepEqual(packets[0].task_ids, ["t1", "t2", "t3"]);
  assert.equal(packets[0].token_estimate, 300);
  assert.ok(Math.abs(packets[0].risk_mass - 0.9) < 1e-9);
  assert.ok(Math.abs(packets[0].routing_risk - 0.3) < 1e-9);
});

test("a token ceiling caps packet size (ceiling, not quota)", () => {
  // budget fits 2 tasks (200) but not 3 (300).
  const packets = partitionTaskGraph(COUPLED, {
    contextTokenBudget: 250,
    riskMassBudget: 100,
  });
  // one packet of 2, one of 1 (no atomic task is split)
  assert.equal(packets.length, 2);
  assert.ok(packets.every((p) => p.token_estimate <= 250));
});

test("a risk-mass ceiling caps aggregate risk per packet", () => {
  // risk budget allows 2 tasks (0.6) but not 3 (0.9), even though tokens fit.
  const packets = partitionTaskGraph(COUPLED, {
    contextTokenBudget: 100000,
    riskMassBudget: 0.65,
  });
  assert.equal(packets.length, 2);
  assert.ok(packets.every((p) => p.risk_mass <= 0.65 + 1e-9));
});

test("an atomic task exceeding the token ceiling becomes its own over_budget packet", () => {
  const graph = buildTaskAffinityGraph([
    task({ task_id: "big", token_estimate: 999999, risk_estimate: 0.9 }),
  ]);
  const packets = partitionTaskGraph(graph, {
    contextTokenBudget: 1000,
    riskMassBudget: 100,
  });
  assert.equal(packets.length, 1);
  assert.equal(packets[0].over_budget, true);
});

test("routing_risk is the max member risk; packets sort highest-risk first", () => {
  const graph = buildTaskAffinityGraph([
    task({ task_id: "lowrisk", unit_id: "ua", file_paths: ["x/a.ts"], risk_estimate: 0.1 }),
    task({ task_id: "hirisk", unit_id: "ub", file_paths: ["y/b.ts"], risk_estimate: 0.9 }),
  ]);
  // disjoint → two packets
  const packets = partitionTaskGraph(graph, {
    contextTokenBudget: 100000,
    riskMassBudget: 100,
  });
  assert.equal(packets.length, 2);
  assert.equal(packets[0].task_ids[0], "hirisk"); // highest routing risk first
  assert.equal(packets[0].routing_risk, 0.9);
});

test("partition is deterministic for the same graph + budgets", () => {
  const opts = { contextTokenBudget: 250, riskMassBudget: 100 };
  const a = partitionTaskGraph(COUPLED, opts);
  const b = partitionTaskGraph(COUPLED, opts);
  assert.deepEqual(a, b);
});
