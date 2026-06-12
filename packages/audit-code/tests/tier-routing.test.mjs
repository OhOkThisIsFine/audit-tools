import test from "node:test";
import assert from "node:assert/strict";

const {
  resolveDispatchTier,
  DEFAULT_DEEP_ROUTING_RISK,
  DEFAULT_STANDARD_ROUTING_RISK,
  DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
} = await import("../src/cli/dispatch.ts");
const { buildReviewPacketsFromPartition } = await import(
  "../src/orchestrator/reviewPackets.ts"
);
const { buildTaskAffinityGraph } = await import(
  "../src/orchestrator/taskAffinityGraph.ts"
);

// Helper: build a minimal DispatchComplexity object with sensible defaults.
function makeComplexity(overrides = {}) {
  return {
    priority: "low",
    task_count: 1,
    file_count: 1,
    total_lines: 100,
    estimated_tokens: 500,
    lenses: ["correctness"],
    tags: [],
    large_file_mode: false,
    ...overrides,
  };
}

const tier = (routingRisk, complexityOverrides = {}, routingTiers) =>
  resolveDispatchTier({
    routingRisk,
    complexity: makeComplexity(complexityOverrides),
    routingTiers,
  });

// ── Risk-primary baseline ───────────────────────────────────────────────────

test("low routing_risk → small", () => {
  const result = tier(0.15);
  assert.equal(result.tier, "small");
  assert.deepEqual(result.reasons, ["routing_risk:0.15"]);
});

test("mid routing_risk → standard", () => {
  const result = tier(0.4);
  assert.equal(result.tier, "standard");
  assert.deepEqual(result.reasons, ["routing_risk:0.40"]);
});

test("high routing_risk → deep", () => {
  const result = tier(0.8);
  assert.equal(result.tier, "deep");
  assert.deepEqual(result.reasons, ["routing_risk:0.80"]);
});

test("default cut points sit exactly at the boundary values", () => {
  assert.equal(tier(DEFAULT_STANDARD_ROUTING_RISK).tier, "standard");
  assert.equal(tier(DEFAULT_DEEP_ROUTING_RISK).tier, "deep");
  assert.equal(tier(DEFAULT_STANDARD_ROUTING_RISK - 0.01).tier, "small");
  assert.equal(tier(DEFAULT_DEEP_ROUTING_RISK - 0.01).tier, "standard");
});

test("undefined routing_risk → small baseline with unknown reason", () => {
  const result = tier(undefined);
  assert.equal(result.tier, "small");
  assert.deepEqual(result.reasons, ["routing_risk:unknown"]);
});

// ── Complexity escalators (floor, never lower) ──────────────────────────────

test("low-risk isolated large file escalates to deep", () => {
  const result = tier(0.1, { large_file_mode: true });
  assert.equal(result.tier, "deep");
  assert.deepEqual(result.reasons, ["routing_risk:0.10", "isolated_large_file"]);
});

test("low-risk critical_flow packet escalates to deep", () => {
  for (const tags of [["critical_flow"], ["critical_flow:checkout"]]) {
    const result = tier(0.1, { tags });
    assert.equal(result.tier, "deep");
    assert.ok(result.reasons.includes("critical_flow"));
  }
});

test("low-risk external analyzer signal escalates to deep", () => {
  for (const tags of [["external_analyzer_signal"], ["external_tool:semgrep"]]) {
    const result = tier(0.1, { tags });
    assert.equal(result.tier, "deep");
    assert.ok(result.reasons.includes("external_analyzer_signal"));
  }
});

test("low-risk lens_verification packet escalates to deep", () => {
  const result = tier(0.1, { tags: ["lens_verification"] });
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("lens_verification"));
});

test("low-risk high-token packet escalates to deep", () => {
  const result = tier(0.1, {
    estimated_tokens: DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
  });
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("high_estimated_tokens"));
});

test("low-risk sensitive lens floors at standard", () => {
  const result = tier(0.1, { lenses: ["security"] });
  assert.equal(result.tier, "standard");
  assert.deepEqual(result.reasons, ["routing_risk:0.10", "sensitive_lens"]);
});

test("low-risk medium priority floors at standard", () => {
  const result = tier(0.1, { priority: "medium" });
  assert.equal(result.tier, "standard");
  assert.deepEqual(result.reasons, ["routing_risk:0.10", "medium_priority"]);
});

test("escalators never lower the risk baseline", () => {
  // deep baseline + only a standard-floor escalator stays deep
  const result = tier(0.9, { lenses: ["security"] });
  assert.equal(result.tier, "deep");
  assert.deepEqual(result.reasons, ["routing_risk:0.90", "sensitive_lens"]);
  // standard baseline + standard escalator stays standard
  assert.equal(tier(0.5, { priority: "medium" }).tier, "standard");
});

test("deep escalator on a standard-risk packet escalates and keeps both reasons", () => {
  const result = tier(0.4, { large_file_mode: true, lenses: ["security"] });
  assert.equal(result.tier, "deep");
  assert.deepEqual(result.reasons, [
    "routing_risk:0.40",
    "isolated_large_file",
    "sensitive_lens",
  ]);
});

// ── Threshold overrides (sessionConfig.dispatch.routing_tiers) ──────────────

test("routing_tiers override moves the cut points", () => {
  const custom = { deep_at: 0.5, standard_at: 0.1 };
  assert.equal(tier(0.55, {}, custom).tier, "deep");
  assert.equal(tier(0.15, {}, custom).tier, "standard");
  assert.equal(tier(0.05, {}, custom).tier, "small");
  // same risks under defaults land lower
  assert.equal(tier(0.55).tier, "standard");
  assert.equal(tier(0.15).tier, "small");
});

// ── routing_risk threading through buildReviewPacketsFromPartition ──────────

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

test("partition packets carry routing_risk (max member risk)", () => {
  const tasks = [
    task({ task_id: "t1", unit_id: "u1", file_paths: ["a.ts"], risk_estimate: 0.2 }),
    task({ task_id: "t2", unit_id: "u1", lens: "security", file_paths: ["a.ts"], risk_estimate: 0.8 }),
    task({ task_id: "t3", unit_id: "u2", file_paths: ["z/other.ts"], risk_estimate: 0.1 }),
  ];
  const graph = buildTaskAffinityGraph(tasks);
  const packets = buildReviewPacketsFromPartition(tasks, {
    graph,
    contextTokenBudget: 100000,
  });
  assert.equal(packets.length, 2);
  const merged = packets.find((p) => p.task_ids.length === 2);
  const lone = packets.find((p) => p.task_ids.length === 1);
  assert.ok(merged && lone);
  assert.equal(merged.routing_risk, 0.8);
  assert.equal(lone.routing_risk, 0.1);
});
