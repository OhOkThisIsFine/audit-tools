// Behaviour-preserving extraction equivalence pin (CP-NODE-1).
//
// The tool-owned final-gate cluster was lifted out of the nextStep.ts god module
// into the sibling leaf module finalGate.ts as a PURE MOVE. This suite pins that
// the move is behaviour-preserving: the symbols re-exported by nextStep.ts ARE
// the exact same references finalGate.ts exports (a move, not a
// re-implementation, so there is no second copy that could drift). If a future
// edit re-implements one in nextStep.ts instead of re-exporting finalGate.ts's,
// the identity assertions fail loudly.
//
// The suite's other half used to characterize `applyCoarseReblock` — the coarse
// backstop that re-opened every item on a whole-repo red and abandoned the run
// at its bound. That function is gone, and with it those cases: a red now
// records what failed and pauses, which is pinned in final-gate-red-pause.

import { describe, it, expect } from "vitest";
import {
  runToolOwnedFinalGate as runToolOwnedFinalGateNext,
  toolOwnedFinalGateCommands as toolOwnedFinalGateCommandsNext,
} from "../../src/remediate/steps/nextStep.js";
import {
  runToolOwnedFinalGate as runToolOwnedFinalGateGate,
  toolOwnedFinalGateCommands as toolOwnedFinalGateCommandsGate,
} from "../../src/remediate/steps/finalGate.js";

describe("CP-NODE-1: final-gate extraction is a behaviour-preserving move", () => {
  it("nextStep.ts re-exports the SAME references finalGate.ts exports (identity, no drift copy)", () => {
    expect(runToolOwnedFinalGateNext).toBe(runToolOwnedFinalGateGate);
    expect(toolOwnedFinalGateCommandsNext).toBe(toolOwnedFinalGateCommandsGate);
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
