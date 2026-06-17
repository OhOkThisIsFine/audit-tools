/**
 * Shared obligation-engine primitives — the single source for how BOTH
 * orchestrators express and select ordered obligations, so the engine
 * vocabulary cannot drift between audit-code and remediate-code (A3).
 *
 * An *obligation* is one named unit of progress carrying a precomputed
 * satisfaction `state`. The engine owns only the ordered *selection* (the scan
 * below); each orchestrator derives its own obligation states — audit-code from
 * the artifact-staleness DAG, remediate-code from persisted status + sidecar
 * files — and maps the selected obligation to an executor.
 *
 * This module is A3's seed: it centralizes the vocabulary + the priority scan
 * that audit-code already had and remediate-code re-derived inside an imperative
 * cascade. The richer transition/emit advance loop (needed to absorb
 * remediate-code's internally-recursive control flow) is added here when
 * remediate-code adopts the engine, so the API is proven by a real consumer
 * rather than designed in a vacuum. See `docs/a3-a4-engine-unification-plan.md`.
 */

/**
 * Satisfaction state of a single ordered obligation. `missing` and `stale` are
 * the *actionable* states the scan selects on; `present`, `satisfied`, and
 * `blocked` are non-actionable.
 */
export type ObligationState =
  | "missing"
  | "present"
  | "stale"
  | "blocked"
  | "satisfied";

/** A single ordered obligation carrying its precomputed satisfaction state. */
export interface Obligation {
  id: string;
  state: ObligationState;
  reason?: string;
}

/**
 * Return the first obligation — in `priority` order — that is actionable
 * (`missing` or `stale`), or `undefined` when every listed obligation is
 * satisfied / non-actionable. Obligations carry their precomputed `state`; the
 * engine owns only this ordered scan so the selection cannot drift between
 * callers.
 *
 * Generic over `T extends Obligation` so callers keep their domain obligation
 * type (e.g. audit-code's `AuditObligation`) as the return type. Ids in
 * `priority` with no matching obligation are skipped; obligations whose id is
 * absent from `priority` are never selected (priority is the authority on order
 * *and* membership).
 */
export function findFirstActionableObligation<T extends Obligation>(
  priority: readonly string[],
  obligations: readonly T[],
): T | undefined {
  for (const id of priority) {
    const item = obligations.find((o) => o.id === id);
    if (item && (item.state === "missing" || item.state === "stale")) {
      return item;
    }
  }
  return undefined;
}
