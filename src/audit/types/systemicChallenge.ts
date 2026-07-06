import type { Finding } from "../types.js";
import type { Ceiling } from "audit-tools/shared";
import type { AggregateMetricsDigest } from "../systemic/metricsDigestTypes.js";

/**
 * The `systemic_challenge.json` artifact — Phase E of the conceptual design-review:
 * the SYSTEMIC IMPROVEMENT-SEEKING CHALLENGE LOOP. A second-order adversary (a
 * SEPARATE agent — [[delegate-adversarial-phases-to-separate-agent]]) re-interrogates
 * the whole system with human-grade pressure and folds newly-surfaced improvements
 * back in, LOOP-UNTIL-DRY: the pass is done only when a challenge round yields
 * NOTHING NEW, not when it first has an answer (design of record
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
 * Each host-delegation round appends to `rounds`; a round that returns zero new
 * findings sets `converged:true` and terminates the loop. `findings` are every
 * distinct improvement surfaced across rounds — carrying their TRUE lens (a
 * test-parallelization finding is `tests`/`performance`, an ops finding is
 * `operability`), NEVER a hardcoded `architecture` tag.
 */
export interface SystemicChallengeRound {
  /** 1-based round ordinal (the Nth loop-until-dry challenge). */
  round: number;
  /** Distinct finding ids this round surfaced that no prior round had. */
  new_finding_ids: string[];
  /** Whether this round yielded nothing new (the loop-until-dry terminator). */
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
  /** The loop-until-dry challenge rounds, in order; the last one is `dry`. */
  rounds: SystemicChallengeRound[];
  /** True once a challenge round surfaced nothing new (the loop terminated). */
  converged: boolean;
  /** Every distinct improvement finding surfaced, carrying its TRUE lens. */
  findings: Finding[];
  /** Gate/assembly notes (e.g. a round dropped an ungrounded finding) — surfaced. */
  validation_issues: string[];
}
