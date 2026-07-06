// Phase D — D1 pure primitive: BLAST RADIUS over the goal DAG.
//
// Every charter delta carries a blast radius: how far up the goal graph its fix
// ripples. Goals are a DAG, not a tree — a node serves multiple parents, so an L2
// change on one side can force an L1 reframe on the other (design of record
// spec/conceptual-design-review-design.md §"Blast radius — the ranking and the
// risk gate"). Blast radius is simultaneously PRIORITY (high-blast = high value)
// and RISK (a wrong high-blast finding is catastrophic → higher adversarial bar).
//
// PURE + deterministic + language-neutral: operates on the abstract GoalGraph
// (telos statements + serves-edges), no IO, no LLM. Exported as an importable
// primitive so phase-e can reuse the same ranking substrate.

import type { GoalGraph } from "audit-tools/shared";

/**
 * Blast radius of a goal node = the size of its transitive PARENT closure — every
 * goal it (transitively) serves. A fix at this node ripples up to all of them, so
 * the count is how far up the DAG the ripple reaches. A leaf-most node serving no
 * parent has blast radius 0; the telos (served by everything, serving nothing) has
 * blast radius 0 too — the ripple is measured UPWARD, toward parents.
 *
 * Cycle-safe (a malformed graph never loops): visited-set guarded. A node absent
 * from the graph has blast radius 0 (nothing to ripple to).
 */
export function goalBlastRadius(graph: GoalGraph, nodeId: string): number {
  // Adjacency: child → its parents (an edge `from` serves `to`).
  const parents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = parents.get(edge.from);
    if (list) list.push(edge.to);
    else parents.set(edge.from, [edge.to]);
  }
  const seen = new Set<string>();
  const stack = [...(parents.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const parent of parents.get(current) ?? []) {
      if (!seen.has(parent)) stack.push(parent);
    }
  }
  return seen.size;
}

/**
 * Resolve the blast radius for a delta whose subsystem maps to a goal node. When a
 * delta's node is not present in the goal graph (the host supplied no DAG, or the
 * subsystem was never linked to a goal), fall back to the delta KIND's intrinsic
 * blast tier — a `wrong_goal` provocation is intrinsically the highest-blast (it
 * challenges the telos), `spec_drift` is mid, an `unstated_assumption` the lowest.
 * This keeps ranking meaningful even before a goal graph exists (the common
 * conversation-first default), and lets a real graph refine it when present.
 */
export function deltaBlastRadius(
  graph: GoalGraph,
  goalNodeId: string | undefined,
  deltaKind: "unstated_assumption" | "spec_drift" | "wrong_goal",
): number {
  const intrinsic =
    deltaKind === "wrong_goal" ? 3 : deltaKind === "spec_drift" ? 2 : 1;
  if (!goalNodeId) return intrinsic;
  const graphed = goalBlastRadius(graph, goalNodeId);
  // The graph reach REFINES the intrinsic tier upward, never downward: a
  // wrong_goal delta stays high-blast even if its goal node happens to be a leaf.
  return Math.max(intrinsic, graphed);
}
