import type { Finding } from "../types.js";
import type { Ceiling } from "audit-tools/shared";
import type { AggregateMetricsDigest } from "../systemic/metricsDigestTypes.js";
import type { SystemicCoveredThemes } from "../systemic/coveredThemes.js";

/**
 * The `systemic_challenge.json` artifact — Phase E of the conceptual design-review:
 * the SYSTEMIC IMPROVEMENT-SEEKING CHALLENGE LOOP. A second-order adversary (a
 * SEPARATE agent — [[delegate-adversarial-phases-to-separate-agent]]) re-interrogates
 * the whole system with human-grade pressure and folds newly-surfaced improvements
 * back in, LOOP-UNTIL-DRY: the pass is done only when CONSECUTIVE challenge rounds
 * yield NOTHING NEW, not when it first has an answer (design of record
 * spec/conceptual-design-review-design.md §"Convergence (loop-until-dry)"; backlog
 * "Systemic reviewers must be pushed adversarially for improvement").
 *
 * The mandate is OPTIMIZATION / BETTER-WAY, not only defect-finding: the pass
 * actively seeks superior alternatives to things that currently WORK — the class no
 * correctness lens flags because nothing is broken (redundant, serial-that-could-be-
 * parallel, duplicated, over-built, an unquestioned assumption, a categorically
 * better approach).
 *
 * It is an OUTPUT artifact seeded from the intent checkpoint (ceiling) and the whole
 * upstream picture (repo_manifest / structure_decomposition / charter register).
 * `status:"omitted"` when the ceiling did not request the systemic layer (shallow —
 * the default), so the obligation is satisfied without a host turn.
 *
 * Each host-delegation round appends to `rounds`; the loop terminates
 * (`converged:true`) only after CONSECUTIVE rounds that return zero new
 * findings — the applied count is recorded in `convergence_rule`, so the
 * register is self-describing. `findings` are every
 * distinct improvement surfaced across rounds — carrying their TRUE lens (a
 * test-parallelization finding is `tests`/`performance`, an ops finding is
 * `operability`), NEVER a hardcoded `architecture` tag.
 */
export interface SystemicChallengeRound {
  /** 1-based round ordinal (the Nth loop-until-dry challenge). */
  round: number;
  /** Distinct finding ids this round surfaced that no prior round had. */
  new_finding_ids: string[];
  /**
   * Whether this round yielded nothing new (a QUIET round). One quiet round is
   * not the terminator on its own: convergence requires the consecutive count
   * the register's `convergence_rule` states.
   */
  dry: boolean;
}

export interface SystemicChallengeRegister {
  generated_at: string;
  /** The decomposition target — `"systemic_challenge"` at this layer. */
  target: "systemic_challenge";
  /**
   * The ceiling authorized at `intent_checkpoint` — echoed so the register is
   * self-describing about the depth that produced it.
   */
  ceiling: Ceiling;
  /**
   * `"omitted"` when the ceiling did not request the systemic layer (shallow — the
   * default) — the register is written empty so the obligation is satisfied without
   * a host turn (mirrors the charter-extraction / clarification omit).
   */
  status?: "omitted";
  /**
   * The language-neutral aggregate-metrics digest fed to the adversary as NECESSARY
   * supporting evidence — explicitly NOT sufficient alone (the adversary reasons
   * from the whole picture, not the counts). Absent on an omitted register.
   */
  metrics?: AggregateMetricsDigest;
  /** The loop-until-dry challenge rounds, in order. */
  rounds: SystemicChallengeRound[];
  /**
   * Round-bound content hashes of submissions already folded into this register — the
   * iterative-fold duplicate guard (CX-02 landing 3). A crash between the
   * fold's core commit and its staged-submission cleanup can restore an
   * already-folded submission for re-consumption; without this register a
   * re-fold of the identical round reports a QUIET round and can converge the
   * adversary loop falsely. A duplicate hash is ignored, never counted. The gate
   * binds each new digest to its lane so identical fresh quiet answers count as
   * distinct rounds; older recorded digests remain unchanged as provenance.
   */
  folded_submission_hashes?: string[];
  /**
   * True once the loop has ENDED — whatever ended it. The register's own
   * satisfaction signal (`state.ts`, `obligationPolicy.ts`): a register that has
   * not ended keeps the obligation unmet and the next round is dispatched.
   *
   * ⚠ It does NOT mean "converged on a dry signal", and it never did — an
   * omitted register (shallow ceiling) has been `converged: true` since the loop
   * landed. `stop_reason` states WHICH ending this was; a reader that needs to
   * know whether the adversary actually ran dry must read that, not this.
   */
  converged: boolean;
  /**
   * WHY the loop ended. `converged` says it ended; this says how, so a ceiling
   * stop or a host-forced stop can never be read as an exhaustion the loop did
   * not demonstrate (the no-ceiling entry: the loop's only exit was a dry signal
   * the host may have had to fabricate). Optional — registers written before
   * this existed carry only `converged`.
   */
  stop_reason?: "converged" | "round_ceiling" | "host_forced";
  /**
   * What the banked improvements already cover, summarized — the variation bar's
   * factual half, handed to the next round so it can name the axis it departs
   * on. Absent on an omitted register (nothing was ever banked).
   */
  covered_themes?: SystemicCoveredThemes;
  /**
   * The PREMISE this loop is running against: a digest of the upstream artifacts
   * (charter register / conceptual adjudication / intent checkpoint / repo
   * manifest — the same four the dependency map names) as they stood when the
   * loop opened.
   *
   * It binds the loop to its premise rather than to the artifacts directory. A
   * re-emission within a run sees the same token and carries its rounds forward;
   * a run whose premise differs starts a FRESH loop, so a round counter and a
   * banked set cannot silently carry across runs — the LEAD the re-dogfood
   * recorded (round 10, 11 improvements, none of them this run's).
   */
  round_token?: string;
  /**
   * The convergence rule the enforcement half applied: the loop terminates after
   * `quiet_rounds_required` CONSECUTIVE dry rounds (owner decision 2026-08-28 —
   * one dry round let a single duplicate submission terminate the adversary loop
   * permanently), and in any case at `round_ceiling` rounds. Optional because
   * registers written before the rule existed do not carry it; every current
   * writer records it.
   */
  convergence_rule?: { quiet_rounds_required: number; round_ceiling?: number };
  /** Every distinct improvement finding surfaced, carrying its TRUE lens. */
  findings: Finding[];
  /** Gate/assembly notes (e.g. a round dropped an ungrounded finding) — surfaced. */
  validation_issues: string[];
}
