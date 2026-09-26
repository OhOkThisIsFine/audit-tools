// sites-pinned: tests/shared/directed-reachability.test.ts
/**
 * Transitive reachability over directed dependency edges (CY-11).
 *
 * Given a seed set of reachable nodes and a successor provider (a function
 * mapping a node to its outgoing edges), traverses edges iteratively to a
 * fixed point.
 *
 * Exactly one predicate callback `canTraverse` may be supplied to control edge
 * traversal. When provided, an edge `(from, to)` is followed if and only if
 * `canTraverse(from, to)` returns true.
 *
 * All domain-specific staleness, deferred-edge recording, revision comparison,
 * presence checks, and migration policies remain inside the consumer.
 */

/**
 * Edge-traversal predicate for directed reachability: returns true if the edge
 * from `from` to `to` can be traversed, or false to halt traversal along this edge.
 */
export type EdgeTraversalPredicate<T> = (from: T, to: T) => boolean;

/**
 * Compute the transitively reachable set of nodes in a directed graph starting
 * from a set of seed nodes.
 *
 * Traversal follows directed edges `from -> to` as yielded by `getSuccessors(from)`.
 * When an edge-traversal predicate `canTraverse` is supplied, an edge is followed
 * if and only if `canTraverse(from, to)` returns true.
 *
 * If `seeds` is an existing Set, reached nodes are added directly into it and
 * the same Set is returned. Otherwise a new Set is constructed and returned.
 */
export function computeDirectedReachability<T>(
  seeds: Iterable<T>,
  getSuccessors: (node: T) => Iterable<T> | undefined,
  canTraverse?: EdgeTraversalPredicate<T>,
): Set<T> {
  const reached = seeds instanceof Set ? seeds : new Set<T>(seeds);
  const queue: T[] = [...reached];
  let head = 0;

  while (head < queue.length) {
    const from = queue[head++];
    const successors = getSuccessors(from);
    if (!successors) continue;
    for (const to of successors) {
      if (reached.has(to)) continue;
      if (canTraverse && !canTraverse(from, to)) continue;
      reached.add(to);
      queue.push(to);
    }
  }

  return reached;
}
