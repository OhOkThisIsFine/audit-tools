import { test, expect } from "vitest";

const {
  resolveDispatchTier,
  DEFAULT_DEEP_ROUTING_RISK,
  DEFAULT_STANDARD_ROUTING_RISK,
  DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
} = await import("../../src/audit/cli/dispatch.ts");
const { buildReviewPacketsFromPartition } = await import("../../src/audit/orchestrator/reviewPackets.ts");
const { buildTaskAffinityGraph } = await import("../../src/audit/orchestrator/taskAffinityGraph.ts");

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
  expect(result.tier).toBe("small");
  expect(result.reasons).toEqual(["routing_risk:0.15"]);
});

test("mid routing_risk → standard", () => {
  const result = tier(0.4);
  expect(result.tier).toBe("standard");
  expect(result.reasons).toEqual(["routing_risk:0.40"]);
});

test("high routing_risk → deep", () => {
  const result = tier(0.8);
  expect(result.tier).toBe("deep");
  expect(result.reasons).toEqual(["routing_risk:0.80"]);
});

test("default cut points sit exactly at the boundary values", () => {
  expect(tier(DEFAULT_STANDARD_ROUTING_RISK).tier).toBe("standard");
  expect(tier(DEFAULT_DEEP_ROUTING_RISK).tier).toBe("deep");
  expect(tier(DEFAULT_STANDARD_ROUTING_RISK - 0.01).tier).toBe("small");
  expect(tier(DEFAULT_DEEP_ROUTING_RISK - 0.01).tier).toBe("standard");
});

test("undefined routing_risk → small baseline with unknown reason", () => {
  const result = tier(undefined);
  expect(result.tier).toBe("small");
  expect(result.reasons).toEqual(["routing_risk:unknown"]);
});

// ── Complexity escalators (floor, never lower) ──────────────────────────────

test("low-risk isolated large file escalates to deep", () => {
  const result = tier(0.1, { large_file_mode: true });
  expect(result.tier).toBe("deep");
  expect(result.reasons).toEqual(["routing_risk:0.10", "isolated_large_file"]);
});

test("low-risk critical_flow packet escalates to deep", () => {
  for (const tags of [["critical_flow"], ["critical_flow:checkout"]]) {
    const result = tier(0.1, { tags });
    expect(result.tier).toBe("deep");
    expect(result.reasons.includes("critical_flow")).toBeTruthy();
  }
});

test("low-risk external analyzer signal escalates to deep", () => {
  for (const tags of [["external_analyzer_signal"], ["external_tool:semgrep"]]) {
    const result = tier(0.1, { tags });
    expect(result.tier).toBe("deep");
    expect(result.reasons.includes("external_analyzer_signal")).toBeTruthy();
  }
});

test("low-risk lens_verification packet escalates to deep", () => {
  const result = tier(0.1, { tags: ["lens_verification"] });
  expect(result.tier).toBe("deep");
  expect(result.reasons.includes("lens_verification")).toBeTruthy();
});

test("low-risk high-token packet escalates to deep", () => {
  const result = tier(0.1, {
    estimated_tokens: DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
  });
  expect(result.tier).toBe("deep");
  expect(result.reasons.includes("high_estimated_tokens")).toBeTruthy();
});

test("low-risk sensitive lens floors at standard", () => {
  const result = tier(0.1, { lenses: ["security"] });
  expect(result.tier).toBe("standard");
  expect(result.reasons).toEqual(["routing_risk:0.10", "sensitive_lens"]);
});

test("low-risk medium priority floors at standard", () => {
  const result = tier(0.1, { priority: "medium" });
  expect(result.tier).toBe("standard");
  expect(result.reasons).toEqual(["routing_risk:0.10", "medium_priority"]);
});

test("escalators never lower the risk baseline", () => {
  // deep baseline + only a standard-floor escalator stays deep
  const result = tier(0.9, { lenses: ["security"] });
  expect(result.tier).toBe("deep");
  expect(result.reasons).toEqual(["routing_risk:0.90", "sensitive_lens"]);
  // standard baseline + standard escalator stays standard
  expect(tier(0.5, { priority: "medium" }).tier).toBe("standard");
});

test("deep escalator on a standard-risk packet escalates and keeps both reasons", () => {
  const result = tier(0.4, { large_file_mode: true, lenses: ["security"] });
  expect(result.tier).toBe("deep");
  expect(result.reasons).toEqual([
    "routing_risk:0.40",
    "isolated_large_file",
    "sensitive_lens",
  ]);
});

// ── Threshold overrides (sessionConfig.dispatch.routing_tiers) ──────────────

test("routing_tiers override moves the cut points", () => {
  const custom = { deep_at: 0.5, standard_at: 0.1 };
  expect(tier(0.55, {}, custom).tier).toBe("deep");
  expect(tier(0.15, {}, custom).tier).toBe("standard");
  expect(tier(0.05, {}, custom).tier).toBe("small");
  // same risks under defaults land lower
  expect(tier(0.55).tier).toBe("standard");
  expect(tier(0.15).tier).toBe("small");
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
  expect(packets.length).toBe(2);
  const merged = packets.find((p) => p.task_ids.length === 2);
  const lone = packets.find((p) => p.task_ids.length === 1);
  expect(merged && lone).toBeTruthy();
  expect(merged.routing_risk).toBe(0.8);
  expect(lone.routing_risk).toBe(0.1);
});
