/**
 * The measured-outcome vocabulary — the ONE word set for "what did this
 * measurement actually produce".
 *
 * WHY IT EXISTS. Three separate channels answered that question with a
 * SUCCESS-PREDICATE OVER A POSSIBLY-EMPTY OR POSSIBLY-PARTIAL SET, and each one
 * therefore reported an absence as a success: `applied = analyzersUsed.length > 0`
 * called a run applied while two requested analyzers had failed;
 * `runtimeReady = tasks.length === 0 || …` called a gate satisfied with nothing
 * to check; a lane that exited 0 having written nothing left no row at all. The
 * shape is identical in all three, so the vocabulary is single-sourced here
 * rather than re-spelled per channel.
 *
 * THE GUARANTEE IS STRUCTURAL. Every question below is an exhaustive `Record`
 * over {@link MEASURED_OUTCOMES}, so widening the tuple without answering all
 * three is a COMPILE error — the guarantee
 * `EXTERNAL_ANALYZER_STATUS_CLASSIFICATION` already delivered for one channel,
 * now one level up and shared by all of them. That guarantee reaches THIS
 * module's tables and no further: a consumer that stores an outcome in a
 * `Set<MeasuredOutcome>` or a hand-written `z.enum([...])` still accepts a
 * widened union silently, which is why such consumers derive from the tuple
 * instead of restating it.
 *
 * TWO QUESTIONS, NOT ONE BOOLEAN. `not_applicable` answers them differently:
 * nothing was lost, *and* nothing was owed. Collapsing them would force it to
 * read as either "fine" or "coverage lost", and both are false.
 */
import { z } from "zod";

/**
 * The closed outcome tuple every binding speaks. The zod enum below is BUILT
 * from it, so there is exactly one place a member is added.
 *
 * - `clean` — the measurement ran and produced nothing. The ONLY value that may
 *   be read as "asked, and there was nothing there".
 * - `findings` — the measurement ran and produced something.
 * - `degraded` — it ran, but its output cannot be trusted as coverage.
 * - `not_run` — no coverage was produced at all, though some was owed.
 * - `not_applicable` — there was nothing to measure; none was owed.
 */
export const MEASURED_OUTCOMES = [
  "clean",
  "findings",
  "degraded",
  "not_run",
  "not_applicable",
] as const;

export const MeasuredOutcomeSchema = z.enum(MEASURED_OUTCOMES);
export type MeasuredOutcome = (typeof MEASURED_OUTCOMES)[number];

/** Did this measurement LOSE coverage that was owed? */
const OUTCOME_LOST_COVERAGE: Record<MeasuredOutcome, boolean> = {
  clean: false,
  findings: false,
  degraded: true,
  not_run: true,
  // Nothing was owed, so nothing was lost. This is the member the older
  // four-value coverage vocabulary had no room for.
  not_applicable: false,
};

/**
 * True when an outcome means coverage that was owed did not arrive. The single
 * member-level answer, so no consumer re-types `=== "degraded" || === "not_run"`.
 */
export function outcomeLostCoverage(outcome: MeasuredOutcome): boolean {
  return OUTCOME_LOST_COVERAGE[outcome];
}

/** Was there anything to measure at all? The abstention question, asked separately. */
const OUTCOME_IS_APPLICABLE: Record<MeasuredOutcome, boolean> = {
  clean: true,
  findings: true,
  degraded: true,
  not_run: true,
  not_applicable: false,
};

/**
 * True when the measurement had an input set at all. A consumer deciding
 * whether to REPORT a gap asks this; one deciding whether coverage was lost
 * asks {@link outcomeLostCoverage}.
 */
export function outcomeIsApplicable(outcome: MeasuredOutcome): boolean {
  return OUTCOME_IS_APPLICABLE[outcome];
}

/**
 * Worst-first precedence for rolling a set of entry outcomes into one scalar.
 * Ordered by how much a reader needs to know about it: a degraded measurement
 * outranks a missing one (it produced output that looks like coverage and is
 * not), which outranks a productive one, which outranks an empty one, which
 * outranks "there was nothing to measure".
 */
const OUTCOME_SEVERITY: Record<MeasuredOutcome, number> = {
  degraded: 4,
  not_run: 3,
  findings: 2,
  clean: 1,
  not_applicable: 0,
};

/**
 * Roll a set of outcomes into the one a reader must be told about. An EMPTY set
 * is `not_applicable` — there was nothing to measure — never `clean`, which
 * would be the same success-shaped-empty answer this vocabulary exists to
 * remove. A max, so the result never depends on the caller's ordering.
 */
export function worstMeasuredOutcome(
  outcomes: readonly MeasuredOutcome[],
): MeasuredOutcome {
  let worst: MeasuredOutcome = "not_applicable";
  for (const outcome of outcomes) {
    if (OUTCOME_SEVERITY[outcome] > OUTCOME_SEVERITY[worst]) worst = outcome;
  }
  return worst;
}
