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

/**
 * The break a worker ACTUALLY authored, read off the `cyclic_seam_resolution`
 * record rather than fabricated by the re-checker.
 *
 * Both sanctioned strategies designate a REAL node: `mediator` names a third
 * obligation that now owns the shared primitive, `single_authority` names the
 * one cycle member that keeps the interface. A record that designates nothing
 * cannot be validated against the real graph at all — see
 * {@link validateAuthoredCycleBreak}, which refuses it rather than inventing a
 * placeholder.
 */
export interface AuthoredCycleBreak {
  /** `break_strategy` from the resolution record. */
  strategy: "mediator" | "single_authority";
  /** The obligation id the record designates, when it named one. */
  designatedId?: string;
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

/**
 * Re-check a cycle-break AS AUTHORED, against the REAL obligation graph.
 *
 * The distinction from {@link validateCycleBreak} is the whole point: that
 * function asks a HYPOTHETICAL — "if the intra-cycle edges were redirected to
 * this proposed node, would the graph be acyclic?" — and its caller used to
 * answer it with a node it had fabricated itself (`{ id: "_mediator_A_B",
 * needs: [] }`) against the UNMODIFIED ledger. An edge-free sink absorbs every
 * redirected edge, so for a single detected cycle that question is acyclic BY
 * CONSTRUCTION and the re-check could never reject — a worker could claim
 * `status: "resolved"` while leaving the ledger's cycle edges exactly as they
 * were, and the pipeline advanced.
 *
 * This function asks the REAL question instead: does the graph the pipeline
 * will actually consume still carry the cycle? The break is accepted only when
 *
 *   1. the record designates a node (a break with no designated owner is not a
 *      break, it is a claim), and that node EXISTS in the live graph;
 *   2. the strategy and the designated node agree — a mediator is a THIRD node
 *      outside the cycle, a single authority is one of the cycle's own members;
 *   3. the live graph no longer contains a cycle touching the original members
 *      — i.e. the break is reflected in the edges, not just asserted in prose;
 *   4. and, for the mediator strategy, redirecting the cycle's edges at the
 *      mediator's REAL `needs` (never a fabricated empty set) stays acyclic, so
 *      a mediator that itself depends back into the cycle is refused.
 *
 * `currentNodes` must be built from the obligation ledger as it stands NOW, on
 * this invocation, after ingestion and the staleness-archive pass — a stale
 * snapshot would reintroduce exactly the vacuity this closes.
 */
export function validateAuthoredCycleBreak(
  originalCycle: DetectedCycle,
  currentNodes: SeamObligationNode[],
  authored: AuthoredCycleBreak,
): CycleBreakValidation {
  const members = originalCycle.members;
  const cycleSet = new Set(members);
  const designatedId = authored.designatedId?.trim();

  if (!designatedId) {
    return {
      accepted: false,
      reason:
        `The ${authored.strategy} break for cycle [${members.join(", ")}] names no obligation. ` +
        `A mediator break must name the mediating obligation and a single_authority break must ` +
        `name the owning obligation, or there is nothing to re-check against the ledger.`,
    };
  }

  const designated = currentNodes.find((node) => node.id === designatedId);
  if (!designated) {
    return {
      accepted: false,
      reason:
        `The ${authored.strategy} break for cycle [${members.join(", ")}] names "${designatedId}", ` +
        `which is not an obligation in the ledger. The break must be recorded in the ledger the ` +
        `pipeline reads, not only in the resolution record.`,
    };
  }

  if (authored.strategy === "mediator" && cycleSet.has(designatedId)) {
    return {
      accepted: false,
      reason:
        `Mediator "${designatedId}" is itself a member of cycle [${members.join(", ")}]. A mediator ` +
        `is a THIRD obligation that both sides depend on; designating a participant is a ` +
        `single_authority break, not a mediator break.`,
    };
  }

  if (authored.strategy === "single_authority" && !cycleSet.has(designatedId)) {
    return {
      accepted: false,
      reason:
        `Single authority "${designatedId}" is not a member of cycle [${members.join(", ")}]. The ` +
        `authority must be one of the co-defining obligations; the others become consumers.`,
    };
  }

  // (3) The designated obligation must be a member of THE BROKEN CYCLE'S OWN
  // node set — the cycle members plus what they now need. Existing in the
  // ledger is not enough: a mediator that no cycle member depends on mediates
  // nothing, so an arbitrary unrelated obligation could otherwise be named and
  // the break would pass on the strength of a graph that is acyclic for
  // reasons having nothing to do with the claim.
  const brokenCycleNodeSet = new Set<string>(members);
  for (const node of currentNodes) {
    if (!cycleSet.has(node.id)) continue;
    for (const dep of node.needs) brokenCycleNodeSet.add(dep);
  }
  if (!brokenCycleNodeSet.has(designatedId)) {
    return {
      accepted: false,
      reason:
        `The ${authored.strategy} break names "${designatedId}", which no member of cycle ` +
        `[${members.join(", ")}] depends on. The designated obligation must be part of the broken ` +
        `cycle's own node set — a mediator no cycle member needs is not mediating the cycle.`,
    };
  }

  // (4) The live edges, not the claim: any remaining cycle that still touches
  // the original members means the ledger was never actually rewritten.
  const allRemaining = detectCyclicSeamObligations(currentNodes);
  const remaining = allRemaining.filter((cycle) =>
    cycle.members.some((id) => cycleSet.has(id)),
  );
  if (remaining.length > 0) {
    const affectedIds = [...new Set(remaining.flatMap((c) => c.members))].join(", ");
    return {
      accepted: false,
      reason:
        `Cycle [${members.join(", ")}] is still present in the obligation ledger after the claimed ` +
        `${authored.strategy} break via "${designatedId}" — the depends_on edges involving ` +
        `[${affectedIds}] were not changed. Rewrite the ledger so the cycle's edges actually route ` +
        `through the designated obligation.`,
    };
  }

  // (5) SYMMETRIC across both strategies: the break must not have introduced a
  // cycle ELSEWHERE either. Step (4) only looks at cycles touching the original
  // members, so a brand-new cycle among untouched obligations would pass it —
  // and a single_authority break used to reach the accept with no whole-graph
  // check at all.
  if (allRemaining.length > 0) {
    const affectedIds = [...new Set(allRemaining.flatMap((c) => c.members))].join(", ");
    return {
      accepted: false,
      reason:
        `The ${authored.strategy} break via "${designatedId}" leaves the obligation graph cyclic ` +
        `elsewhere: [${affectedIds}]. Breaking one cycle may not introduce another.`,
    };
  }

  // (6) The mediator's REAL needs — the check the fabricated `needs: []` node
  // could never fail. Deliberately NOT run for single_authority: that strategy
  // designates a cycle MEMBER, and `validateCycleBreak` redirects a member's
  // intra-cycle edges at the designated node, which for the authority itself
  // would manufacture a self-edge and reject a sound break. Step (5) is the
  // whole-graph guarantee both strategies share.
  if (authored.strategy === "mediator") {
    return validateCycleBreak(originalCycle, currentNodes, {
      id: designated.id,
      needs: designated.needs,
    });
  }

  return { accepted: true };
}
