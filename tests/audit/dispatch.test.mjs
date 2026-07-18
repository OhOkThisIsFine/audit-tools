/**
 * prepareDispatchArtifacts seams — currently the step-G override packer budget
 * (deriveOverridePackerBudget): the pool-override path must pack packets that the
 * rolling engine's fit gate will actually admit.
 */

import { test, expect } from "vitest";
// ── Unified-routing step G: override packer budget is fit-consistent ─────────
test("deriveOverridePackerBudget: sizes to the largest pool cap minus the agentic harness overhead", async () => {
  const { deriveOverridePackerBudget } = await import("../../src/audit/cli/dispatch.ts");
  const { AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS } = await import("audit-tools/shared");
  const limits = { context_tokens: 200_000, output_tokens: 8_000 };
  // Two capped pools: budget keys on the LARGEST cap, minus the engine's fit overhead —
  // a packet packed to this budget always fits at least one pool's fit gate.
  expect(
    deriveOverridePackerBudget(
      [{ contextCapTokens: 32_000 }, { contextCapTokens: 128_000 }],
      limits,
    ),
  ).toBe(128_000 - AGENTIC_WORKER_HARNESS_OVERHEAD_TOKENS);
  // The resolved context−output budget still ceilings it (never pack past the model window).
  expect(
    deriveOverridePackerBudget([{ contextCapTokens: 500_000 }], limits),
  ).toBe(192_000);
  // No caps (degrade, impossible post step A) → the raw resolved budget, exactly as before.
  expect(deriveOverridePackerBudget([{}], limits)).toBe(192_000);
  // A cap at/below the overhead floors at 1, never 0/negative.
  expect(deriveOverridePackerBudget([{ contextCapTokens: 10_000 }], limits)).toBe(1);
});
