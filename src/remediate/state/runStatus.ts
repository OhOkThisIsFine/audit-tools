/**
 * The single authority for the `RemediationState` RUN status lifecycle.
 *
 * `RemediationState.status` is the canonical coarse phase of a remediation run;
 * the load gate (`validateState` in `./store.ts`) admits exactly these values
 * and the N-R13 invariant test asserts against this array. Nothing outside this
 * module may re-enumerate them.
 *
 * Why this module exists. The vocabulary used to exist in three unlinked
 * copies: the inline union on `RemediationState.status`, the module-private
 * accepted-status Set the load gate rejects unknown states with, and a third
 * literal written inside the N-R13 test. Nothing joined them, so the load gate
 * and the type could drift apart with no red build — and the N-R13 assertion
 * ("`documenting` is not a status") was a tautology over a literal the test
 * itself wrote, so a `documenting` status reintroduced into the type would have
 * passed it silently. The array below is the ONE declaration; the type, the
 * load gate and the test all derive from it. [[write-only-data-looks-authoritative]]
 *
 * Deliberately mirrors `ITEM_STATUSES` in `./itemStatus.ts` (a `const` tuple
 * plus a derived union type) so the two halves of remediation state read the
 * same way.
 */

/**
 * Every status a remediation RUN can hold, in lifecycle order.
 *
 * `documenting` is deliberately absent: the document phase was dissolved
 * (N-R13), and planning transitions DIRECTLY to implementing. Adding it back is
 * a red — see the N-R13 invariant test, which reads this array rather than
 * restating it.
 */
export const REMEDIATION_RUN_STATUSES = [
  "pending",
  "planning",
  "waiting_for_clarification",
  "implementing",
  "triage",
  "waiting_for_triage",
  "closing",
  "complete",
] as const;

export type RemediationRunStatus = (typeof REMEDIATION_RUN_STATUSES)[number];

/** Runtime membership test for the load gate — derived, never re-listed. */
export function isRemediationRunStatus(value: unknown): value is RemediationRunStatus {
  return (
    typeof value === "string" &&
    (REMEDIATION_RUN_STATUSES as readonly string[]).includes(value)
  );
}
