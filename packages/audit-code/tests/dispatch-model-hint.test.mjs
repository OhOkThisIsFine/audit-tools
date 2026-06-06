import test from "node:test";
import assert from "node:assert/strict";

const {
  buildDispatchModelHint,
  DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
  SMALL_MODEL_HINT_MAX_LINES,
  SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS,
} = await import("../src/cli/dispatch.ts");

// Helper: build a minimal DispatchComplexity object with sensible defaults.
function makeComplexity(overrides = {}) {
  return {
    priority: "medium",
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

// ── Deep tier ───────────────────────────────────────────────────────────────

test("buildDispatchModelHint: deep tier — high_priority reason", () => {
  const result = buildDispatchModelHint(makeComplexity({ priority: "high" }));
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("high_priority"));
});

test("buildDispatchModelHint: deep tier — isolated_large_file reason", () => {
  const result = buildDispatchModelHint(
    makeComplexity({ priority: "medium", large_file_mode: true }),
  );
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("isolated_large_file"));
});

test("buildDispatchModelHint: deep tier — high_estimated_tokens reason", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "medium",
      estimated_tokens: DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
    }),
  );
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("high_estimated_tokens"));
});

test("buildDispatchModelHint: deep tier — critical_flow tag exact match", () => {
  const result = buildDispatchModelHint(
    makeComplexity({ tags: ["critical_flow"] }),
  );
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("critical_flow"));
});

test("buildDispatchModelHint: deep tier — critical_flow tag prefix match", () => {
  const result = buildDispatchModelHint(
    makeComplexity({ tags: ["critical_flow:auth"] }),
  );
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("critical_flow"));
});

test("buildDispatchModelHint: deep tier — external_analyzer_signal tag exact match", () => {
  const result = buildDispatchModelHint(
    makeComplexity({ tags: ["external_analyzer_signal"] }),
  );
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("external_analyzer_signal"));
});

test("buildDispatchModelHint: deep tier — external_tool: prefix tag", () => {
  const result = buildDispatchModelHint(
    makeComplexity({ tags: ["external_tool:semgrep"] }),
  );
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("external_analyzer_signal"));
});

test("buildDispatchModelHint: deep tier — lens_verification tag", () => {
  const result = buildDispatchModelHint(
    makeComplexity({ tags: ["lens_verification"] }),
  );
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("lens_verification"));
});

test("buildDispatchModelHint: deep tier — multiple reasons accumulate", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "high",
      large_file_mode: true,
      estimated_tokens: DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
      tags: ["critical_flow"],
    }),
  );
  assert.equal(result.tier, "deep");
  assert.ok(result.reasons.includes("high_priority"));
  assert.ok(result.reasons.includes("isolated_large_file"));
  assert.ok(result.reasons.includes("high_estimated_tokens"));
  assert.ok(result.reasons.includes("critical_flow"));
});

// ── Small tier ──────────────────────────────────────────────────────────────

test("buildDispatchModelHint: small tier — all conditions satisfied", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "low",
      total_lines: SMALL_MODEL_HINT_MAX_LINES,
      estimated_tokens: SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS,
      lenses: ["correctness"],
      tags: [],
    }),
  );
  assert.equal(result.tier, "small");
  assert.deepEqual(result.reasons, ["small_low_priority_packet"]);
});

test("buildDispatchModelHint: small tier blocked by sensitive lens", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "low",
      total_lines: SMALL_MODEL_HINT_MAX_LINES,
      estimated_tokens: SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS,
      lenses: ["security"],
      tags: [],
    }),
  );
  assert.notEqual(result.tier, "small");
});

test("buildDispatchModelHint: small tier blocked by non-empty tags", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "low",
      total_lines: SMALL_MODEL_HINT_MAX_LINES,
      estimated_tokens: SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS,
      lenses: ["correctness"],
      tags: ["some_tag"],
    }),
  );
  assert.notEqual(result.tier, "small");
});

test("buildDispatchModelHint: small tier blocked by non-low priority", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "medium",
      total_lines: SMALL_MODEL_HINT_MAX_LINES,
      estimated_tokens: SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS,
      lenses: ["correctness"],
      tags: [],
    }),
  );
  assert.notEqual(result.tier, "small");
});

test("buildDispatchModelHint: small tier blocked by oversized line count", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "low",
      total_lines: SMALL_MODEL_HINT_MAX_LINES + 1,
      estimated_tokens: SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS,
      lenses: ["correctness"],
      tags: [],
    }),
  );
  assert.notEqual(result.tier, "small");
});

test("buildDispatchModelHint: small tier blocked by oversized token count", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "low",
      total_lines: SMALL_MODEL_HINT_MAX_LINES,
      estimated_tokens: SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS + 1,
      lenses: ["correctness"],
      tags: [],
    }),
  );
  assert.notEqual(result.tier, "small");
});

// ── Standard tier ───────────────────────────────────────────────────────────

test("buildDispatchModelHint: standard tier — medium_priority reason", () => {
  const result = buildDispatchModelHint(
    makeComplexity({ priority: "medium", total_lines: 100 }),
  );
  assert.equal(result.tier, "standard");
  assert.ok(result.reasons.includes("medium_priority"));
});

test("buildDispatchModelHint: standard tier — sensitive_lens reason", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "medium",
      lenses: ["security"],
      total_lines: 100,
      estimated_tokens: 500,
    }),
  );
  assert.equal(result.tier, "standard");
  assert.ok(result.reasons.includes("sensitive_lens"));
});

test("buildDispatchModelHint: standard tier — moderate_size reason", () => {
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "medium",
      total_lines: SMALL_MODEL_HINT_MAX_LINES + 1,
    }),
  );
  assert.equal(result.tier, "standard");
  assert.ok(result.reasons.includes("moderate_size"));
});

test("buildDispatchModelHint: standard tier — default_review_packet fallback", () => {
  // priority low (so no medium_priority), within the line cap (so no
  // moderate_size), non-sensitive lens, no tags — but estimated_tokens just
  // above the small-packet ceiling so it escapes the small tier without
  // triggering any standard sub-reason: it falls back to the default.
  const result = buildDispatchModelHint(
    makeComplexity({
      priority: "low",
      total_lines: SMALL_MODEL_HINT_MAX_LINES,
      estimated_tokens: SMALL_MODEL_HINT_MAX_ESTIMATED_TOKENS + 1,
      lenses: ["correctness"],
      tags: [],
    }),
  );
  assert.equal(result.tier, "standard");
  assert.deepEqual(result.reasons, ["default_review_packet"]);
});
