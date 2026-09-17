/**
 * The smallest design-review finding a lane submission may carry.
 *
 * Every design-review door parses its items with `SubmittedDesignFindingSchema`
 * since 2026-09-17 (owner review, prompt 11), so a fixture that plants
 * `{id, title}` is now quarantined rather than merged. That partial shape was
 * never a submission a host could have produced — it was only ever what the
 * tolerant array door happened to admit — so the fixtures move to the real
 * contract rather than the door moving back.
 *
 * ONE factory, shared by every design-review fixture: a per-file literal is how
 * eight copies of the same shape drift apart when the contract next changes.
 */
export function designFinding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "DR-001",
    title: "Retry limit is enforced in two places that can disagree",
    category: "inferred_contract_gap",
    severity: "high",
    confidence: "medium",
    lens: "architecture",
    summary: "The two enforcement sites read different constants.",
    affected_files: [{ path: "src/scheduling/rebook.ts" }],
    ...overrides,
  };
}
