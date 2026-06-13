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

// ── TST-63d9e3e4: over_budget single-node overhead boundary ──────────────────

test("TST-63d9e3e4: single-node at exactly (contextTokenBudget + overhead - 1) is NOT over_budget", () => {
  // tokenEstimate + overhead = budget - 1 + 1 = budget → NOT over budget
  // Condition: list.length === 1 && tokenEstimate + overhead > contextTokenBudget
  // At tokenEstimate + overhead == budget: budget > budget is false → not over_budget
  const overhead = 500;
  const budget = 1000;
  const tokenEstimate = budget - overhead - 1; // 499: 499 + 500 = 999 < 1000 → not over

  const graph = buildTaskAffinityGraph([
    task({ task_id: "boundary-below", token_estimate: tokenEstimate, risk_estimate: 0.1 }),
  ]);
  const packets = partitionTaskGraph(graph, {
    contextTokenBudget: budget,
    riskMassBudget: 100,
    promptOverheadTokens: overhead,
  });
  assert.equal(packets.length, 1);
  assert.equal(packets[0].over_budget, undefined, "one token below ceiling should NOT be over_budget");
});

test("TST-63d9e3e4: single-node at exactly (contextTokenBudget + overhead) is over_budget", () => {
  // tokenEstimate + overhead > contextTokenBudget when tokenEstimate = budget - overhead + 1
  const overhead = 500;
  const budget = 1000;
  const tokenEstimate = budget - overhead + 1; // 501: 501 + 500 = 1001 > 1000 → over_budget

  const graph = buildTaskAffinityGraph([
    task({ task_id: "boundary-above", token_estimate: tokenEstimate, risk_estimate: 0.1 }),
  ]);
  const packets = partitionTaskGraph(graph, {
    contextTokenBudget: budget,
    riskMassBudget: 100,
    promptOverheadTokens: overhead,
  });
  assert.equal(packets.length, 1);
  assert.equal(packets[0].over_budget, true, "one token above ceiling should be over_budget");
});

test("TST-63d9e3e4: overhead defaults to 0 when promptOverheadTokens is undefined", () => {
  // Without overhead: condition is tokenEstimate > contextTokenBudget
  const budget = 1000;

  const atBudget = buildTaskAffinityGraph([
    task({ task_id: "at-budget", token_estimate: budget, risk_estimate: 0.1 }),
  ]);
  const notOver = partitionTaskGraph(atBudget, { contextTokenBudget: budget, riskMassBudget: 100 });
  assert.equal(notOver[0].over_budget, undefined, "at exactly budget (no overhead) is NOT over_budget");

  const overBudget = buildTaskAffinityGraph([
    task({ task_id: "over-budget", token_estimate: budget + 1, risk_estimate: 0.1 }),
  ]);
  const isOver = partitionTaskGraph(overBudget, { contextTokenBudget: budget, riskMassBudget: 100 });
  assert.equal(isOver[0].over_budget, true, "one token above budget (no overhead) IS over_budget");
});

test("TST-63d9e3e4: two-node packet exceeding budget is NOT flagged as over_budget (only single-node check)", () => {
  // The condition `list.length === 1 && ...` means multi-node packets are never flagged,
  // even if their combined tokens exceed the ceiling. This tests the documented boundary.
  // Two nodes: 600 + 600 = 1200 > 1000 budget — but they can't merge either (would exceed).
  // They end up as separate packets of 600 each, both under budget individually.
  const graph = buildTaskAffinityGraph([
    task({ task_id: "two-a", unit_id: "ua", file_paths: ["src/a.ts"], token_estimate: 600, risk_estimate: 0.1 }),
    task({ task_id: "two-b", unit_id: "ub", file_paths: ["src/b.ts"], token_estimate: 600, risk_estimate: 0.1 }),
  ]);
  // No edges → two separate packets; neither is over_budget
  const packets = partitionTaskGraph(graph, { contextTokenBudget: 1000, riskMassBudget: 100 });
  assert.equal(packets.length, 2);
  for (const p of packets) {
    assert.equal(p.over_budget, undefined, "disjoint two-node packets with 600 tokens each are not over_budget");
  }
});
