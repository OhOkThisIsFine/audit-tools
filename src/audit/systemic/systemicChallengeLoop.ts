// Phase E — the SYSTEMIC IMPROVEMENT-SEEKING CHALLENGE LOOP (audit-side assembly).
//
// A second-order adversary (a SEPARATE agent) re-interrogates the whole system with
// human-grade pressure and folds newly-surfaced improvements back in, LOOP-UNTIL-DRY:
// done only when a challenge round yields NOTHING NEW (design of record
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
import { groundDesignFindings } from "audit-tools/shared";
import { goalBlastRadius } from "../clarification/blastRadius.js";
import { DEFAULT_RISK_GATE_THRESHOLDS } from "../clarification/riskGate.js";

/** File-independent finding identity (lens + category + title), lower-cased. */
function findingKey(finding: Finding): string {
  const norm = (v: string | undefined): string => (v ?? "").trim().toLowerCase();
  return [norm(finding.lens), norm(finding.category), norm(finding.title)].join("|");
}

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
  /** The ids this round added that no prior round had (empty ⇒ dry/converged). */
  new_finding_ids: string[];
  /** True when this round surfaced nothing new — the loop-until-dry terminator. */
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
 *   4. Determine convergence: a round that adds zero new findings is `dry` (the loop
 *      terminates); an empty submission is trivially dry.
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
  for (const finding of params.prior) byKey.set(findingKey(finding), finding);

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
    const key = findingKey(enriched);
    if (!byKey.has(key)) {
      new_finding_ids.push(enriched.id);
    }
    // Latest wins on a same-identity re-emission (the adversary may refine a lead).
    byKey.set(key, enriched);
  }

  const findings = [...byKey.values()].sort((a, b) => {
    const blastDelta = (b.blast_radius ?? 0) - (a.blast_radius ?? 0);
    if (blastDelta !== 0) return blastDelta;
    return a.id.localeCompare(b.id);
  });

  // A round is DRY (converged) when it surfaced nothing the prior set lacked — an
  // empty submission is trivially dry. `new_finding_ids` already captures the newness.
  const dry = new_finding_ids.length === 0;

  return { findings, new_finding_ids, dry, validation_issues };
}

/**
 * The blast threshold at/above which an improvement finding is "high-blast" — a
 * categorically-better-approach claim whose fix re-draws a boundary. Single-sourced
 * from the Phase-D risk gate so Phase E's notion of "high blast" cannot drift from
 * the clarification loop's. A high-blast improvement is surfaced as a lead like any
 * other (leads-not-verdicts), but flagged so synthesis weights it as higher-risk.
 */
export const SYSTEMIC_HIGH_BLAST_THRESHOLD =
  DEFAULT_RISK_GATE_THRESHOLDS.highBlastThreshold;
