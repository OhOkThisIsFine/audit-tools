// sites-pinned: tests/audit/charter-clarification.test.ts
// Phase D — D1 pure primitive: BLAST RADIUS over the lane goal DAGs.
//
// Every difference carries a blast radius: how far up a goal graph its resolution
// ripples. Goals form a DAG, not a tree — a node serves multiple parents. With
// THREE lane graphs (design of record 2026-09-15, step 5) the radius is computed
// PER DAG over the corresponding nodes and the MAXIMUM is taken: a goal high in
// any one source's hierarchy is high-blast. Blast radius is simultaneously
// PRIORITY (high-blast = high value) and RISK (a wrong high-blast finding is
// catastrophic → higher adversarial bar).
//
// PURE + deterministic + language-neutral: no IO, no LLM.

import type {
  CharterCorrespondence,
  CharterDifference,
  CharterLaneGraph,
} from "audit-tools/shared";

/** The edge shape both the shared `GoalGraph` and a lane graph carry. */
interface ServesEdges {
  edges: readonly { from: string; to: string }[];
}

/**
 * Blast radius of a goal node = the size of its transitive PARENT closure — every
 * goal it (transitively) serves. A leaf serving no parent has radius 0; so does
 * the top telos (served by everything, serving nothing) — the ripple is measured
 * UPWARD. Cycle-safe (visited-set guarded); an absent node has radius 0.
 */
export function goalBlastRadius(graph: ServesEdges, nodeId: string): number {
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
 * The intrinsic blast tier per dimension and split — the floor a graph reach may
 * only raise. A three-way disagreement, or a purpose / responsibility / hierarchy
 * split, challenges what a subsystem is FOR (mid-high); scope, standing and
 * standard qualify a goal both sides share (mid-low); presence is a coverage gap.
 */
function intrinsicTier(difference: CharterDifference): number {
  if (difference.split?.kind === "three_way") return 3;
  switch (difference.dimension) {
    case "purpose":
    case "responsibility":
    case "hierarchy":
      return 2;
    case "scope":
    case "standing":
    case "standard":
    case "presence":
      return 1;
    default:
      return 1;
  }
}

/**
 * Resolve a difference's blast radius: the maximum, over every corresponding node
 * in every lane graph, of that node's parent-closure size on ITS OWN graph — never
 * below the intrinsic tier.
 */
export function differenceBlastRadius(
  difference: CharterDifference,
  correspondence: CharterCorrespondence | undefined,
  graphs: readonly CharterLaneGraph[],
): number {
  let radius = intrinsicTier(difference);
  for (const member of correspondence?.members ?? []) {
    const graph = graphs.find((g) => g.kind === member.kind);
    if (!graph) continue;
    for (const nodeId of member.node_ids) {
      radius = Math.max(radius, goalBlastRadius(graph, nodeId));
    }
  }
  return radius;
}
