// Phase D — D2: PARTITION routed charter deltas into charter-alignment questions.
//
// The charter layer (Phase C) produces routed + gated CharterDeltas. The
// triangulation loop turns each delta ROUTED TO clarification (or human) into a
// decidable, symmetric question — not "what do you want?" but "your code optimizes
// X, your docs say Y, they collide at this seam — which governs?" (design of record
// spec/conceptual-design-review-design.md §"The triangulation loop"). Questions are
// SYMMETRIC: any of the four charters may move, including Stated, and "leave open"
// is a first-class answer — so the question text never anoints a side.
//
// PURE + deterministic + language-neutral: operates on the abstract delta list +
// goal graph, no IO, no LLM. The blast radius (via the D1 primitive) and the
// cascade count (how many OTHER deltas share this subsystem) are the VOI axes the
// downstream queue ranks on. Exported for phase-e reuse.

import type {
  CharterDelta,
  CharterClarificationRequest,
  GoalGraph,
} from "audit-tools/shared";
import { deltaBlastRadius } from "./blastRadius.js";

/** A routed delta joined to the subsystem node it belongs to. */
export interface DeltaWithNode {
  delta: CharterDelta;
  node_id: string;
  /** The goal-graph node id for this subsystem, when the host linked one. */
  goal_node_id?: string;
}

/**
 * A delta is CLARIFICATION-SOURCING when it routes to `clarification` (an
 * inferred−stated unstated assumption) or `human` (a wrong-goal provocation, or a
 * low-confidence delta forced to the human channel). A `remediator`-routed
 * spec-drift delta is NOT a charter question — it is a fix, handled by the
 * remediator, so it never enters the attention queue.
 */
function sourcesQuestion(delta: CharterDelta): boolean {
  return delta.routed_to === "clarification" || delta.routed_to === "human";
}

/**
 * Frame a routed delta's symmetric decidable question. The two charter kinds are
 * held in tension without anointing either; the summary carries the seam. Kept
 * mechanical (never an LLM call) so the question text is reproducible from the
 * delta alone.
 */
function frameQuestion(delta: CharterDelta): string {
  const [a, b] = delta.pair;
  return (
    `The **${a}** and **${b}** charters collide here: ${delta.summary} ` +
    `Which governs — the ${a} side, the ${b} side, a rewrite of both to a third ` +
    `thing, or is this a deliberate held tension (leave open)?`
  );
}

/**
 * Partition the routed deltas into charter-alignment questions. Every
 * clarification/human-routed delta becomes one open `CharterClarificationRequest`
 * with its VOI axes computed:
 *   - `blast_radius` from the goal DAG (falling back to the delta kind's intrinsic
 *     tier when the subsystem is not linked to a goal node);
 *   - `cascade_count` = the number of OTHER question-sourcing deltas in the same
 *     subsystem (answering one charter question there is expected to settle its
 *     siblings), so a subsystem thick with deltas ranks its questions higher.
 *
 * `disposition` is left `interactive` here; the D1 risk gate downgrades high-blast
 * questions that have not cleared the adversarial bar. Output is sorted by
 * `request_id` (content-derived, stable) so the register never churns on input
 * order. Deterministic: same deltas + same graph → same questions.
 */
export function partitionDeltasToQuestions(
  deltas: DeltaWithNode[],
  goalGraph: GoalGraph,
): CharterClarificationRequest[] {
  const sourcing = deltas.filter((d) => sourcesQuestion(d.delta));

  // cascade_count: other sourcing deltas per subsystem.
  const perNode = new Map<string, number>();
  for (const d of sourcing) {
    perNode.set(d.node_id, (perNode.get(d.node_id) ?? 0) + 1);
  }

  const requests = sourcing.map((d): CharterClarificationRequest => {
    const siblings = (perNode.get(d.node_id) ?? 1) - 1;
    return {
      request_id: `${d.delta.delta_id}:q`,
      delta_id: d.delta.delta_id,
      node_id: d.node_id,
      pair: d.delta.pair,
      question: frameQuestion(d.delta),
      value: {
        blast_radius: deltaBlastRadius(goalGraph, d.goal_node_id, d.delta.kind),
        cascade_count: Math.max(0, siblings),
      },
      disposition: "interactive",
    };
  });

  return requests.sort((a, b) => a.request_id.localeCompare(b.request_id));
}
