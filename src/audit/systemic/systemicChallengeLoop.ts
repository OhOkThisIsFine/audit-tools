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
import {
  absorbFinding,
  groundDesignFindings,
  findingReEmissionKey,
  findingRestatesBanked,
  compareCodeUnits,
} from "audit-tools/shared";
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
 * The tool-owned prefix every banked improvement id carries: `sc-r<round>-<slug>`.
 *
 * The adversary mints its own ids, and nothing made two rounds agree on a
 * namespace — rounds 3 and 4 of the 2026-08-08 run both minted `SC-001..004` for
 * entirely different improvements, so any consumer keyed on finding id (task
 * dispatch, share attribution, the disposition map) saw one id standing for two
 * findings. Namespacing is the tool's job: it is the only party that knows which
 * round a submission belongs to, and a host-prevented collision (that run's host
 * prefixed `r4-` by hand) is a rule held in a transcript, not in the tool.
 *
 * Ids are stable once banked — a restatement never re-mints the banked finding's
 * id (see the absorb branches in {@link foldChallengeRound}) — so anything that
 * recorded an id in an earlier round still resolves after the next fold.
 */
export const SYSTEMIC_FINDING_ID_PREFIX = "sc-r";

/**
 * The hard ceiling on adversary rounds.
 *
 * The loop had NO bound: `MAX_DRAIN_STEPS` bounds the deterministic drain, but
 * this loop is host-driven, and its only exit was a dry round — a signal a fresh
 * no-memory adversary structurally cannot judge, so a host that could see the
 * loop was finished had no sanctioned way to end it (the no-ceiling entry; the
 * 2026-08-21 lap's loop was stopped by a hand-written empty submission). Six
 * rounds is generous against the observed yields — every recorded run has
 * converged by round 3 — while making the bound FINITE, and the stop it produces
 * is recorded as `stop_reason: "round_ceiling"` rather than as convergence on a
 * dry signal the loop never reached.
 *
 * It lives here, in the loop's own pure module, because the prompt states the
 * bound to the lane and the executor enforces it: one number, one home.
 */
export const SYSTEMIC_ROUND_CEILING = 6;

/** A filesystem- and report-safe slug for an adversary-minted id fragment. */
function idSlug(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug.slice(0, 40) : "";
}

/**
 * Mint the round-namespaced id for one submitted finding, unique across
 * everything banked so far AND within this round. A submission that repeats its
 * own id (or submits none) still leaves every finding distinctly addressable —
 * two distinct findings sharing one id is the defect this exists to prevent.
 */
function mintRoundFindingId(params: {
  round: number;
  rawId: string | undefined;
  index: number;
  used: ReadonlySet<string>;
}): string {
  const base = `${SYSTEMIC_FINDING_ID_PREFIX}${params.round}-${
    idSlug(params.rawId ?? "") || String(params.index + 1)
  }`;
  if (!params.used.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!params.used.has(candidate)) return candidate;
  }
}

/**
 * Fold one challenge round's submitted improvement findings into the prior set. The
 * enforcement pass:
 *   1. GROUND each new finding against the repo manifest (reusing the shared design
 *      grounding — an improvement pointing at no real component is dropped).
 *   2. NAMESPACE its id to this round, so two rounds can never mint one id for two
 *      different improvements and a later round can never re-mint a banked id.
 *   3. Mark `systemic:true` and (re)derive `blast_radius` from the goal DAG, while
 *      PRESERVING the adversary-tagged TRUE lens.
 *   4. DEDUPE against prior rounds on CONTENT: an exact re-emission (lens+category+
 *      title) and a re-worded RESTATEMENT of a banked improvement both collapse into
 *      the banked finding, unioning its evidence and files. Neither is new — the
 *      convergence signal cannot rest on a worker choosing to repeat itself verbatim
 *      (`findingRestatesBanked` carries the measured instance).
 *   5. Mark dryness: a round that adds zero new findings is `dry`; an empty
 *      submission is trivially dry. The EXECUTOR converges the loop only after
 *      consecutive dry rounds (the register's `convergence_rule`).
 * Deterministic: the returned `findings` are ordered by descending blast radius, ties
 * broken by finding id, so the register never churns on submission order.
 */
export function foldChallengeRound(params: {
  prior: Finding[];
  submitted: Finding[];
  /** The 1-based ordinal of the round being folded — the id namespace it mints in. */
  round: number;
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
  const usedIds = new Set<string>();
  for (const finding of params.prior) {
    byKey.set(findingReEmissionKey(finding), finding);
    usedIds.add(finding.id);
  }

  /**
   * Fold a refinement of a BANKED finding into it — union evidence and files,
   * KEEPING the banked id and title. A survivor is cloned first: `prior` findings
   * are objects the carried bundle still holds, and absorbing in place would
   * mutate the register the fold is about to re-emit.
   */
  const absorbIntoBanked = (banked: Finding, submitted: Finding): void => {
    const merged: Finding = {
      ...banked,
      affected_files: [...banked.affected_files],
      evidence: [...(banked.evidence ?? [])],
    };
    absorbFinding(merged, submitted, {
      mergeGrounding: true,
      sortAffectedFiles: true,
    });
    byKey.set(findingReEmissionKey(merged), merged);
  };

  const new_finding_ids: string[] = [];
  for (const [index, finding] of grounded.entries()) {
    if (finding.grounding?.status === "ungrounded") {
      validation_issues.push(
        `Dropped ungrounded improvement "${finding.title}" (${finding.grounding.reason ?? "no component"}).`,
      );
      continue;
    }
    const id = mintRoundFindingId({
      round: params.round,
      rawId: finding.id,
      index,
      used: usedIds,
    });
    const enriched: Finding = {
      ...finding,
      id,
      systemic: true,
      // Preserve the adversary-tagged TRUE lens verbatim (never rewrite to architecture).
      lens: finding.lens,
      blast_radius: resolveBlastRadius(finding, params.goalGraph, goalNodeOf),
    };
    const key = findingReEmissionKey(enriched);
    const exact = byKey.get(key);
    if (exact) {
      // The same improvement, re-emitted: a refinement, never a new round result.
      absorbIntoBanked(exact, enriched);
      continue;
    }
    const restated = [...byKey.values()].find((banked) =>
      findingRestatesBanked(banked, enriched),
    );
    if (restated) {
      // A re-wording of a banked improvement is the SAME improvement. Folding it
      // back in (rather than dropping it) keeps whatever the new round verified —
      // evidence and files union into the banked finding — while the round stays
      // quiet, which is what makes convergence a statement about content.
      absorbIntoBanked(restated, enriched);
      validation_issues.push(
        `Folded restatement of banked improvement "${restated.title}" (submitted as "${finding.title}") — not a new finding.`,
      );
      continue;
    }
    usedIds.add(id);
    new_finding_ids.push(id);
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

