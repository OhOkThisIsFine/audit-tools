// Phase E — the SYSTEMIC IMPROVEMENT-SEEKING CHALLENGE LOOP (audit-side assembly).
//
// A second-order adversary (a SEPARATE agent) re-interrogates the whole system with
// human-grade pressure and folds newly-surfaced improvements back in, LOOP-UNTIL-DRY:
// done only when CONSECUTIVE challenge rounds yield NOTHING NEW — this module marks
// each round dry or not; the EXECUTOR decides convergence over the rounds register
// (design of record
// spec/conceptual-design-review-design.md §"Convergence (loop-until-dry)"). The
// mandate is OPTIMIZATION / BETTER-WAY — superior alternatives to things that
// currently work — not only defect-finding.
//
// This module is the DETERMINISTIC ENFORCEMENT half (the adversary's JUDGMENT is the
// findings it submits). It REUSES the Phase-D D1 pure primitives rather than
// reimplementing them: `goalBlastRadius` ranks a finding by how far up the goal DAG
// its improvement ripples, and the risk-gate threshold gates a high-blast improvement
// (a confident-but-wrong high-blast "better way" is catastrophic). It never forks the
// ranking substrate.
//
// The true-lens invariant: every surfaced finding keeps the lens the adversary tagged
// (`tests`/`performance` for a test-parallelization finding, `operability` for an ops
// finding), NEVER a hardcoded `architecture` label — the seam that lets synthesis
// route each improvement to its real lens.
//
// PURE + deterministic + language-neutral: no IO, no LLM.

import type { Finding } from "../types.js";
import type { GoalGraph } from "audit-tools/shared";
import { groundDesignFindings, findingReEmissionKey, compareCodeUnits } from "audit-tools/shared";
import { goalBlastRadius } from "../clarification/blastRadius.js";

/**
 * Resolve the blast radius of an improvement finding over the goal DAG. A finding
 * carrying a `node_id`-style goal linkage (its first affected component maps to a
 * goal node) ripples up to that node's parent closure; absent linkage it keeps its
 * own `blast_radius` if the adversary supplied one, else 0. Reuses the Phase-D
 * `goalBlastRadius` primitive — never a second implementation.
 */
function resolveBlastRadius(
  finding: Finding,
  goalGraph: GoalGraph | undefined,
  goalNodeOf: (finding: Finding) => string | undefined,
): number {
  const nodeId = goalNodeOf(finding);
  if (goalGraph && nodeId) {
    const graphed = goalBlastRadius(goalGraph, nodeId);
    return Math.max(graphed, finding.blast_radius ?? 0);
  }
  return finding.blast_radius ?? 0;
}

/** How a systemic challenge round folds into the running register. */
export interface SystemicRoundResult {
  /** Every distinct finding across all rounds so far, blast-ranked, true-lens. */
  findings: Finding[];
  /** The ids this round added that no prior round had (empty ⇒ dry). */
  new_finding_ids: string[];
  /**
   * True when this round surfaced nothing new — a QUIET round. Convergence is
   * the executor's call over CONSECUTIVE quiet rounds, not this flag alone.
   */
  dry: boolean;
  /** Assembly notes (e.g. a finding was dropped as ungrounded), surfaced. */
  validation_issues: string[];
}

/**
 * Fold one challenge round's submitted improvement findings into the prior set. The
 * enforcement pass:
 *   1. GROUND each new finding against the repo manifest (reusing the shared design
 *      grounding — an improvement pointing at no real component is dropped).
 *   2. Mark `systemic:true` and (re)derive `blast_radius` from the goal DAG, while
 *      PRESERVING the adversary-tagged TRUE lens.
 *   3. DEDUPE against prior rounds by finding identity (lens+category+title); a
 *      re-emission of a prior finding is NOT new.
 *   4. Mark dryness: a round that adds zero new findings is `dry`; an empty
 *      submission is trivially dry. The EXECUTOR converges the loop only after
 *      consecutive dry rounds (the register's `convergence_rule`).
 * Deterministic: the returned `findings` are ordered by descending blast radius, ties
 * broken by finding id, so the register never churns on submission order.
 */
export function foldChallengeRound(params: {
  prior: Finding[];
  submitted: Finding[];
  goalGraph?: GoalGraph;
  repoManifest?: { files?: Array<{ path: string }> };
  /** Map a finding to a goal-graph node id, when the linkage is known. */
  goalNodeOf?: (finding: Finding) => string | undefined;
}): SystemicRoundResult {
  const goalNodeOf = params.goalNodeOf ?? (() => undefined);
  const validation_issues: string[] = [];

  // 1. Ground the submitted findings against disk (drops ungrounded improvements).
  const grounded = groundDesignFindings(params.submitted, params.repoManifest);

  const byKey = new Map<string, Finding>();
  for (const finding of params.prior) byKey.set(findingReEmissionKey(finding), finding);

  const new_finding_ids: string[] = [];
  for (const finding of grounded) {
    if (finding.grounding?.status === "ungrounded") {
      validation_issues.push(
        `Dropped ungrounded improvement "${finding.title}" (${finding.grounding.reason ?? "no component"}).`,
      );
      continue;
    }
    const enriched: Finding = {
      ...finding,
      systemic: true,
      // Preserve the adversary-tagged TRUE lens verbatim (never rewrite to architecture).
      lens: finding.lens,
      blast_radius: resolveBlastRadius(finding, params.goalGraph, goalNodeOf),
    };
    const key = findingReEmissionKey(enriched);
    if (!byKey.has(key)) {
      new_finding_ids.push(enriched.id);
    }
    // Latest wins on a same-identity re-emission (the adversary may refine a lead).
    byKey.set(key, enriched);
  }

  const findings = [...byKey.values()].sort((a, b) => {
    const blastDelta = (b.blast_radius ?? 0) - (a.blast_radius ?? 0);
    if (blastDelta !== 0) return blastDelta;
    return compareCodeUnits(a.id, b.id);
  });

  // A round is DRY when it surfaced nothing the prior set lacked — an empty
  // submission is trivially dry. `new_finding_ids` already captures the newness.
  // Convergence over consecutive dry rounds is the executor's decision.
  const dry = new_finding_ids.length === 0;

  return { findings, new_finding_ids, dry, validation_issues };
}

