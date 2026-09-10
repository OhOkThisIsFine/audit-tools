import type { RemediationState } from '../../src/remediate/state/store.js';

/**
 * A `RemediationState` fixture builder that cannot omit a required key.
 *
 * It used to take `Record<string, unknown>` overrides and hand the result back
 * through `as unknown as RemediationState`. That cast is what made the parameter
 * type necessary in the first place: an index-signature spread widens the object
 * literal, so the only way back to the contract was to assert it. The assertion
 * then hid the very defect the type exists to catch — a fixture missing a
 * required field (e.g. `plan.blocks[].touched_files`, a STRICT-schema array the
 * load gate rejects) typechecked, ran, and failed somewhere far from the fixture.
 *
 * Typing the parameter as `Partial<RemediationState>` and the return as
 * `RemediationState` moves the check to where the mistake is made: the `satisfies`
 * pins the base literal to the contract, every override is checked at the call
 * site against the real field type, and no assertion is left to launder either.
 */
export function makeState(overrides: Partial<RemediationState> = {}): RemediationState {
  const base = {
    status: 'pending',
    plan: {
      plan_id: 'P1',
      findings: [],
      blocks: [],
      project_type: 'unknown',
      candidate_closing_actions: [],
    },
    items: {},
  } satisfies RemediationState;
  return { ...base, ...overrides };
}
