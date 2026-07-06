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

function omittedRegister(ceiling: Ceiling, generated_at: string): SystemicChallengeRegister {
  return {
    generated_at,
    target: "systemic_challenge",
    ceiling,
    status: "omitted",
    rounds: [],
    converged: true,
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
 *   surfaced nothing new) marks the register `converged` — the loop terminates. A
 *   non-empty submission appends a round and keeps the loop open for the next round.
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
  const register: SystemicChallengeRegister = {
    generated_at,
    target: "systemic_challenge",
    ceiling,
    metrics,
    rounds: [...priorRounds, round],
    // LOOP-UNTIL-DRY: converged only when this round surfaced nothing new.
    converged: folded.dry,
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
      (folded.dry
        ? " — nothing new, loop converged (dry)."
        : `, ${folded.findings.length} total; loop continues.`),
  };
}
