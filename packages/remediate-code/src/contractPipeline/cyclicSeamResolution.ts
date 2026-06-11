/**
 * Cyclic-seam resolution: deterministic cycle detection over module seam
 * obligations, plus a re-check helper that validates a proposed cycle-break
 * does not re-introduce a cycle.
 *
 * A "seam obligation" is any module that declares an interface obligation
 * (via neighbor_needs / inputs / outputs) that depends on a type or interface
 * owned by another module.  For the purposes of this detector, a module M
 * is said to need module N when M lists N in its `needs` array.
 *
 * Detection algorithm: Kahn's iterative topological sort over the directed
 * graph of (module → modules it needs).  Any node that remains after the
 * sort is part of a cycle.  The resulting connected components are each
 * reported as one detected cycle.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** A module node in the seam-obligation graph. */
export interface SeamObligationNode {
  /** Unique module identifier. */
  id: string;
  /** IDs of modules this module declares an interface obligation toward. */
  needs: string[];
}

/** One detected cycle (N ≥ 2 nodes). */
export interface DetectedCycle {
  /** Ordered list of module IDs that form the cycle (not necessarily in cycle order). */
  members: string[];
}

/** A proposed mediator module that breaks a cycle. */
export interface ProposedMediator {
  /** Module ID for the new mediator. */
  id: string;
  /** Modules the mediator itself needs (must not form a new cycle). */
  needs: string[];
}

/** Result of a cycle-break re-check. */
export interface CycleBreakValidation {
  accepted: boolean;
  /** Present only when accepted === false. */
  reason?: string;
}

// ── Cycle detection ───────────────────────────────────────────────────────────

/**
 * Detect cyclic seam obligations in a module graph.
 *
 * Uses Kahn's topological sort: build an in-degree map and a dependency →
 * dependent adjacency list, then drain the zero-in-degree queue.  Any node
 * remaining in the graph after the drain is part of a cycle.  Weakly
 * connected components among remaining nodes are grouped into cycles.
 *
 * Returns an empty array when no cycle is found.
 */
export function detectCyclicSeamObligations(
  nodes: SeamObligationNode[],
): DetectedCycle[] {
  if (nodes.length === 0) return [];

  const ids = new Set(nodes.map((n) => n.id));
  // adjacency: dep → [dependents]
  const adjacency = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const id of ids) {
    adjacency.set(id, []);
    inDegree.set(id, 0);
  }

  for (const node of nodes) {
    for (const dep of node.needs) {
      if (!ids.has(dep)) continue; // ignore external refs
      // edge: dep → node (dep must come before node)
      adjacency.get(dep)!.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  // Kahn's drain
  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const next of adjacency.get(node) ?? []) {
      const newDeg = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, newDeg);
      if (newDeg === 0) queue.push(next);
    }
  }

  if (visited === ids.size) return []; // no cycles

  // Collect cycle members (nodes with in-degree > 0 after drain).
  const cycleNodes = [...ids].filter((id) => (inDegree.get(id) ?? 0) > 0);

  // Group by weakly connected component using union-find on the original
  // needs edges (restricted to cycle nodes).
  const cycleSet = new Set(cycleNodes);
  const parent = new Map<string, string>(cycleNodes.map((id) => [id, id]));

  function find(x: string): string {
    while (parent.get(x) !== x) {
      const p = parent.get(x)!;
      parent.set(x, parent.get(p) ?? p);
      x = parent.get(x)!;
    }
    return x;
  }

  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (const node of nodes) {
    if (!cycleSet.has(node.id)) continue;
    for (const dep of node.needs) {
      if (cycleSet.has(dep)) {
        union(node.id, dep);
      }
    }
  }

  // Group by root.
  const components = new Map<string, string[]>();
  for (const id of cycleNodes) {
    const root = find(id);
    if (!components.has(root)) components.set(root, []);
    components.get(root)!.push(id);
  }

  return [...components.values()].map((members) => ({ members }));
}

// ── Cycle-break re-check ──────────────────────────────────────────────────────

/**
 * Validate a proposed cycle-break by re-running cycle detection on the
 * graph after the break is applied.
 *
 * The break modifies the original graph as follows:
 * - Remove every `needs` edge between original cycle members that crossed the
 *   cycle (both sides still appear in the graph with their original non-cycle
 *   needs intact).
 * - Add the `proposedMediator` as a new node.
 * - For each original cycle member, replace any needs-edge that pointed to
 *   another cycle member with a needs-edge to the mediator.
 *
 * If the resulting graph still contains a cycle, the proposed break is
 * rejected.
 */
export function validateCycleBreak(
  originalCycle: DetectedCycle,
  allNodes: SeamObligationNode[],
  proposedMediator: ProposedMediator,
): CycleBreakValidation {
  const cycleSet = new Set(originalCycle.members);

  // Build the patched node list:
  // - For each cycle member: replace needs-edges to other cycle members with
  //   a needs-edge to the mediator.
  // - For non-cycle members: unchanged.
  // - Add the mediator.
  const patched: SeamObligationNode[] = [];

  for (const node of allNodes) {
    if (cycleSet.has(node.id)) {
      const newNeeds = node.needs.map((dep) =>
        cycleSet.has(dep) ? proposedMediator.id : dep,
      );
      // Deduplicate mediator references.
      patched.push({ id: node.id, needs: [...new Set(newNeeds)] });
    } else {
      patched.push(node);
    }
  }

  // Add the mediator itself.
  patched.push({ id: proposedMediator.id, needs: proposedMediator.needs });

  const remaining = detectCyclicSeamObligations(patched);

  if (remaining.length > 0) {
    const affectedIds = remaining.flatMap((c) => c.members).join(", ");
    return {
      accepted: false,
      reason: `Proposed mediator "${proposedMediator.id}" still leaves cycle(s) involving: [${affectedIds}].`,
    };
  }

  return { accepted: true };
}
