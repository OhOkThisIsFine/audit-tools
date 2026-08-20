/**
 * The ONE table-driven step-emission scaffold, shared by both orchestrators.
 *
 * Both entry points used to hand-repeat the same four-part shape once per
 * branch — resolve the step's inputs, build a prompt, write the step contract,
 * log the written step and return — so a change to the emit contract had to be
 * applied in every branch by hand with no compiler signal when one was missed.
 * This module removes the repetition structurally: a branch contributes a
 * HANDLER that returns a PLAN (what to emit), and this scaffold owns the single
 * emission call site that turns a plan into a written, logged step exactly once.
 *
 * Shaped from the outset for BOTH shapes:
 *   • `emit(key, ctx)` — branch-per-step-key dispatch (the audit entry point's
 *     `result.kind` chain), with a fallback for a key the table does not carry;
 *   • `emitFirstApplicable(keys, ctx)` — the numbered early-return gates (the
 *     contract pipeline's shape): each gate handler returns a plan to emit, or
 *     `null` to fall through to the next gate, and the fallback closes the walk.
 * Both funnel through `emitPlan`, which no caller can bypass without adding a
 * second emission site — the thing the single-call-site test refuses.
 *
 * `handledKeys` is derived from the table's OWN KEYS, never a hand-listed
 * literal beside it, so a drift guard can import a real set instead of
 * reconstructing one by reflection over a branch chain.
 *
 * Provider/host/OS-agnostic: the scaffold knows nothing about what a step IS.
 * `write` and `log` are supplied by the adopting orchestrator, so the writer
 * (a step-contract writer, a blocked-step writer, a delegated renderer) and the
 * transport (stdout today) stay entirely on the adopter's side.
 */

/** Produce the plan for the step to emit. Never writes or logs — that is the scaffold's. */
export type StepEmissionHandler<TCtx, TPlan> = (ctx: TCtx) => TPlan | Promise<TPlan>;

/**
 * A gate handler: the plan to emit, or a DECLINE.
 *
 * THE DECLINE PREDICATE, stated once for both entry points: a handler declines
 * by returning `null` OR `undefined` (`plan == null`). Keyed dispatch and the
 * ordered gate walk read it identically — an `undefined`-returning handler must
 * not be treated as "emit nothing to write" by one and "decline" by the other.
 * A declining keyed handler falls through to the fallback; a declining gate
 * hands on to the next gate.
 */
export type StepGateHandler<TCtx, TPlan> = (
  ctx: TCtx,
) => TPlan | null | undefined | Promise<TPlan | null | undefined>;

export interface StepEmissionScaffold<TCtx, TPlan, TStep> {
  /** The table's own keys. Derived — never a second, hand-listed copy. */
  readonly handledKeys: ReadonlySet<string>;
  /** Dispatch one step key; an unhandled key (or a `null` plan) takes the fallback. */
  emit(key: string, ctx: TCtx): Promise<TStep>;
  /** Walk gates in order; the first non-`null` plan is emitted, else the fallback. */
  emitFirstApplicable(keys: readonly string[], ctx: TCtx): Promise<TStep>;
  /**
   * Emit a plan the table did not produce. For a path that runs BEFORE any step
   * key exists (a config-load failure that must still leave a fresh step
   * contract on disk): it is deliberately not a second emission site — it is
   * the same one, reached with a hand-built plan.
   */
  emitPlan(plan: TPlan): Promise<TStep>;
}

export interface StepEmissionScaffoldOptions<TCtx, TPlan, TStep> {
  /** Step key → handler. The key set IS the handled-kinds set. */
  table: Readonly<Record<string, StepGateHandler<TCtx, TPlan>>>;
  /** Reached when no row handled the key (or no gate applied). */
  fallback: StepEmissionHandler<TCtx, TPlan>;
  /** Turn a plan into the written step. The ONLY writer the scaffold calls. */
  write: (plan: TPlan) => TStep | Promise<TStep>;
  /** Announce the written step (stdout contract). Called exactly once per emission. */
  log: (step: TStep) => void;
}

export function createStepEmissionScaffold<TCtx, TPlan, TStep>(
  options: StepEmissionScaffoldOptions<TCtx, TPlan, TStep>,
): StepEmissionScaffold<TCtx, TPlan, TStep> {
  // Snapshotted at construction so a later mutation of the caller's object
  // cannot make the exported key set disagree with what `emit` dispatches on.
  //
  // NULL-PROTOTYPE, deliberately: a plain object would resolve `table["toString"]`
  // (and every other Object.prototype member) to an inherited function, so a step
  // key colliding with one would dispatch a built-in instead of taking the
  // fallback — `handledKeys` (real own keys) and dispatch would disagree, and the
  // unknown-gate refusal below would never fire for those names. Step keys are
  // data, and data must not be able to reach the prototype chain.
  const table: Record<string, StepGateHandler<TCtx, TPlan> | undefined> =
    Object.assign(Object.create(null), options.table);
  const handledKeys: ReadonlySet<string> = new Set(Object.keys(table));

  /**
   * THE single emission call site. Every public entry point funnels here, so
   * "written exactly once, logged exactly once" is a property of the scaffold
   * rather than of each adopter remembering to do both.
   */
  const emitPlan = async (plan: TPlan): Promise<TStep> => {
    const step = await options.write(plan);
    options.log(step);
    return step;
  };

  return {
    handledKeys,
    emitPlan,
    async emit(key, ctx) {
      const handler = table[key];
      const plan = handler ? await handler(ctx) : null;
      // Declines (null OR undefined) take the fallback — see StepGateHandler.
      return plan == null ? emitPlan(await options.fallback(ctx)) : emitPlan(plan);
    },
    async emitFirstApplicable(keys, ctx) {
      for (const key of keys) {
        const handler = table[key];
        if (!handler) {
          // A gate named in the walk order but absent from the table is a
          // configuration gap, not a step to skip: silently walking past it
          // would emit the fallback as if the gate had declined.
          throw new Error(
            `step-emission scaffold: gate "${key}" is not in the emission table (handled: ${[
              ...handledKeys,
            ]
              .sort()
              .join(", ")})`,
          );
        }
        const plan = await handler(ctx);
        // Same decline predicate as `emit` — see StepGateHandler.
        if (plan != null) return emitPlan(plan);
      }
      return emitPlan(await options.fallback(ctx));
    },
  };
}
