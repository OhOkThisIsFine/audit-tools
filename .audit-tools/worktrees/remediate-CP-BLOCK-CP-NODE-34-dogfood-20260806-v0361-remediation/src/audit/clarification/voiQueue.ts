// Phase D — D1 pure primitive: the VALUE-OF-INFORMATION queue.
//
// Rank charter-alignment questions by how much charter-uncertainty each answer
// collapses: a question that resolves a high-blast True-delta AND cascades to
// settle several downstream findings beats a leaf clarification (design of record
// spec/conceptual-design-review-design.md §"The triangulation loop" — "Rank
// questions by value-of-information"). The attention dial is then simply HOW FAR
// DOWN this ranked queue you go, so a low-appetite run still gets the
// highest-leverage questions, not merely fewer (that cut is the D2 dial, not here).
//
// PURE + deterministic + language-neutral: a stable total order over the requests,
// no IO, no LLM. Exported so phase-e reuses the same ranking.

import type { CharterClarificationRequest } from "audit-tools/shared";

/**
 * The scalar VOI score of a question: blast radius (how far the answer ripples up
 * the goal DAG) plus the cascade count (how many other open deltas it settles).
 * Both are "uncertainty collapsed per answer" currencies, so they add. Kept as a
 * named function (not inlined) so phase-e can score a single request without
 * re-sorting a whole queue.
 */
export function voiScore(request: CharterClarificationRequest): number {
  return request.value.blast_radius + request.value.cascade_count;
}

/**
 * Order clarification requests by descending VOI. Ties break deterministically by
 * `request_id` (content-derived, never input order — an incidentally-ordered queue
 * churns the artifact hash; see the extractor-ordering invariant in CLAUDE.md).
 * Returns a NEW array; the input is never mutated.
 */
export function voiQueue(
  requests: CharterClarificationRequest[],
): CharterClarificationRequest[] {
  return [...requests].sort((a, b) => {
    const byScore = voiScore(b) - voiScore(a);
    if (byScore !== 0) return byScore;
    return a.request_id.localeCompare(b.request_id);
  });
}
