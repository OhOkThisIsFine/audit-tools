/**
 * Generic "count items by a derived key" reducer. Four independent
 * reimplementations of this existed before the extraction: the audit
 * synthesis summary breakdowns (severity/lens/grounding-status/runtime-status
 * — src/audit/reporting/synthesis.ts, 4 call sites sharing one local
 * `countBy`), the shared audit-deliverable renderer's severity/lens
 * breakdowns (src/shared/reporting/auditDeliverable.ts), remediate's
 * outcomes-report close-out (src/remediate/phases/close.ts), and remediate's
 * findings digest (src/remediate/intake.ts). Single-sourced here so a future
 * fifth breakdown doesn't reimplement it a fifth time.
 *
 * A `selectKey` returning `undefined` or `""` skips the item — it is never
 * counted under an empty-string bucket. This matches the original
 * synthesis.ts behavior (its `if (!key) continue;` guard), which some
 * consumers rely on (e.g. the grounding-status breakdown, where most findings
 * have no grounding verdict at all).
 */
export function countBy<T>(
  items: Iterable<T>,
  selectKey: (item: T) => string | undefined,
): Record<string, number> {
  const breakdown: Record<string, number> = {};
  for (const item of items) {
    const key = selectKey(item);
    if (!key) {
      continue;
    }
    breakdown[key] = (breakdown[key] ?? 0) + 1;
  }
  return breakdown;
}
