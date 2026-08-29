/**
 * CX-02 constraint-1 item 4 — the MECHANICAL half of the guard's sizing.
 *
 * `FINALIZATION_CYCLE_TOLERANCE` is a domain judgment (how deep a legitimate
 * ping-pong may run) and is deliberately NOT derived from the execution cap —
 * any formula reproducing 16 from 64 would state a dependence that does not
 * exist. What IS mechanical is the ORDERING: at or above `MAX_DRAIN_STEPS`
 * the finalization-cycle guard is dead code, because a fold can never make
 * enough counted dispatches for the slack to reach the tolerance before the
 * budget pauses it. This is the mirror of the invariant `deriveEngineBound`
 * protects from the other side (see `bounded-call-single-source.test.ts`):
 * the relationship is enforced, the judgment is not disguised as arithmetic.
 */
import { test, expect } from "vitest";
import { FINALIZATION_CYCLE_TOLERANCE } from "../../src/audit/cli/nextStepHelpers.js";
import { MAX_DRAIN_STEPS } from "../../src/audit/orchestrator/advance.js";

test("FINALIZATION_CYCLE_TOLERANCE < MAX_DRAIN_STEPS (a tolerance at/above the cap is dead code)", () => {
  expect(FINALIZATION_CYCLE_TOLERANCE).toBeLessThan(MAX_DRAIN_STEPS);
});
