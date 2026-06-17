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

/**
 * A *definition* of an ordered obligation for the transition/emit `advance` loop
 * below — distinct from the precomputed-state `Obligation` *value* the bare
 * `findFirstActionableObligation` scan consumes. A definition is an id plus two
 * functions:
 *
 * - `derive(state)` computes the obligation's current satisfaction state from the
 *   orchestrator state. It stays orchestrator-specific: audit-code reads its
 *   artifact-staleness DAG; remediate-code reads persisted status + sidecar-file
 *   existence. Only `missing`/`stale` are actionable.
 * - `execute(state, ctx)` performs the one bounded unit of work and returns an
 *   `ObligationOutcome` — either a `transition` (state advanced; the loop re-scans
 *   within the same call) or an `emit` (a host-actionable step; the loop returns
 *   it).
 *
 * Generic over `S` (orchestrator state), `Ctx` (per-orchestrator execution
 * dependencies — the engine stays agnostic; each orchestrator picks its own `Ctx`
 * rather than the engine imposing a union) and `Step` (the host-actionable step
 * type).
 */
export interface ObligationDef<S, Ctx, Step> {
  id: string;
  derive(state: S): ObligationState;
  execute(state: S, ctx: Ctx): Promise<ObligationOutcome<S, Step>>;
}

/**
 * The result of executing an obligation.
 *
 * - `transition`: the state advanced (in place or replaced); `advance` re-scans
 *   without a host round-trip. This is the generalization over the bare scan that
 *   absorbs remediate-code's internally-recursive cascade (e.g.
 *   planning→implementing→re-scan folded into one call).
 * - `emit`: a host-actionable step; `advance` stops and returns it. `state`
 *   carries the (optionally mutated) state to persist alongside the step — omit it
 *   when the executor left the state unchanged.
 */
export type ObligationOutcome<S, Step> =
  | { kind: "transition"; state: S }
  | { kind: "emit"; step: Step; state?: S };

/** An engine instance: an ordered `priority` + the obligation definitions. */
export interface ObligationEngine<S, Ctx, Step> {
  priority: readonly string[];
  obligations: readonly ObligationDef<S, Ctx, Step>[];
}

/**
 * Derive every obligation's state from `state` and return the first actionable
 * definition in `priority` order, or `undefined` when none is actionable. Reuses
 * the single `findFirstActionableObligation` scan so the ordered-selection
 * semantics (priority is the authority on order *and* membership; only
 * missing/stale are actionable) cannot drift from the bare-scan callers. The
 * engine itself does no IO — any IO lives inside each obligation's `derive`.
 */
export function findNextObligation<S, Ctx, Step>(
  priority: readonly string[],
  obligations: readonly ObligationDef<S, Ctx, Step>[],
  state: S,
): ObligationDef<S, Ctx, Step> | undefined {
  const scanned = obligations.map((o) => ({ id: o.id, state: o.derive(state) }));
  const picked = findFirstActionableObligation(priority, scanned);
  return picked ? obligations.find((o) => o.id === picked.id) : undefined;
}

/**
 * Backstop on consecutive transitions inside `advance` — catches a never-clearing
 * (cyclic) transition obligation. Far above any legitimate transition chain (the
 * deepest real remediate-code fold is a handful of transitions per call).
 */
export const DEFAULT_MAX_TRANSITIONS = 100;

/**
 * Drive the engine from `state`: repeatedly select the highest-priority actionable
 * obligation and execute it. A `transition` outcome advances the state and the
 * loop re-scans within the same call (one host round-trip can fold through several
 * transitions); an `emit` outcome stops the loop and returns the host-actionable
 * step. When no obligation is actionable the run is complete and `step` is `null`.
 *
 * `maxTransitions` bounds consecutive transitions before throwing — a cycle
 * backstop the hand-rolled recursion this replaces never had. `emit` and
 * completion both terminate the loop and are never bounded.
 *
 * This is a strict generalization of the bare scan: an engine whose obligations
 * only ever `emit` stops after exactly one unit (audit-code's emit-only,
 * host-looped contract); `transition` outcomes add remediate-code's in-call
 * folding.
 */
export async function advance<S, Ctx, Step>(
  engine: ObligationEngine<S, Ctx, Step>,
  state: S,
  ctx: Ctx,
  opts?: { maxTransitions?: number },
): Promise<{ state: S; step: Step | null }> {
  const maxTransitions = opts?.maxTransitions ?? DEFAULT_MAX_TRANSITIONS;
  let current = state;
  let transitions = 0;
  for (;;) {
    const obligation = findNextObligation(
      engine.priority,
      engine.obligations,
      current,
    );
    if (!obligation) return { state: current, step: null };
    const outcome = await obligation.execute(current, ctx);
    if (outcome.kind === "emit") {
      return { state: outcome.state ?? current, step: outcome.step };
    }
    current = outcome.state;
    if (++transitions > maxTransitions) {
      throw new Error(
        `advance: exceeded maxTransitions (${maxTransitions}) without reaching ` +
          `an emit or completion. The last selected obligation was ` +
          `"${obligation.id}" — a transition obligation is likely not clearing ` +
          `its own actionable state (cycle).`,
      );
    }
  }
}
