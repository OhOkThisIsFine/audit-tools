import type { Finding } from "../types.js";
import type { Ceiling } from "audit-tools/shared";
import type { AggregateMetricsDigest } from "../systemic/metricsDigestTypes.js";

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
   * True once the required number of CONSECUTIVE rounds surfaced nothing new
   * (the loop terminated) — see `convergence_rule` for the applied count.
   */
  converged: boolean;
  /**
   * The convergence rule the enforcement half applied: the loop terminates
   * only after `quiet_rounds_required` CONSECUTIVE dry rounds (owner decision
   * 2026-08-28 — one dry round let a single duplicate submission terminate the
   * adversary loop permanently). Optional because registers written before the
   * rule existed do not carry it; every current writer records it.
   */
  convergence_rule?: { quiet_rounds_required: number };
  /** Every distinct improvement finding surfaced, carrying its TRUE lens. */
  findings: Finding[];
  /** Gate/assembly notes (e.g. a round dropped an ungrounded finding) — surfaced. */
  validation_issues: string[];
}
