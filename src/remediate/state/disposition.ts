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
 */
export type PerFindingDisposition =
  | "resolved"
  | "resolved_no_change"
  | "ignored"
  | "deemed_inappropriate"
  | "abandoned";
