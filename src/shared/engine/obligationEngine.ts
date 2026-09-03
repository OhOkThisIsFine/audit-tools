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
 * rather than designed in a vacuum. See `spec/a3-a4-engine-unification-plan.md`.
 */

import { z } from "zod";

/**
 * Satisfaction state of a single ordered obligation. `missing` and `stale` are
 * the *actionable* states the scan selects on; `present`, `satisfied`,
 * `blocked`, and `not_applicable` are non-actionable.
 *
 * `not_applicable` is the answer for an obligation whose INPUT SET IS EMPTY —
 * there was nothing to do, so nothing was achieved either. It is not a success
 * member: a gate with zero planned tasks used to report `satisfied`, which read
 * as "checked, and it passed" when the truth was "there was nothing to check".
 * The word is the shared measured-outcome vocabulary's
 * (`src/shared/measurement/measuredOutcome.ts`) and its RULE — an empty input
 * set is never a success member — but not its type: this enum governs the
 * drain's actionability scan, which that vocabulary knows nothing about.
 */
export const ObligationStateSchema = z.enum([
  "missing",
  "present",
  "stale",
  "blocked",
  "satisfied",
  "not_applicable",
]);
export type ObligationState = z.infer<typeof ObligationStateSchema>;

/**
 * Which states the ordered scan may select. Exhaustive by construction, so
 * widening {@link ObligationStateSchema} without classifying the new member is
 * a COMPILE error rather than a silent fall-through — in EITHER direction: a
 * new member cannot become actionable by accident, and cannot become pending on
 * a host-facing surface by accident either.
 */
const OBLIGATION_STATE_IS_ACTIONABLE: Record<ObligationState, boolean> = {
  missing: true,
  stale: true,
  present: false,
  blocked: false,
  satisfied: false,
  not_applicable: false,
};

/**
 * True when an obligation in this state is work the drain can pick up. The ONE
 * home for that question: the scan below asks it, and so does every consumer
 * that partitions obligations into "still owed" and "not" — which used to
 * re-spell the partition as its own membership set and therefore could not
 * notice the vocabulary widening underneath it.
 */
export function isActionableObligationState(state: ObligationState): boolean {
  return OBLIGATION_STATE_IS_ACTIONABLE[state];
}

/** A single ordered obligation carrying its precomputed satisfaction state. */
export const ObligationSchema = z
  .object({
    id: z.string(),
    state: ObligationStateSchema,
    reason: z.string().optional(),
  })
  .strict();
export type Obligation = z.infer<typeof ObligationSchema>;

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
    if (item && isActionableObligationState(item.state)) {
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
 * Headroom between a consumer's own GRACEFUL step cap and the engine bound
 * derived from it. Stated HERE, once, because the relationship between the two
 * numbers is a property of the engine's contract, not of any one consumer: a
 * consumer that stops its fold at its own cap must be able to prove the engine
 * bound cannot fire first, and it can only do that if the two are derived from
 * a single formulation rather than written independently.
 *
 * The value is the slack the engine needs to observe a consumer's final,
 * cap-spending step and the emit that follows it.
 */
export const ENGINE_TRANSITION_HEADROOM = 2;

/**
 * The engine bound DERIVED from a consumer's graceful cap — the second half of
 * the bounded-call invariant this module owns.
 *
 * Consumers call this instead of restating a constant, so raising a graceful
 * cap can never silently push the fold past the engine bound: there is no
 * second number anywhere to remember to re-derive.
 */
export function deriveEngineBound(cap: number): number {
  return cap + ENGINE_TRANSITION_HEADROOM;
}

/**
 * The outcome of an `advance` run.
 *
 * - `step` non-null → an obligation emitted a host-actionable step; `state` is the
 *   state to persist alongside it.
 * - `step` null, `stopped` undefined → no obligation is actionable: the run is
 *   complete.
 * - `step` null, `stopped: "cycle"` → a transition revisited an already-seen state
 *   signature, so the fold is not converging; the caller surfaces a graceful
 *   terminal rather than looping. Only possible when `opts.stateSignature` is
 *   supplied.
 * - `step` null, `stopped: "bound"` → the fold spent `maxTransitions`
 *   transitions without reaching an emit or completion. Also non-convergence,
 *   detected by counting rather than by signature.
 * - `step` null, `stopped: "budget"` → the fold spent `maxExecutions` charged
 *   obligation executions. This is NOT non-convergence: the budget is a pacing
 *   cap, the stop is graceful, and the caller resumes the fold on its next
 *   call. Only possible when `opts.maxExecutions` is supplied.
 *
 * `stopped` being ABSENT is what means "the run is complete". A caller that
 * branches on `step` alone therefore cannot tell completion from
 * non-convergence, and would report a wedged fold as a finished one — so every
 * stopped value must be handled explicitly. `lastObligationId` names the
 * obligation the fold was executing (or, for `budget`, about to execute) when
 * it stopped, so a caller can say WHICH obligation is in flight without
 * parsing it out of a message.
 */
export interface AdvanceResult<S, Step> {
  state: S;
  step: Step | null;
  stopped?: "cycle" | "bound" | "budget";
  /** The obligation in flight when `stopped` was set; absent otherwise. */
  lastObligationId?: string;
  /**
   * The numeric limit that fired — `maxTransitions` for `bound`,
   * `maxExecutions` for `budget`; absent for `cycle` (no number fired). Carried
   * ON the result so `describeStoppedFold` reports the number that actually
   * stopped the fold, and no caller has to know which of two limits to restate.
   */
  stoppedBound?: number;
  /**
   * Charged obligation executions this call spent (the unit `maxExecutions`
   * caps). Carried on every outcome so a caller can RECORD the spend — the
   * CX-02 hold-time measurement reads it — without re-counting dispatches
   * against a second counter that could drift from the engine's own.
   */
  executions: number;
}

/**
 * A stop, described once for every draw that can hit one. `cycle` and `bound`
 * are non-convergence; `budget` is the graceful pacing cap — a caller that
 * expects the cap should branch on `stopped === "budget"` BEFORE reaching for
 * this description, and build its own resumable pause from its accumulators.
 * The description exists so a caller that does NOT special-case the budget
 * still reports the stop honestly rather than as a finished run.
 */
export interface StoppedFoldDescription {
  /** Which backstop fired, carried through so a caller need not re-read it. */
  stopped: "cycle" | "bound" | "budget";
  /**
   * The obligation in flight when the fold stopped, or `"unknown"` when it
   * stopped before selecting one. Never parsed out of prose.
   */
  spinning: string;
  /** A clause completing "the fold …", in the caller's own bound terms. */
  cause: string;
}

/**
 * Describe a non-convergent stop — the ONE home for that description.
 *
 * Returning `null` for a converged outcome is the load-bearing half. The
 * contract on `AdvanceResult` is that ABSENT `stopped` means completion, so a
 * caller branching on `step` alone cannot tell a finished run from a wedged one
 * and reports the wedge as finished. Routing through this function makes the
 * null-check itself the branch: there is no way to consume the description
 * without having asked the question.
 *
 * The number reported is `outcome.stoppedBound` — the limit that actually
 * fired, carried on the result by the engine itself. `opts.bound` remains as
 * the fallback for callers describing an outcome from an engine that did not
 * stamp one, so the number a host reads is still never a restated constant.
 *
 * `cause` is prose for a human terminal ONLY. Never match it: `stopped` and
 * `spinning` are the machine-readable fields, and recognizing a wedged fold by
 * its message text is the divergence this module's bounded-call invariant bans.
 */
export function describeStoppedFold(
  outcome: Pick<
    AdvanceResult<unknown, unknown>,
    "stopped" | "lastObligationId" | "stoppedBound"
  >,
  opts?: { bound?: number },
): StoppedFoldDescription | null {
  if (!outcome.stopped) return null;
  const bound = outcome.stoppedBound ?? opts?.bound ?? DEFAULT_MAX_TRANSITIONS;
  const cause =
    outcome.stopped === "bound"
      ? `spent the engine transition bound (${String(bound)}) without reaching a host-actionable step`
      : outcome.stopped === "budget"
        ? `spent its charged-execution budget (${String(bound)}) and pauses resumably at the cap`
        : "revisited a state it had already scanned this run";
  return {
    stopped: outcome.stopped,
    spinning: outcome.lastObligationId ?? "unknown",
    cause,
  };
}

/**
 * Drive the engine from `state`: repeatedly select the highest-priority actionable
 * obligation and execute it. A `transition` outcome advances the state and the
 * loop re-scans within the same call (one host round-trip can fold through several
 * transitions); an `emit` outcome stops the loop and returns the host-actionable
 * step. When no obligation is actionable the run is complete and `step` is `null`.
 *
 * **Cycle termination.** A transition obligation that never clears its own
 * actionable state would loop forever. Two backstops:
 * - `opts.stateSignature(state)` (preferred) records the signature of every state
 *   the loop scans from; a transition landing on an already-seen signature —
 *   including a *no-progress* transition that leaves the signature unchanged, or a
 *   multi-obligation A→B→A state cycle — stops the loop with `stopped: "cycle"`.
 *   This is the precise cycle condition ("a transition revisited a state already
 *   scanned this run") that the blunt count only approximates, and it terminates
 *   *gracefully* (the caller renders a terminal) instead of throwing. It also
 *   handles non-monotonic folds (e.g. audit-code's selective deepening grows the
 *   work-set before it shrinks): each distinct round is a new signature, so only a
 *   genuine revisit stops it.
 * - `maxTransitions` is the absolute backstop for callers that supply no
 *   signature — it stops the loop with `stopped: "bound"` after that many
 *   consecutive transitions.
 *
 * **Execution budget.** `opts.maxExecutions` is the consumer-facing pacing cap
 * (PH-03: a budget stop the result expresses structurally, so no caller wraps
 * the engine in a second drain to enforce one). The engine charges EVERY
 * `obligation.execute` call to it, spend-before-dispatch: once the budget is
 * spent, the next selected obligation is NOT executed and the loop returns
 * `stopped: "budget"` naming it. Because every transition follows a charged
 * execution, `transitions <= charged executions` holds by construction — so a
 * `maxTransitions` derived via {@link deriveEngineBound} from the same cap can
 * never fire first, which is the bounded-call invariant this module owns. An
 * `emit` spends its charge and returns normally; it is never converted into a
 * budget stop.
 *
 * ALL backstops terminate GRACEFULLY. The bound used to throw, which forced
 * every consumer to recognize a wedged fold by matching text in an error
 * message and to recover the spinning obligation's id with a regex over that
 * same prose — so the engine's bound was part of its contract while its only
 * signal was a sentence. A structured stop lets a consumer pause resumably at
 * the bound the way it already pauses for any other non-actionable outcome.
 *
 * `emit` and natural completion both terminate the loop and are never bounded.
 *
 * This is a strict generalization of the bare scan: an engine whose obligations
 * only ever `emit` stops after exactly one unit (audit-code's emit-only,
 * host-looped contract); `transition` outcomes add the in-call folding both
 * orchestrators use to avoid host round-trips on deterministic pass-throughs.
 */
export async function advance<S, Ctx, Step>(
  engine: ObligationEngine<S, Ctx, Step>,
  state: S,
  ctx: Ctx,
  opts?: {
    maxTransitions?: number;
    stateSignature?: (state: S) => string;
    maxExecutions?: number;
  },
): Promise<AdvanceResult<S, Step>> {
  const maxTransitions = opts?.maxTransitions ?? DEFAULT_MAX_TRANSITIONS;
  const maxExecutions = opts?.maxExecutions;
  const stateSignature = opts?.stateSignature;
  const visited = stateSignature ? new Set<string>() : null;
  let current = state;
  let transitions = 0;
  let executions = 0;
  // The obligation most recently selected — reported on every non-convergent
  // stop so the caller can name what is spinning.
  let lastObligationId: string | null = null;
  for (;;) {
    if (visited) {
      const signature = stateSignature!(current);
      if (visited.has(signature)) {
        // A transition revisited a state already scanned this run — the fold is
        // not converging (a no-progress step that left the signature unchanged,
        // or a multi-obligation state cycle). Stop gracefully; the caller renders
        // a terminal rather than throwing.
        return {
          state: current,
          step: null,
          stopped: "cycle",
          executions,
          ...(lastObligationId === null ? {} : { lastObligationId }),
        };
      }
      visited.add(signature);
    }
    const obligation = findNextObligation(
      engine.priority,
      engine.obligations,
      current,
    );
    if (!obligation) return { state: current, step: null, executions };
    lastObligationId = obligation.id;
    if (maxExecutions !== undefined && executions >= maxExecutions) {
      // The budget is spent and another obligation is still actionable. Spend-
      // before-dispatch: the selected obligation is NOT executed — a cap stated
      // as a maximum must never authorize one step past itself. Graceful and
      // resumable; the next call re-selects this same obligation.
      return {
        state: current,
        step: null,
        stopped: "budget",
        lastObligationId,
        stoppedBound: maxExecutions,
        executions,
      };
    }
    executions += 1;
    const outcome = await obligation.execute(current, ctx);
    if (outcome.kind === "emit") {
      return { state: outcome.state ?? current, step: outcome.step, executions };
    }
    current = outcome.state;
    if (++transitions > maxTransitions) {
      // The fold spent its whole bound without reaching an emit or completion —
      // a transition obligation is not clearing its own actionable state. This
      // returns rather than throws (see the doc comment): the caller pauses
      // resumably and names `lastObligationId`, instead of recognizing the
      // condition by matching text in an exception.
      return {
        state: current,
        step: null,
        stopped: "bound",
        lastObligationId,
        stoppedBound: maxTransitions,
        executions,
      };
    }
  }
}
