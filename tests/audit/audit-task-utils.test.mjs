import test from "node:test";
import assert from "node:assert/strict";

const { LENS_ORDER, priorityRank, sortLenses, computeRiskEstimate } =
  await import("../../src/audit/orchestrator/auditTaskUtils.ts");
const { LENS_REGISTRY, ALL_LENSES, isLens } = await import("../../src/audit/types.ts");
const { LENSES } = await import("audit-tools/shared");

// ── priorityRank ──────────────────────────────────────────────────────────────

test("priorityRank returns 3 for high, 2 for medium, 1 for low", () => {
  assert.equal(priorityRank("high"), 3);
  assert.equal(priorityRank("medium"), 2);
  assert.equal(priorityRank("low"), 1);
});

test("priorityRank returns 1 for unknown/default priority values", () => {
  assert.equal(priorityRank("unknown"), 1);
  assert.equal(priorityRank(undefined), 1);
});

// ── computeRiskEstimate ───────────────────────────────────────────────────────

const baseTask = (over = {}) => ({
  task_id: "t",
  unit_id: "u",
  pass_id: "p",
  lens: "maintainability",
  file_paths: ["a.ts"],
  rationale: "r",
  ...over,
});

test("computeRiskEstimate seeds from priority (high>medium>low)", () => {
  assert.equal(computeRiskEstimate(baseTask({ priority: "high" })), 0.7);
  assert.equal(computeRiskEstimate(baseTask({ priority: "medium" })), 0.4);
  assert.equal(computeRiskEstimate(baseTask({ priority: "low" })), 0.15);
  // missing priority defaults to the low seed
  assert.equal(computeRiskEstimate(baseTask({})), 0.15);
});

test("computeRiskEstimate adds bonuses for risk-signalling tags and sensitive lenses", () => {
  // critical_flow (+0.15) on a low-priority task
  assert.ok(
    Math.abs(
      computeRiskEstimate(baseTask({ priority: "low", tags: ["critical_flow"] })) -
        0.3,
    ) < 1e-9,
  );
  // sensitive lens (+0.1)
  assert.ok(
    Math.abs(
      computeRiskEstimate(baseTask({ priority: "low", lens: "security" })) - 0.25,
    ) < 1e-9,
  );
  // analyzer signal (+0.1) + lens_verification (+0.1)
  assert.ok(
    Math.abs(
      computeRiskEstimate(
        baseTask({
          priority: "low",
          tags: ["external_analyzer_signal", "lens_verification"],
        }),
      ) - 0.35,
    ) < 1e-9,
  );
});

test("computeRiskEstimate clamps to [0,1]", () => {
  const score = computeRiskEstimate(
    baseTask({
      priority: "high",
      lens: "security",
      tags: ["critical_flow", "external_analyzer_signal", "lens_verification"],
    }),
  );
  assert.ok(score <= 1 && score >= 0, `score ${score} should be within [0,1]`);
  assert.equal(score, 1); // 0.7 + 0.15 + 0.1 + 0.1 + 0.1 = 1.15 → clamped
});

// ── sortLenses ────────────────────────────────────────────────────────────────

test("sortLenses returns lenses in LENS_ORDER canonical order, ignoring input order", () => {
  // security comes before correctness in LENS_ORDER
  assert.deepEqual(sortLenses(["correctness", "security"]), [
    "security",
    "correctness",
  ]);
  // security before performance before tests
  assert.deepEqual(sortLenses(["tests", "performance", "security"]), [
    "security",
    "performance",
    "tests",
  ]);
});

test("sortLenses preserves custom lenses after canonical lenses", () => {
  assert.deepEqual(sortLenses(["correctness", "unknown_lens"]), [
    "correctness",
    "unknown_lens",
  ]);
  assert.deepEqual(sortLenses([]), []);
});

test("sortLenses accepts any Iterable<Lens>, including Set", () => {
  assert.deepEqual(sortLenses(new Set(["maintainability", "security"])), [
    "security",
    "maintainability",
  ]);
});

test("sortLenses deduplicates repeated lenses (via Set construction)", () => {
  assert.deepEqual(sortLenses(["security", "security", "correctness"]), [
    "security",
    "correctness",
  ]);
});

// ── LENS_ORDER ────────────────────────────────────────────────────────────────

test("LENS_ORDER contains all expected lenses in the declared order", () => {
  assert.equal(LENS_ORDER[0], "security", "first lens should be security");
  const expected = [
    "security",
    "correctness",
    "reliability",
    "data_integrity",
    "performance",
    "architecture",
    "operability",
    "config_deployment",
    "observability",
    "maintainability",
    "tests",
  ];
  assert.equal(
    LENS_ORDER.length,
    expected.length,
    `LENS_ORDER should have ${expected.length} entries`,
  );
  assert.deepEqual(
    [...LENS_ORDER],
    expected,
    "LENS_ORDER should match the canonical declaration order",
  );
});

// ── LENS_REGISTRY ─────────────────────────────────────────────────────────────

test("LENS_REGISTRY covers all ALL_LENSES entries", () => {
  const registryIds = LENS_REGISTRY.map((d) => d.id);
  assert.equal(
    registryIds.length,
    LENSES.length,
    "LENS_REGISTRY should have one entry per canonical lens (LENSES)",
  );
  for (const lens of ALL_LENSES) {
    assert.ok(
      registryIds.includes(lens),
      `LENS_REGISTRY should contain an entry for '${lens}'`,
    );
  }
});

test("every ALL_LENSES entry satisfies isLens()", () => {
  for (const lens of ALL_LENSES) {
    assert.ok(isLens(lens), `isLens should accept '${lens}'`);
  }
});

test("LENS_REGISTRY entries have unique order_weight values", () => {
  const weights = LENS_REGISTRY.map((d) => d.order_weight);
  const uniqueWeights = new Set(weights);
  assert.equal(
    uniqueWeights.size,
    weights.length,
    "all order_weight values in LENS_REGISTRY must be unique",
  );
});

test("LENS_REGISTRY contains an entry for 'architecture'", () => {
  const entry = LENS_REGISTRY.find((d) => d.id === "architecture");
  assert.ok(entry !== undefined, "LENS_REGISTRY must include an 'architecture' entry");
  assert.equal(entry.id, "architecture");
});

// ── LENS_ORDER derived from LENS_REGISTRY ────────────────────────────────────

test("LENS_ORDER includes 'architecture' (previously missing from the hardcoded array)", () => {
  assert.ok(
    LENS_ORDER.includes("architecture"),
    "LENS_ORDER must include 'architecture'",
  );
});

test("LENS_ORDER is sorted ascending by order_weight", () => {
  const weights = LENS_ORDER.map(
    (id) => LENS_REGISTRY.find((d) => d.id === id).order_weight,
  );
  for (let i = 1; i < weights.length; i++) {
    assert.ok(
      weights[i] > weights[i - 1],
      `LENS_ORDER[${i}] weight ${weights[i]} should be > LENS_ORDER[${i - 1}] weight ${weights[i - 1]}`,
    );
  }
});

test("LENS_ORDER length equals LENS_REGISTRY.length", () => {
  assert.equal(
    LENS_ORDER.length,
    LENS_REGISTRY.length,
    "LENS_ORDER must have one entry per registry entry",
  );
});

test("sortLenses with registry-derived LENS_ORDER includes architecture in result", () => {
  const result = sortLenses(["architecture", "security"]);
  assert.ok(result.includes("architecture"), "sortLenses must include 'architecture'");
  assert.ok(result.includes("security"), "sortLenses must include 'security'");
  // security has lower order_weight → appears first
  assert.ok(
    result.indexOf("security") < result.indexOf("architecture"),
    "security should precede architecture in LENS_ORDER sequence",
  );
});

test("sortLenses with a subset returns only the present lenses in order", () => {
  const result = sortLenses(["tests", "architecture", "correctness"]);
  // All three are valid lenses — result length should be 3
  assert.equal(result.length, 3);
  // Verify ordering: correctness (20) < architecture (60) < tests (110)
  assert.ok(
    result.indexOf("correctness") < result.indexOf("architecture"),
    "correctness precedes architecture",
  );
  assert.ok(
    result.indexOf("architecture") < result.indexOf("tests"),
    "architecture precedes tests",
  );
});
