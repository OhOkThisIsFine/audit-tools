// sites-pinned: tests/shared/ordered-reachability.test.ts, tests/audit/dependency-slices.test.ts, tests/remediate/contract-pipeline-artifact-store.test.ts
/**
 * Expand a reached set by repeated scans of caller-ordered directed edges.
 * Edge order is observable through Set insertion order; this deliberately does
 * not replace fixed-point traversal with breadth-first or depth-first ordering.
 * Freshness, absence and deferred-edge policy belong to the caller's predicate.
 * The predicate is called only for a reached source and an unreached target.
 */
export function propagateReachability<Node>(
  reached: Set<Node>,
  edges: readonly (readonly [Node, Node])[],
  canTraverse: (from: Node, to: Node) => boolean,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to] of edges) {
      if (!reached.has(from) || reached.has(to) || !canTraverse(from, to)) continue;
      reached.add(to);
      changed = true;
    }
  }
}
