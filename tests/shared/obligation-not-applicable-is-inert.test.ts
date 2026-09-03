/**
 * `not_applicable` is INERT for the drain, pinned at the ENGINE rather than
 * assumed from the callers.
 *
 * STATED HONESTLY: this file is a GUARD, not a red-first proof. The ordered
 * scan already selected only `missing`/`stale`, so every assertion below is
 * green against the tree that predates the new member — the widening could not
 * have changed selection. What it pins is that the scan keeps its actionability
 * question in ONE place: the moment `findFirstActionableObligation` re-spells
 * the partition (or a future member is classified actionable by accident), the
 * drain starts picking up obligations that have nothing to do, and the two
 * `state.ts` gates this member was introduced for would re-enter the fold
 * forever.
 *
 * The consumer where the widening was NOT inert — the operator handoff's
 * `Set<ObligationState>` literal — is pinned in
 * `tests/audit/obligation-not-applicable.test.ts`, which IS red-first.
 */
import { describe, expect, it } from "vitest";

import {
  ObligationStateSchema,
  findFirstActionableObligation,
  isActionableObligationState,
  type Obligation,
  type ObligationState,
} from "../../src/shared/engine/obligationEngine.js";

const PRIORITY = ["first", "second", "third"] as const;

function obligation(id: string, state: ObligationState): Obligation {
  return { id, state };
}

describe("not_applicable is non-actionable at the engine", () => {
  it("classifies every state, and only missing/stale are actionable", () => {
    // Exhaustive over the LIVE vocabulary, so a member added without a
    // classification fails here as well as at the compiler.
    const classified = Object.fromEntries(
      ObligationStateSchema.options.map((state) => [
        state,
        isActionableObligationState(state),
      ]),
    );
    expect(classified).toEqual({
      missing: true,
      stale: true,
      present: false,
      blocked: false,
      satisfied: false,
      not_applicable: false,
    });
  });

  it("selects nothing when every obligation is not_applicable", () => {
    expect(
      findFirstActionableObligation(PRIORITY, [
        obligation("first", "not_applicable"),
        obligation("second", "not_applicable"),
        obligation("third", "not_applicable"),
      ]),
    ).toBeUndefined();
  });

  it("skips a not_applicable obligation ahead of an actionable one", () => {
    // Priority order is the authority: a higher-priority `not_applicable` must
    // not shadow the lower-priority `missing` behind it.
    expect(
      findFirstActionableObligation(PRIORITY, [
        obligation("first", "not_applicable"),
        obligation("second", "missing"),
      ])?.id,
    ).toBe("second");
  });
});
