import { test, expect } from "vitest";

const { computeDispatchFanout } = await import("../../src/audit/cli/dispatch.ts");

// ── FINDING-012: confirmation_recommended threshold ─────────────────────────

await test("FINDING-012: confirmation_recommended is false at the threshold and true above it", () => {
  // agent_count 10, threshold 10 → false (strictly greater-than).
  expect(computeDispatchFanout({ agentCount: 10, grantedCount: 4, declaredCap: null, confirmThreshold: 10 })
      .confirmation_recommended).toBe(false);
  // agent_count 11, threshold 10 → true.
  expect(computeDispatchFanout({ agentCount: 11, grantedCount: 4, declaredCap: null, confirmThreshold: 10 })
      .confirmation_recommended).toBe(true);
});

await test("FINDING-012: confirm_threshold defaults to 10 when unset", () => {
  expect(computeDispatchFanout({ agentCount: 10, grantedCount: 4, declaredCap: null }).confirmation_recommended).toBe(false);
  expect(computeDispatchFanout({ agentCount: 11, grantedCount: 4, declaredCap: null }).confirmation_recommended).toBe(true);
});

await test("FINDING-012: a custom confirm_threshold is honoured", () => {
  expect(computeDispatchFanout({ agentCount: 6, grantedCount: 4, declaredCap: null, confirmThreshold: 5 })
      .confirmation_recommended).toBe(true);
  expect(computeDispatchFanout({ agentCount: 5, grantedCount: 4, declaredCap: null, confirmThreshold: 5 })
      .confirmation_recommended).toBe(false);
});

// ── FINDING-012: dispatch_summary text format (granted-set / admission width) ──

await test("FINDING-012: dispatch_summary reports the granted set of the total", () => {
  expect(computeDispatchFanout({ agentCount: 12, grantedCount: 4, declaredCap: null }).dispatch_summary)
    .toBe("4 of 12 packets granted this pass");
});

await test("FINDING-012: dispatch_summary singularizes 1 packet", () => {
  expect(computeDispatchFanout({ agentCount: 1, grantedCount: 1, declaredCap: null }).dispatch_summary)
    .toBe("1 of 1 packet granted this pass");
});

await test("FINDING-012: dispatch_summary appends a declared in-flight cap when present", () => {
  expect(computeDispatchFanout({ agentCount: 5, grantedCount: 5, declaredCap: 6 }).dispatch_summary)
    .toBe("5 of 5 packets granted this pass, ≤6 in flight");
});

await test("FINDING-012: dispatch_summary is always present regardless of confirmation_recommended", () => {
  for (const agentCount of [0, 1, 5, 12, 50]) {
    const f = computeDispatchFanout({ agentCount, grantedCount: Math.min(agentCount, 4), declaredCap: null });
    expect(typeof f.dispatch_summary).toBe("string");
    expect(f.dispatch_summary.length > 0).toBeTruthy();
  }
});

// ── FINDING-012: granted_count / declared_cap on the result (admission width) ──

await test("FINDING-012: granted_count and declared_cap are passed through on the result", () => {
  const a = computeDispatchFanout({ agentCount: 10, grantedCount: 4, declaredCap: null });
  expect(a.granted_count).toBe(4);
  expect(a.declared_cap).toBe(null);
  const b = computeDispatchFanout({ agentCount: 8, grantedCount: 8, declaredCap: 6 });
  expect(b.granted_count).toBe(8);
  expect(b.declared_cap).toBe(6);
});
