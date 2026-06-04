import test from "node:test";
import assert from "node:assert/strict";

const { computeDispatchFanout } = await import("../src/cli/dispatch.ts");

// ── FINDING-012: confirmation_recommended threshold ─────────────────────────

await test("FINDING-012: confirmation_recommended is false at the threshold and true above it", () => {
  // agent_count 10, threshold 10 → false (strictly greater-than).
  assert.equal(
    computeDispatchFanout({ agentCount: 10, waveSize: 4, confirmThreshold: 10 })
      .confirmation_recommended,
    false,
  );
  // agent_count 11, threshold 10 → true.
  assert.equal(
    computeDispatchFanout({ agentCount: 11, waveSize: 4, confirmThreshold: 10 })
      .confirmation_recommended,
    true,
  );
});

await test("FINDING-012: confirm_threshold defaults to 10 when unset", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 10, waveSize: 4 }).confirmation_recommended,
    false,
  );
  assert.equal(
    computeDispatchFanout({ agentCount: 11, waveSize: 4 }).confirmation_recommended,
    true,
  );
});

await test("FINDING-012: a custom confirm_threshold is honoured", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 6, waveSize: 4, confirmThreshold: 5 })
      .confirmation_recommended,
    true,
  );
  assert.equal(
    computeDispatchFanout({ agentCount: 5, waveSize: 4, confirmThreshold: 5 })
      .confirmation_recommended,
    false,
  );
});

// ── FINDING-012: dispatch_summary text format ───────────────────────────────

await test("FINDING-012: dispatch_summary formats plural agents and waves", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 12, waveSize: 4 }).dispatch_summary,
    "12 agents across 3 waves (wave_size=4)",
  );
});

await test("FINDING-012: dispatch_summary singularizes 1 agent / 1 wave", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 1, waveSize: 1 }).dispatch_summary,
    "1 agent across 1 wave (wave_size=1)",
  );
});

await test("FINDING-012: dispatch_summary with agent_count=5 wave_size=4", () => {
  assert.equal(
    computeDispatchFanout({ agentCount: 5, waveSize: 4 }).dispatch_summary,
    "5 agents across 2 waves (wave_size=4)",
  );
});

await test("FINDING-012: dispatch_summary is always present regardless of confirmation_recommended", () => {
  for (const agentCount of [0, 1, 5, 12, 50]) {
    const f = computeDispatchFanout({ agentCount, waveSize: 4 });
    assert.equal(typeof f.dispatch_summary, "string");
    assert.ok(f.dispatch_summary.length > 0);
  }
});

// ── FINDING-012: wave_count math ────────────────────────────────────────────

await test("FINDING-012: wave_count = ceil(agent_count / max(1, wave_size))", () => {
  assert.equal(computeDispatchFanout({ agentCount: 10, waveSize: 4 }).wave_count, 3);
  assert.equal(computeDispatchFanout({ agentCount: 8, waveSize: 4 }).wave_count, 2);
  assert.equal(computeDispatchFanout({ agentCount: 0, waveSize: 4 }).wave_count, 0);
  // Degenerate wave_size=0 → max(1,0)=1 → ceil(7/1)=7.
  assert.equal(computeDispatchFanout({ agentCount: 7, waveSize: 0 }).wave_count, 7);
});
