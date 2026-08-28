import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type {
  SystemicChallengeRegister,
  SystemicChallengeRound,
} from "../types/systemicChallenge.js";
import type { Ceiling, SystemicChallengeSubmission } from "audit-tools/shared";
import { resolveCharterCeiling, ceilingRequestsCharters } from "./charterExtractionExecutor.js";
import { aggregateMetricsDigest } from "../systemic/aggregateMetricsDigest.js";
import { foldChallengeRound } from "../systemic/systemicChallengeLoop.js";

/**
 * Convergence rule: the loop terminates only after this many CONSECUTIVE quiet
 * (dry) rounds. Owner decision 2026-08-28: under a one-round rule, a single
 * re-consumed or duplicate submission reports a dry round and terminates the
 * adversary loop permanently — durable submission staging is the class fix
 * (CX-02 blocker 3); two consecutive quiet rounds remove the single-event
 * trigger. Cost accepted: one extra adversary round per audit. The applied
 * rule is recorded on the register (`convergence_rule`) so the artifact is
 * self-describing.
 */
const QUIET_ROUNDS_TO_CONVERGE = 2;

function appliedConvergenceRule(): NonNullable<
  SystemicChallengeRegister["convergence_rule"]
> {
  return { quiet_rounds_required: QUIET_ROUNDS_TO_CONVERGE };
}

function omittedRegister(ceiling: Ceiling, generated_at: string): SystemicChallengeRegister {
  return {
    generated_at,
    target: "systemic_challenge",
    ceiling,
    status: "omitted",
    rounds: [],
    converged: true,
    convergence_rule: appliedConvergenceRule(),
    findings: [],
    validation_issues: [],
  };
}

/**
 * Systemic improvement-seeking challenge executor (Phase E). Deterministic
 * ENFORCEMENT half of the loop-until-dry pass — the second-order adversary's JUDGMENT
 * (the improvement findings) arrives as a host submission; this executor grounds,
 * dedupes-across-rounds, ranks, and decides convergence (design of record
 * spec/conceptual-design-review-design.md §"Convergence (loop-until-dry)"). Two modes,
 * gated by the ceiling:
 *
 * - **omit** (`shallow` ceiling / no charter layer requested): write an empty
 *   `status:omitted` register so the obligation is satisfied with no host turn (the
 *   conversation-first default; mirrors the charter-clarification omit).
 * - **run** (`deep`/`deepest` ceiling): assemble the metrics digest and fold each
 *   submitted challenge round into the register. An EMPTY submission (a round that
 *   surfaced nothing new) is a QUIET round; the register marks `converged` only
 *   after {@link QUIET_ROUNDS_TO_CONVERGE} CONSECUTIVE quiet rounds. A non-empty
 *   submission appends a round and keeps the loop open for the next round.
 *
 * The first run (no submission yet) computes the digest and writes an OPEN register
 * (converged:false) so the relay step can dispatch the adversary; each subsequent run
 * with a submission folds a round.
 */
export function runSystemicChallengeExecutor(
  bundle: ArtifactBundle,
  submission?: SystemicChallengeSubmission,
): ExecutorRunResult {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  const generated_at = new Date().toISOString();

  if (!ceilingRequestsCharters(ceiling)) {
    const omitted = omittedRegister(ceiling, generated_at);
    return {
      updated: { ...bundle, systemic_challenge: omitted },
      artifacts_written: ["systemic_challenge.json"],
      progress_summary: `Systemic challenge omitted (ceiling '${ceiling.rung}' does not request the systemic layer).`,
    };
  }

  const metrics = aggregateMetricsDigest(bundle);
  const prior = bundle.systemic_challenge;
  const priorFindings = prior?.findings ?? [];
  const priorRounds = prior?.rounds ?? [];

  // No submission this turn: (re)compute the digest and leave the loop OPEN so the
  // relay step can dispatch the second-order adversary. The prior findings/rounds
  // carry forward unchanged (idempotent — re-running never loses a round).
  if (!submission) {
    const register: SystemicChallengeRegister = {
      generated_at,
      target: "systemic_challenge",
      ceiling,
      metrics,
      rounds: priorRounds,
      converged: false,
      convergence_rule: appliedConvergenceRule(),
      findings: priorFindings,
      validation_issues: prior?.validation_issues ?? [],
    };
    return {
      updated: { ...bundle, systemic_challenge: register },
      artifacts_written: ["systemic_challenge.json"],
      progress_summary:
        `Systemic challenge loop open: ${priorFindings.length} improvement(s) so far, ` +
        `${priorRounds.length} round(s) run — awaiting the next adversary round.`,
    };
  }

  // A submission is present: fold this challenge round.
  const folded = foldChallengeRound({
    prior: priorFindings,
    submitted: submission.findings,
    goalGraph: bundle.charter_register?.goal_graph,
    repoManifest: bundle.repo_manifest,
  });

  const round: SystemicChallengeRound = {
    round: priorRounds.length + 1,
    new_finding_ids: folded.new_finding_ids,
    dry: folded.dry,
  };
  const rounds = [...priorRounds, round];
  // CONSECUTIVE-QUIET convergence: the loop terminates only when the last
  // QUIET_ROUNDS_TO_CONVERGE rounds were ALL dry. Derived from the persisted
  // rounds themselves — no separate counter state to drift.
  const converged =
    rounds.length >= QUIET_ROUNDS_TO_CONVERGE &&
    rounds.slice(-QUIET_ROUNDS_TO_CONVERGE).every((r) => r.dry);
  const register: SystemicChallengeRegister = {
    generated_at,
    target: "systemic_challenge",
    ceiling,
    metrics,
    rounds,
    converged,
    convergence_rule: appliedConvergenceRule(),
    findings: folded.findings,
    validation_issues: [
      ...(prior?.validation_issues ?? []),
      ...folded.validation_issues,
    ],
  };
  return {
    updated: { ...bundle, systemic_challenge: register },
    artifacts_written: ["systemic_challenge.json"],
    progress_summary:
      `Systemic challenge round ${round.round}: ${folded.new_finding_ids.length} new improvement(s)` +
      (converged
        ? ` — nothing new for ${QUIET_ROUNDS_TO_CONVERGE} consecutive rounds, loop converged.`
        : folded.dry
          ? " — quiet round; the loop converges after the next consecutive quiet round."
          : `, ${folded.findings.length} total; loop continues.`),
  };
}
