// Resolution-swept modularity community detection (Louvain-style local-moving +
// aggregation) — the deterministic clustering backbone of the conceptual
// design-review overlay-and-delta operator (Phase B; design of record
// spec/conceptual-design-review-design.md §"Granularity resolves across scale").
//
// A boundary is "real" to the degree it is STABLE ACROSS SCALES: we cluster the
// same weighted graph at many resolutions (coarse→fine) and a boundary that
// persists across resolutions is trusted. This module owns only the clustering;
// the stability scoring across the resulting partitions lives in consensus.ts.
//
// PURE + DETERMINISTIC: no IO, no Math.random, no Date. Ties are broken by
// lexical node/community id so the same graph always yields the same partition.
// Language-neutral by construction — it consumes only string node ids and numeric
// edge weights, so any source of coupling (call/import, git co-change, data/state)
// feeds it identically. Hand-rolled (community detection is an algorithm, not a
// grammar → outside the import-vetted-libs policy; owning it keeps full
// tie-break/determinism control).

/**
 * A weighted undirected graph over string node ids. `edges` are undirected; a
 * repeated {a,b} pair (either orientation) accumulates weight. Self-loops
 * (a === b) are allowed and accounted for in the degree, which matters once
 * communities are aggregated into super-nodes.
 */
export interface WeightedGraph {
  /** The full node universe (may include nodes with no edges). */
  nodes: string[];
  edges: Array<{ a: string; b: string; weight: number }>;
}

/**
 * A partition of a node universe: a map from node id to the id of the community
 * it belongs to. Community ids are themselves node ids (the lexicographically
 * smallest member acts as the stable representative).
 */
export type Partition = Map<string, string>;

/**
 * Default resolution ladder, coarse→fine. Higher resolution γ penalizes large
 * communities more, yielding more (smaller) communities — so the ladder walks
 * from few coarse subsystems to many fine ones. A boundary present at coarse γ
 * AND fine γ is scale-stable. Chosen as a geometric spread so each rung is a
 * distinct scale rather than a small perturbation of its neighbor.
 */
export const DEFAULT_RESOLUTIONS: readonly number[] = [0.25, 0.5, 1, 2, 4];

/** Internal symmetric adjacency: node → (neighbor → accumulated weight). */
interface AdjacencyGraph {
  nodes: string[];
  /** node → neighbor → weight (symmetric; self-loop stored on the diagonal). */
  adjacency: Map<string, Map<string, number>>;
  /** node → degree = Σ over incident edge weights (diagonal counted once). */
  degree: Map<string, number>;
  /** Total edge weight m (so 2m = Σ degree). */
  totalWeight: number;
}

function buildAdjacency(graph: WeightedGraph): AdjacencyGraph {
  const nodes = [...new Set(graph.nodes)].sort((a, b) => a.localeCompare(b));
  const adjacency = new Map<string, Map<string, number>>();
  for (const node of nodes) adjacency.set(node, new Map());

  const ensure = (node: string): Map<string, number> => {
    let row = adjacency.get(node);
    if (!row) {
      row = new Map();
      adjacency.set(node, row);
      nodes.push(node);
    }
    return row;
  };

  for (const edge of graph.edges) {
    if (!(edge.weight > 0)) continue; // drop zero / negative / NaN weights
    const a = edge.a;
    const b = edge.b;
    const rowA = ensure(a);
    if (a === b) {
      rowA.set(a, (rowA.get(a) ?? 0) + edge.weight);
      continue;
    }
    const rowB = ensure(b);
    rowA.set(b, (rowA.get(b) ?? 0) + edge.weight);
    rowB.set(a, (rowB.get(a) ?? 0) + edge.weight);
  }

  // Nodes may have been appended by ensure(); keep the list unique + sorted so
  // downstream iteration order is deterministic.
  const uniqueSorted = [...new Set(nodes)].sort((a, b) => a.localeCompare(b));

  const degree = new Map<string, number>();
  let degreeSum = 0;
  for (const node of uniqueSorted) {
    const row = adjacency.get(node) ?? new Map<string, number>();
    let deg = 0;
    for (const w of row.values()) deg += w;
    degree.set(node, deg);
    degreeSum += deg;
  }

  return {
    nodes: uniqueSorted,
    adjacency,
    degree,
    totalWeight: degreeSum / 2,
  };
}

/** One level of the Louvain hierarchy: the community assignment per node. */
interface Level {
  /** node → community id (a representative node id). */
  communityOf: Map<string, string>;
}

/**
 * Local-moving phase: greedily move each node to the neighboring community that
 * most improves modularity at resolution γ, iterating in lexical node order until
 * a full pass makes no move. Returns node→community and whether anything moved.
 */
function localMoving(
  graph: AdjacencyGraph,
  resolution: number,
): { communityOf: Map<string, string>; moved: boolean } {
  const twoM = graph.totalWeight * 2;
  const communityOf = new Map<string, string>();
  // Σtot(C): total degree of nodes currently in community C.
  const communityDegree = new Map<string, number>();
  for (const node of graph.nodes) {
    communityOf.set(node, node);
    communityDegree.set(node, graph.degree.get(node) ?? 0);
  }

  if (twoM === 0) {
    // No edges: every node is its own community, nothing to move.
    return { communityOf, moved: false };
  }

  let movedEver = false;
  let improved = true;
  // Bound the passes so a pathological weight pattern can never loop forever;
  // Louvain converges in a handful of passes in practice.
  let guard = 0;
  const maxPasses = graph.nodes.length + 8;
  while (improved && guard < maxPasses) {
    improved = false;
    guard += 1;
    for (const node of graph.nodes) {
      const nodeDegree = graph.degree.get(node) ?? 0;
      const current = communityOf.get(node)!;
      // Remove node from its community.
      communityDegree.set(
        current,
        (communityDegree.get(current) ?? 0) - nodeDegree,
      );

      // Weight from node into each candidate community (self-loop excluded — it
      // travels with the node and cannot distinguish communities).
      const weightToCommunity = new Map<string, number>();
      const row = graph.adjacency.get(node) ?? new Map<string, number>();
      for (const [neighbor, weight] of row) {
        if (neighbor === node) continue;
        const comm = communityOf.get(neighbor)!;
        weightToCommunity.set(comm, (weightToCommunity.get(comm) ?? 0) + weight);
      }

      // Isolation (staying in a fresh singleton) is the baseline: gain 0.
      let bestCommunity = current;
      let bestGain = 0;
      // Evaluate candidates in lexical order for a deterministic tie-break.
      const candidates = [...weightToCommunity.keys()].sort((a, b) =>
        a.localeCompare(b),
      );
      for (const comm of candidates) {
        const kiIn = weightToCommunity.get(comm) ?? 0;
        const sigmaTot = communityDegree.get(comm) ?? 0;
        const gain = kiIn - (resolution * nodeDegree * sigmaTot) / twoM;
        if (
          gain > bestGain + 1e-12 ||
          (Math.abs(gain - bestGain) <= 1e-12 && comm.localeCompare(bestCommunity) < 0)
        ) {
          bestGain = gain;
          bestCommunity = comm;
        }
      }

      // Re-add node to the chosen community.
      communityDegree.set(
        bestCommunity,
        (communityDegree.get(bestCommunity) ?? 0) + nodeDegree,
      );
      communityOf.set(node, bestCommunity);
      if (bestCommunity !== current) {
        improved = true;
        movedEver = true;
      }
    }
  }

  return { communityOf, moved: movedEver };
}

/**
 * Relabel a community assignment so each community id is its lexicographically
 * smallest member — a stable representative independent of iteration order.
 */
function canonicalizeCommunities(
  communityOf: Map<string, string>,
): Map<string, string> {
  const rep = new Map<string, string>();
  for (const [node, comm] of communityOf) {
    const existing = rep.get(comm);
    if (existing === undefined || node.localeCompare(existing) < 0) {
      rep.set(comm, node);
    }
  }
  const canonical = new Map<string, string>();
  for (const [node, comm] of communityOf) {
    canonical.set(node, rep.get(comm)!);
  }
  return canonical;
}

/**
 * Aggregate communities into super-nodes: the returned graph has one node per
 * community, with edge weights summed so that each super-node's degree equals
 * the total degree of its members (intra-community weight becomes a self-loop).
 * `members` maps each super-node back to the original node ids it contains.
 */
function aggregate(
  graph: AdjacencyGraph,
  communityOf: Map<string, string>,
): { graph: AdjacencyGraph; members: Map<string, string[]> } {
  const members = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const comm = communityOf.get(node)!;
    const list = members.get(comm);
    if (list) list.push(node);
    else members.set(comm, [node]);
  }

  const edges: Array<{ a: string; b: string; weight: number }> = [];
  const superNodes = [...members.keys()].sort((a, b) => a.localeCompare(b));
  // Sum weights between/within communities. Each undirected pair is visited once
  // by iterating the symmetric adjacency and only taking a ≤ b (self included).
  for (const node of graph.nodes) {
    const commA = communityOf.get(node)!;
    const row = graph.adjacency.get(node) ?? new Map<string, number>();
    for (const [neighbor, weight] of row) {
      if (neighbor.localeCompare(node) < 0) continue; // count each pair once
      const commB = communityOf.get(neighbor)!;
      // The adjacency already stores each cross pair on both endpoints; taking
      // node ≤ neighbor once reconstructs the undirected weight exactly.
      edges.push({ a: commA, b: commB, weight });
    }
  }

  return {
    graph: buildAdjacency({ nodes: superNodes, edges }),
    members,
  };
}

/**
 * Detect communities in a weighted graph at a single resolution γ via the
 * Louvain method: local-moving then aggregation, repeated until a level stops
 * improving. Returns a flat node→community partition (community ids are the
 * lexicographically smallest member). Deterministic for a given graph + γ.
 */
export function louvain(graph: WeightedGraph, resolution: number): Partition {
  const base = buildAdjacency(graph);
  if (base.nodes.length === 0) return new Map();

  // Track the mapping from ORIGINAL nodes down through each aggregation level.
  let current = base;
  // originalToCurrent: original node id → its node id in the current level.
  let originalToCurrent = new Map<string, string>();
  for (const node of base.nodes) originalToCurrent.set(node, node);

  const levels: Level[] = [];
  let guard = 0;
  const maxLevels = base.nodes.length + 4;
  while (guard < maxLevels) {
    guard += 1;
    const { communityOf, moved } = localMoving(current, resolution);
    const canonical = canonicalizeCommunities(communityOf);
    levels.push({ communityOf: canonical });
    if (!moved) break;
    const { graph: nextGraph, members } = aggregate(current, canonical);
    if (nextGraph.nodes.length === current.nodes.length) break;
    current = nextGraph;
    void members;
  }

  // Fold every level's assignment back down to the original nodes.
  const result: Partition = new Map();
  for (const node of base.nodes) {
    let community = node;
    for (const level of levels) {
      community = level.communityOf.get(community) ?? community;
    }
    result.set(node, community);
  }
  return canonicalizeCommunities(result);
}

/**
 * Cluster the same graph at every resolution in the ladder, coarse→fine, and
 * return the partitions in ladder order. The multi-resolution family is the
 * input to scale-stability scoring (consensus.ts). Resolutions are applied in
 * the given order; the default ladder is {@link DEFAULT_RESOLUTIONS}.
 */
export function resolutionSweep(
  graph: WeightedGraph,
  resolutions: readonly number[] = DEFAULT_RESOLUTIONS,
): Partition[] {
  return resolutions.map((gamma) => louvain(graph, gamma));
}
