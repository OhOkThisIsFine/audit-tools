// Behaviour-preserving extraction equivalence pin (CP-NODE-1).
//
// The tool-owned final-gate cluster (runToolOwnedFinalGate / applyCoarseReblock /
// COARSE_REBLOCK_BOUND + sidecar I/O) was lifted out of the nextStep.ts god module
// into the sibling leaf module finalGate.ts as a PURE MOVE. This suite pins that the
// move is behaviour-preserving:
//
//  1. IDENTITY — the symbols re-exported by nextStep.ts ARE the exact same
//     references finalGate.ts exports (a move, not a re-implementation, so there is
//     no second copy that could drift).
//  2. CHARACTERIZATION — applyCoarseReblock's state-transition behaviour is
//     identical whether reached through nextStep.ts or finalGate.ts: same below /
//     at-bound transitions, same skip-preservation, same monotonic counter.
//
// If a future edit re-implements either function in nextStep.ts instead of
// re-exporting finalGate.ts's, the identity assertions fail loudly.

import { describe, it, expect } from "vitest";
import {
  applyCoarseReblock as applyCoarseReblockNext,
  runToolOwnedFinalGate as runToolOwnedFinalGateNext,
  COARSE_REBLOCK_BOUND as BOUND_NEXT,
} from "../../src/remediate/steps/nextStep.js";
import {
  applyCoarseReblock as applyCoarseReblockGate,
  runToolOwnedFinalGate as runToolOwnedFinalGateGate,
  COARSE_REBLOCK_BOUND as BOUND_GATE,
} from "../../src/remediate/steps/finalGate.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { RemediationItemState } from "../../src/remediate/state/types.js";
import { makeState as makeBaseState } from "./test-helpers.js";

// Wraps the shared test-helpers makeState (INV-remediate-tests-03), seeding the
// item statuses this suite drives the coarse-reblock transition over.
function makeStateWithItems(
  statuses: Record<string, RemediationItemState["status"]>,
): RemediationState {
  const items: Record<string, RemediationItemState> = {};
  for (const [id, status] of Object.entries(statuses)) {
    items[id] = { finding_id: id, status } as RemediationItemState;
  }
  return makeBaseState({ status: "implementing", items });
}

describe("CP-NODE-1: final-gate extraction is a behaviour-preserving move", () => {
  it("nextStep.ts re-exports the SAME references finalGate.ts exports (identity, no drift copy)", () => {
    expect(applyCoarseReblockNext).toBe(applyCoarseReblockGate);
    expect(runToolOwnedFinalGateNext).toBe(runToolOwnedFinalGateGate);
    expect(BOUND_NEXT).toBe(BOUND_GATE);
  });

  it("applyCoarseReblock below-bound transition is identical via both module paths", () => {
    const seed = { a: "resolved", b: "blocked", c: "ignored" } as const;

    const viaNext = applyCoarseReblockNext(makeStateWithItems(seed), 0, "gate red");
    const viaGate = applyCoarseReblockGate(makeStateWithItems(seed), 0, "gate red");

    for (const decision of [viaNext, viaGate]) {
      expect(decision.action).toBe("reattempt_all");
      expect(decision.next_count).toBe(1);
      // Non-skip items re-opened to pending; the skip disposition is preserved.
      expect(decision.state.items!.a.status).toBe("pending");
      expect(decision.state.items!.b.status).toBe("pending");
      expect(decision.state.items!.c.status).toBe("ignored");
    }
    // Same transition shape through either path.
    expect(viaNext.action).toBe(viaGate.action);
    expect(viaNext.next_count).toBe(viaGate.next_count);
  });

  it("applyCoarseReblock at-bound converges to terminal blocked identically via both paths", () => {
    const seed = { a: "resolved", b: "ignored" } as const;

    const viaNext = applyCoarseReblockNext(makeStateWithItems(seed), BOUND_NEXT, "still red");
    const viaGate = applyCoarseReblockGate(makeStateWithItems(seed), BOUND_GATE, "still red");

    for (const decision of [viaNext, viaGate]) {
      expect(decision.action).toBe("terminal_blocked");
      expect(decision.next_count).toBe(BOUND_NEXT);
      expect(decision.state.items!.a.status).toBe("blocked");
      // Settled user SKIP is never overturned.
      expect(decision.state.items!.b.status).toBe("ignored");
    }
  });

  it("runToolOwnedFinalGate scopes out (does not block) on a non-monorepo target via both paths", async () => {
    const noRepo = "/definitely/not/the/audit-tools/repo/root";
    const runner = () => ({ status: 0 });
    const viaNext = await runToolOwnedFinalGateNext(noRepo, { runner });
    const viaGate = await runToolOwnedFinalGateGate(noRepo, { runner });
    expect(viaNext.scoped_out).toBe(true);
    expect(viaGate.scoped_out).toBe(true);
    expect(viaNext.passed).toBe(true);
    expect(viaGate.passed).toBe(true);
  });
});
