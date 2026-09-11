// P65 candidate patch (nightly leg 3, 2026-09-11) — NOT WIRED.
//
// The two exports below are the proposed addition to
// `scripts/shared/triage-backlog.mjs`. The one-line wiring change is in
// PROPOSAL.md: `reviveRecord` returns
// `downgradeUnearnedShippedVerdict({ ...rec, premise, ... })` instead of the
// record it builds today.
//
// Property: `already_shipped_or_stale` is the ONE triage verdict that
// authorizes deleting a backlog entry, so it survives revive only when the
// entry's premise was actually evaluated against the tree.

/** The verdict an unearned shipped claim degrades to. */
export const UNVERIFIED_SHIPPED_VERDICT = 'shipped_claim_unverified';

/** Premise stamps that establish nothing about the tree. */
const UNEARNED_PREMISES = new Set([
  'unprobed',
  'probes_unusable',
  'premise_unconfirmed',
]);

/**
 * Downgrade a deletion-authorizing verdict whose premise was never evaluated.
 *
 * Every other verdict passes through untouched: the rule is about what may
 * authorize a DELETION, not about the lane's judgment in general.
 */
export function downgradeUnearnedShippedVerdict(rec) {
  if (rec?.verdict !== 'already_shipped_or_stale') return rec;
  if (!UNEARNED_PREMISES.has(rec?.premise)) return rec;
  return { ...rec, verdict: UNVERIFIED_SHIPPED_VERDICT };
}
