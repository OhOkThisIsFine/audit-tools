// Declared in its own module BELOW both `types.ts` and `itemStatus.ts`: types.ts
// needs `RemediationItemStatus` from itemStatus, and itemStatus needs this type —
// which closed a type-only import cycle between them. `types.ts` re-exports it,
// so every existing importer is unchanged.

/**
 * How an item ENDED, as the outcomes contract records it. Derived from the item
 * status by the single status→disposition→outcome authority in `itemStatus.ts`;
 * nothing else may re-enumerate it.
 *
 * Every value is terminal. `abandoned` is the tool giving up — retry bound
 * exhausted, final gate red, or operator halt — and is deliberately distinct
 * from `ignored` (a settled human decision not to act), because collapsing them
 * would erase which of the two happened.
 *
 * `verified_already_fixed` and `refuted` (CDC-25) are the two DISTINCT members
 * added for the run's wider terminal-disposition vocabulary T = { fixed,
 * verified-already-fixed-at-HEAD, refuted-against-HEAD } — `fixed` already had
 * two persisted encodings (`resolved` / `resolved_no_change`); these two give
 * the other two members of T their OWN persisted forms rather than collapsing
 * them onto `resolved_no_change` and telling them apart only by free text.
 *
 * WIDEN THIS UNION HERE, AT ITS DECLARATION — never by relocating it into
 * `types.ts` (whose re-export below is the only thing that lives there):
 * `types.ts` imports `RemediationItemStatus` from `itemStatus.ts`, and
 * `itemStatus.ts` imports THIS type from here, which is what closes the
 * type-only cycle between the two. Relocating the declaration into `types.ts`
 * would reopen that cycle, which `npm run check:depgraph`'s `no-circular` rule
 * gates. Every widening of this union lands in the SAME commit as the matching
 * `RemediationOutcomeStatus` members (`src/shared/types/remediationOutcome.ts`)
 * and the matching `DISPOSITION_TO_OUTCOME_STATUS` entries (`itemStatus.ts`),
 * because that map is a `Record<PerFindingDisposition, RemediationOutcomeStatus>`
 * and therefore exhaustive over this union — a partial landing across the three
 * files is a `npm run check` compile error, not a silent gap.
 */
export type PerFindingDisposition =
  | "resolved"
  | "resolved_no_change"
  | "ignored"
  | "deemed_inappropriate"
  | "abandoned"
  | "verified_already_fixed"
  | "refuted";
