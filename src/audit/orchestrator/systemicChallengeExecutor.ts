import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type {
  SystemicChallengeRegister,
  SystemicChallengeRound,
} from "../types/systemicChallenge.js";
import type {
  Ceiling,
  SystemicChallengeStop,
  SystemicChallengeSubmission,
} from "audit-tools/shared";
import { hashContent, stableStringify } from "audit-tools/shared";
import { hashArtifactValue } from "../../shared/artifactFreshness.js";
import { resolveCharterCeiling, ceilingRequestsCharters } from "./charterExtractionExecutor.js";
import { aggregateMetricsDigest } from "../systemic/aggregateMetricsDigest.js";
import {
  SYSTEMIC_ROUND_CEILING,
  foldChallengeRound,
} from "../systemic/systemicChallengeLoop.js";
import { summarizeCoveredThemes } from "../systemic/coveredThemes.js";

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
  return {
    quiet_rounds_required: QUIET_ROUNDS_TO_CONVERGE,
    round_ceiling: SYSTEMIC_ROUND_CEILING,
  };
}

/**
 * The PREMISE token: a digest of the upstream artifacts the loop reasons over,
 * as they stand this run — the same four `systemic_challenge.json` depends on.
 *
 * This is what binds a loop to its premise. Rounds and banked findings carry
 * forward WITHIN a run (that is the loop), and a re-emission of an unchanged
 * premise reproduces this token byte-for-byte; a run whose premise differs —
 * a different repository, a re-audit after the charter layer changed — starts a
 * FRESH loop. Without it, the register's `rounds` and `findings` persisted in
 * the artifacts dir and the next run opened at "round 10" with 11 improvements
 * it never surfaced (re-dogfood 2026-07-21).
 *
 * Derived from CONTENT under each artifact's own canonical hash — the same
 * non-semantic stripping the metadata manifest uses — so provenance stamps
 * (`generated_at`) and key order cannot mint a new run.
 */
function systemicPremiseToken(bundle: ArtifactBundle): string {
  // The adjudication is projected here rather than hashed as it stands: the
  // metadata manifest's non-semantic table does not strip `generated_at` for
  // `conceptual_review_adjudication.json`, so an identical adjudication
  // re-emitted with a fresh stamp would hash differently and open a FRESH loop
  // — exactly the churn this token exists to prevent. The projection is
  // built from the fields that carry meaning, so a field added to the interface
  // and not named here is dropped rather than silently made semantic.
  const adjudication = bundle.conceptual_review_adjudication;
  const semanticAdjudication = adjudication
    ? {
        schema_version: adjudication.schema_version,
        round_id: adjudication.round_id,
        contributors: adjudication.contributors,
        candidate_dispositions: adjudication.candidate_dispositions,
        final_finding_shares: adjudication.final_finding_shares,
        candidate_disposition_breakdown:
          adjudication.candidate_disposition_breakdown,
        candidate_verification_status_breakdown:
          adjudication.candidate_verification_status_breakdown,
      }
    : adjudication;
  const premise: ReadonlyArray<[artifact: string, payload: unknown]> = [
    ["charter_register.json", bundle.charter_register],
    ["conceptual_review_adjudication.json", semanticAdjudication],
    ["intent_checkpoint.json", bundle.intent_checkpoint],
    ["repo_manifest.json", bundle.repo_manifest],
  ];
  const parts = premise.map(([artifact, payload]) =>
    payload === undefined || payload === null
      ? `${artifact}:absent`
      : `${artifact}:${hashArtifactValue(artifact, payload)}`,
  );
  return hashContent(stableStringify(parts), { length: 12 });
}

function omittedRegister(ceiling: Ceiling, generated_at: string): SystemicChallengeRegister {
  return {
    generated_at,
    target: "systemic_challenge",
    ceiling,
    status: "omitted",
    rounds: [],
    converged: true,
    stop_reason: "converged",
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
 *   after {@link QUIET_ROUNDS_TO_CONVERGE} CONSECUTIVE quiet rounds.
 *
 * A round ends the loop when it demonstrably went dry (two consecutive quiet rounds —
 * `stop_reason: "converged"`), when the submission carries a host-forced stop
 * (`"host_forced"`), or when it reaches {@link SYSTEMIC_ROUND_CEILING} without ever
 * having gone dry (`"round_ceiling"`, never a silent or fabricated dry one). The
 * endings are ranked in that order, because a ceiling round that IS the second
 * consecutive quiet one converged on a real signal and reporting it as a budget stop
 * would say the loop never demonstrated one.
 *
 * The loop lives inside one RUN. Its rounds, banked findings and premise token are
 * carried forward only while {@link systemicPremiseToken} matches what the register
 * was opened against; a different premise opens a fresh loop (see that function).
 *
 * The first run (no submission yet) computes the digest and writes an OPEN register
 * (converged:false) so the relay step can dispatch the adversary; each subsequent run
 * with a submission folds a round.
 */
export function runSystemicChallengeExecutor(
  bundle: ArtifactBundle,
  submission?: SystemicChallengeSubmission,
  submissionHash?: string,
): ExecutorRunResult {
  const ceiling = resolveCharterCeiling(bundle.intent_checkpoint);
  const generated_at = new Date().toISOString();

  // Iterative-fold duplicate guard (CX-02 landing 3): a submission whose
  // round-bound content hash the register already folded is IGNORED — never folded again,
  // and above all never counted as a quiet round, which is what would converge
  // the adversary loop falsely and permanently. Reachable when a crash between
  // the fold's core commit and its staged-submission cleanup restores an
  // already-folded submission.
  if (
    submission &&
    submissionHash &&
    bundle.systemic_challenge?.folded_submission_hashes?.includes(submissionHash)
  ) {
    return {
      updated: { ...bundle },
      artifacts_written: ["systemic_challenge.json"],
      progress_summary:
        "Systemic challenge: duplicate round submission ignored (its content hash is already folded into the register).",
    };
  }

  if (!ceilingRequestsCharters(ceiling)) {
    const omitted = omittedRegister(ceiling, generated_at);
    return {
      updated: { ...bundle, systemic_challenge: omitted },
      artifacts_written: ["systemic_challenge.json"],
      progress_summary: `Systemic challenge omitted (ceiling '${ceiling.rung}' does not request the systemic layer).`,
    };
  }

  const metrics = aggregateMetricsDigest(bundle);
  const round_token = systemicPremiseToken(bundle);
  const carried = bundle.systemic_challenge;
  // A register opened against a DIFFERENT premise belongs to a different run:
  // its round counter and banked improvements must not present themselves as this
  // run's (re-dogfood 2026-07-21 — a run opened at "round 10" holding 11 findings
  // from earlier sessions). A register with NO token predates the binding, so it
  // carries as it always did — and that carry is the one-way migration: this run
  // stamps the token on the register it writes, so the same register can never
  // take the no-token branch twice. ONLY a differing token resets.
  const prior =
    carried?.round_token === undefined || carried.round_token === round_token
      ? carried
      : undefined;
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
      covered_themes: summarizeCoveredThemes(priorFindings),
      round_token,
      ...(prior?.folded_submission_hashes
        ? { folded_submission_hashes: prior.folded_submission_hashes }
        : {}),
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
  const roundNumber = priorRounds.length + 1;
  const folded = foldChallengeRound({
    prior: priorFindings,
    submitted: submission.findings,
    round: roundNumber,
    goalGraph: bundle.charter_register?.goal_graph,
    repoManifest: bundle.repo_manifest,
  });

  const round: SystemicChallengeRound = {
    round: roundNumber,
    new_finding_ids: folded.new_finding_ids,
    dry: folded.dry,
  };
  const rounds = [...priorRounds, round];
  const foldedHashes = submissionHash
    ? [...(prior?.folded_submission_hashes ?? []), submissionHash]
    : prior?.folded_submission_hashes;
  // CONSECUTIVE-QUIET convergence: the loop terminates only when the last
  // QUIET_ROUNDS_TO_CONVERGE rounds were ALL dry. Derived from the persisted
  // rounds themselves — no separate counter state to drift.
  const convergedOnQuiet =
    rounds.length >= QUIET_ROUNDS_TO_CONVERGE &&
    rounds.slice(-QUIET_ROUNDS_TO_CONVERGE).every((r) => r.dry);
  // The endings, each recorded as what it is, in precedence order. A host-forced
  // stop is the host saying so and outranks everything. A DEMONSTRATED dry
  // convergence outranks the ceiling: a ceiling round whose fold happened to be
  // the second consecutive quiet one converged on a real signal, and reporting
  // it as a budget stop states a falsehood about why the loop ended (the
  // ceiling's own wording — "the loop ends here, not on a demonstrated dry
  // signal" — would be affirmatively wrong). The ceiling is the LAST resort,
  // for the loop that ran out of rounds without ever going dry. An already
  // recorded reason survives a later round's fold, so the loop stays ended.
  const ceilingReached = rounds.length >= SYSTEMIC_ROUND_CEILING;
  const hostForced = submission.stop?.forced === true;
  const effectiveStop: SystemicChallengeStop | undefined = hostForced
    ? submission.stop
    : undefined;
  const priorStopReason =
    prior?.converged === true ? prior.stop_reason : undefined;
  const stop_reason: SystemicChallengeRegister["stop_reason"] =
    priorStopReason ??
    (hostForced
      ? "host_forced"
      : convergedOnQuiet
        ? "converged"
        : ceilingReached
          ? "round_ceiling"
          : undefined);
  const converged = stop_reason !== undefined;
  // Which round the reason came from — THIS one, or an earlier one the register
  // already recorded. Read off the branch that produced it, never re-derived
  // from the ending's shape.
  const stopRecordedThisRound = priorStopReason === undefined;

  /**
   * The note is derived from the RECORDED `stop_reason`, never re-derived from
   * this round's shape. Re-deriving let the summary say "loop converged" for a
   * register whose own `stop_reason` was `host_forced` — and in the plain case
   * (a forced stop carrying findings, then a quiet round) it claimed "nothing
   * new for 2 consecutive rounds" when exactly ONE round was dry and the loop had
   * in fact ended because the host said so. That is the fabricated dry signal
   * this whole change exists to remove, and the summary is the surface an
   * operator reads without opening the artifact.
   *
   * `convergedOnQuiet` is still the gate on the convergence wording, so the note
   * never claims consecutive quiet rounds the persisted set does not show.
   */
  const stopNote =
    stop_reason === "host_forced"
      ? effectiveStop
        ? ` — host-forced stop recorded (${effectiveStop.reason}).`
        : " — host-forced stop recorded in an earlier round; the loop stays ended."
      : stop_reason === "round_ceiling" && ceilingReached && !convergedOnQuiet
        ? ` — round ceiling reached (${SYSTEMIC_ROUND_CEILING}); the loop ends here, not on a demonstrated dry signal.`
        : convergedOnQuiet
          ? ` — nothing new for ${QUIET_ROUNDS_TO_CONVERGE} consecutive rounds, loop converged.`
          : stop_reason === "round_ceiling"
            ? " — the loop stays ended on the round ceiling recorded in an earlier round."
            : stopRecordedThisRound
              ? null
              : " — the loop stays ended on the stop an earlier round recorded.";

  const register: SystemicChallengeRegister = {
    generated_at,
    target: "systemic_challenge",
    ceiling,
    metrics,
    rounds,
    covered_themes: summarizeCoveredThemes(folded.findings),
    round_token,
    ...(foldedHashes ? { folded_submission_hashes: foldedHashes } : {}),
    converged,
    ...(stop_reason ? { stop_reason } : {}),
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
      (stopNote ??
        (folded.dry
          ? " — quiet round; the loop converges after the next consecutive quiet round."
          : `, ${folded.findings.length} total; loop continues.`)),
  };
}
