import test from "node:test";
import assert from "node:assert/strict";

const { computeDispatchFanout } = await import("../../src/audit/cli/dispatch.ts");

// ── FINDING-012: confirmation_recommended threshold ─────────────────────────

await test("FINDING-012: confirmation_recommended is false at the threshold and true above it", () => {
  // agent_count 10, threshold 10 → false (strictly greater-than).
  assert.equal(
    computeDispatchFanout({ agentCount: 10, maxConcurrent: 4, confirmThreshold: 10 })
      .confirmation_recommended,
    false,
  );
  // agent_count 11, threshold 10 → true.
  assert.equal(
    computeDispatchFanout({ agentCount: 11, maxConcurrent: 4, confirmThreshold: 10 })
      .confirmation_recommended,
    true,
  );
});

await test("FINDING-012: confirm_threshold defaults to 10 when unset", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 10, maxConcurrent: 4 }).confirmation_recommended,
    false,
  );
  assert.equal(
    computeDispatchFanout({ agentCount: 11, maxConcurrent: 4 }).confirmation_recommended,
    true,
  );
});

await test("FINDING-012: a custom confirm_threshold is honoured", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 6, maxConcurrent: 4, confirmThreshold: 5 })
      .confirmation_recommended,
    true,
  );
  assert.equal(
    computeDispatchFanout({ agentCount: 5, maxConcurrent: 4, confirmThreshold: 5 })
      .confirmation_recommended,
    false,
  );
});

// ── FINDING-012: dispatch_summary text format ───────────────────────────────

await test("FINDING-012: dispatch_summary formats plural agents", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 12, maxConcurrent: 4 }).dispatch_summary,
    "12 agents, max 4 concurrent (rolling)",
  );
});

await test("FINDING-012: dispatch_summary singularizes 1 agent", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 1, maxConcurrent: 1 }).dispatch_summary,
    "1 agent, max 1 concurrent (rolling)",
  );
});

await test("FINDING-012: dispatch_summary with agent_count=5 maxConcurrent=4", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 5, maxConcurrent: 4 }).dispatch_summary,
    "5 agents, max 4 concurrent (rolling)",
  );
});

await test("FINDING-012: dispatch_summary is always present regardless of confirmation_recommended", () => {
  for (const agentCount of [0, 1, 5, 12, 50]) {
    const f = computeDispatchFanout({ agentCount, maxConcurrent: 4 });
    assert.equal(typeof f.dispatch_summary, "string");
    assert.ok(f.dispatch_summary.length > 0);
  }
});

// ── FINDING-012: max_concurrent_agents on result ───────────────────────────

await test("FINDING-012: max_concurrent_agents is passed through on the result", () => {
  assert.equal(computeDispatchFanout({ agentCount: 10, maxConcurrent: 4 }).max_concurrent_agents, 4);
  assert.equal(computeDispatchFanout({ agentCount: 8, maxConcurrent: 4 }).max_concurrent_agents, 4);
  assert.equal(computeDispatchFanout({ agentCount: 1, maxConcurrent: 1 }).max_concurrent_agents, 1);
});
