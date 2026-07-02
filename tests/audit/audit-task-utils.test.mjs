import { test, expect } from "vitest";

const { LENS_ORDER, priorityRank, sortLenses, computeRiskEstimate } =
  await import("../../src/audit/orchestrator/auditTaskUtils.ts");
const { LENS_REGISTRY, ALL_LENSES, isLens } = await import("../../src/audit/types.ts");
const { LENSES } = await import("audit-tools/shared");

// ── priorityRank ──────────────────────────────────────────────────────────────

test("priorityRank returns 3 for high, 2 for medium, 1 for low", () => {
  expect(priorityRank("high")).toBe(3);
  expect(priorityRank("medium")).toBe(2);
  expect(priorityRank("low")).toBe(1);
});

test("priorityRank returns 1 for unknown/default priority values", () => {
  expect(priorityRank("unknown")).toBe(1);
  expect(priorityRank(undefined)).toBe(1);
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
  expect(computeRiskEstimate(baseTask({ priority: "high" }))).toBe(0.7);
  expect(computeRiskEstimate(baseTask({ priority: "medium" }))).toBe(0.4);
  expect(computeRiskEstimate(baseTask({ priority: "low" }))).toBe(0.15);
  // missing priority defaults to the low seed
  expect(computeRiskEstimate(baseTask({}))).toBe(0.15);
});

test("computeRiskEstimate adds bonuses for risk-signalling tags and sensitive lenses", () => {
  // critical_flow (+0.15) on a low-priority task
  expect(Math.abs(
      computeRiskEstimate(baseTask({ priority: "low", tags: ["critical_flow"] })) -
        0.3,
    ) < 1e-9).toBeTruthy();
  // sensitive lens (+0.1)
  expect(Math.abs(
      computeRiskEstimate(baseTask({ priority: "low", lens: "security" })) - 0.25,
    ) < 1e-9).toBeTruthy();
  // analyzer signal (+0.1) + lens_verification (+0.1)
  expect(Math.abs(
      computeRiskEstimate(
        baseTask({
          priority: "low",
          tags: ["external_analyzer_signal", "lens_verification"],
        }),
      ) - 0.35,
    ) < 1e-9).toBeTruthy();
});

test("computeRiskEstimate clamps to [0,1]", () => {
  const score = computeRiskEstimate(
    baseTask({
      priority: "high",
      lens: "security",
      tags: ["critical_flow", "external_analyzer_signal", "lens_verification"],
    }),
  );
  expect(score <= 1 && score >= 0, `score ${score} should be within [0,1]`).toBeTruthy();
  expect(score).toBe(1); // 0.7 + 0.15 + 0.1 + 0.1 + 0.1 = 1.15 → clamped
});

// ── sortLenses ────────────────────────────────────────────────────────────────

test("sortLenses returns lenses in LENS_ORDER canonical order, ignoring input order", () => {
  // security comes before correctness in LENS_ORDER
  expect(sortLenses(["correctness", "security"])).toEqual([
    "security",
    "correctness",
  ]);
  // security before performance before tests
  expect(sortLenses(["tests", "performance", "security"])).toEqual([
    "security",
    "performance",
    "tests",
  ]);
});

test("sortLenses preserves custom lenses after canonical lenses", () => {
  expect(sortLenses(["correctness", "unknown_lens"])).toEqual([
    "correctness",
    "unknown_lens",
  ]);
  expect(sortLenses([])).toEqual([]);
});

test("sortLenses accepts any Iterable<Lens>, including Set", () => {
  expect(sortLenses(new Set(["maintainability", "security"]))).toEqual([
    "security",
    "maintainability",
  ]);
});

test("sortLenses deduplicates repeated lenses (via Set construction)", () => {
  expect(sortLenses(["security", "security", "correctness"])).toEqual([
    "security",
    "correctness",
  ]);
});

// ── LENS_ORDER ────────────────────────────────────────────────────────────────

test("LENS_ORDER contains all expected lenses in the declared order", () => {
  expect(LENS_ORDER[0], "first lens should be security").toBe("security");
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
  expect(LENS_ORDER.length, `LENS_ORDER should have ${expected.length} entries`).toBe(expected.length);
  expect([...LENS_ORDER], "LENS_ORDER should match the canonical declaration order").toEqual(expected);
});

// ── LENS_REGISTRY ─────────────────────────────────────────────────────────────

test("LENS_REGISTRY covers all ALL_LENSES entries", () => {
  const registryIds = LENS_REGISTRY.map((d) => d.id);
  expect(registryIds.length, "LENS_REGISTRY should have one entry per canonical lens (LENSES)").toBe(LENSES.length);
  for (const lens of ALL_LENSES) {
    expect(registryIds.includes(lens), `LENS_REGISTRY should contain an entry for '${lens}'`).toBeTruthy();
  }
});

test("every ALL_LENSES entry satisfies isLens()", () => {
  for (const lens of ALL_LENSES) {
    expect(isLens(lens), `isLens should accept '${lens}'`).toBeTruthy();
  }
});

test("LENS_REGISTRY entries have unique order_weight values", () => {
  const weights = LENS_REGISTRY.map((d) => d.order_weight);
  const uniqueWeights = new Set(weights);
  expect(uniqueWeights.size, "all order_weight values in LENS_REGISTRY must be unique").toBe(weights.length);
});

test("LENS_REGISTRY contains an entry for 'architecture'", () => {
  const entry = LENS_REGISTRY.find((d) => d.id === "architecture");
  expect(entry !== undefined, "LENS_REGISTRY must include an 'architecture' entry").toBeTruthy();
  expect(entry.id).toBe("architecture");
});

// ── LENS_ORDER derived from LENS_REGISTRY ────────────────────────────────────

test("LENS_ORDER includes 'architecture' (previously missing from the hardcoded array)", () => {
  expect(LENS_ORDER.includes("architecture"), "LENS_ORDER must include 'architecture'").toBeTruthy();
});

test("LENS_ORDER is sorted ascending by order_weight", () => {
  const weights = LENS_ORDER.map(
    (id) => LENS_REGISTRY.find((d) => d.id === id).order_weight,
  );
  for (let i = 1; i < weights.length; i++) {
    expect(weights[i] > weights[i - 1], `LENS_ORDER[${i}] weight ${weights[i]} should be > LENS_ORDER[${i - 1}] weight ${weights[i - 1]}`).toBeTruthy();
  }
});

test("LENS_ORDER length equals LENS_REGISTRY.length", () => {
  expect(LENS_ORDER.length, "LENS_ORDER must have one entry per registry entry").toBe(LENS_REGISTRY.length);
});

test("sortLenses with registry-derived LENS_ORDER includes architecture in result", () => {
  const result = sortLenses(["architecture", "security"]);
  expect(result.includes("architecture"), "sortLenses must include 'architecture'").toBeTruthy();
  expect(result.includes("security"), "sortLenses must include 'security'").toBeTruthy();
  // security has lower order_weight → appears first
  expect(result.indexOf("security") < result.indexOf("architecture"), "security should precede architecture in LENS_ORDER sequence").toBeTruthy();
});

test("sortLenses with a subset returns only the present lenses in order", () => {
  const result = sortLenses(["tests", "architecture", "correctness"]);
  // All three are valid lenses — result length should be 3
  expect(result.length).toBe(3);
  // Verify ordering: correctness (20) < architecture (60) < tests (110)
  expect(result.indexOf("correctness") < result.indexOf("architecture"), "correctness precedes architecture").toBeTruthy();
  expect(result.indexOf("architecture") < result.indexOf("tests"), "architecture precedes tests").toBeTruthy();
});
