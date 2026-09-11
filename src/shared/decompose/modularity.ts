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
// ARITHMETIC ENVELOPE — what this module accepts, stated honestly. Weights must
// be finite and positive, and the GRAPH MASS (Σ degrees) must stay inside the
// exact-integer range; a graph past that is refused rather than silently
// approximated, because community membership must not depend on input order
// changing the rounding of very large repeated sums. Two narrower limits were
// removed after they refused ordinary inputs: the community-degree guard now
// scales its tolerance to the graph mass instead of a fixed 1e-12 (fractional
// weights around 1e5 drift past a fixed epsilon by float arithmetic alone), and
// the modularity penalty divides by 2m before multiplying by Σtot so the bounded
// VALUE is checked rather than an unbounded intermediate. NOT fixed: the degree
// guard binds at every AGGREGATED level, where super-node degrees are larger
// than any original node's, so the mass at which a graph is refused depends on
// how many Louvain levels it produces — which is data-dependent, and at γ > 1
// (more, smaller communities → more levels) not monotone in the input size.
// Nothing in this repo runs above γ = 1; a metric sweep that does should
// re-measure rather than assume the envelope scales smoothly.
//
// PURE + DETERMINISTIC: no IO, no Math.random, no Date. Ties are broken by
// lexical node/community id so the same graph always yields the same partition.
// Language-neutral by construction — it consumes only string node ids and numeric
// edge weights, so any source of coupling (call/import, git co-change, data/state)
// feeds it identically. Hand-rolled (community detection is an algorithm, not a
// grammar → outside the import-vetted-libs policy; owning it keeps full
// tie-break/determinism control).

import { compareCodeUnits } from "../compareCodeUnits.js";

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
 * Arithmetic above the exact-integer range is rejected even when JavaScript can
 * still represent a finite approximation. Community membership must not depend
 * on input order changing the rounding of very large repeated sums.
 */
const MAX_GRAPH_ARITHMETIC = Number.MAX_SAFE_INTEGER;

function assertNodeId(value: unknown, context: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${context} must be a non-empty string.`);
  }
}

function assertPositiveBounded(value: number, context: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > MAX_GRAPH_ARITHMETIC) {
    throw new RangeError(
      `${context} must be finite, positive, and at most ${MAX_GRAPH_ARITHMETIC}; got ${String(value)}.`,
    );
  }
}

function checkedAdd(left: number, right: number, context: string): number {
  const result = left + right;
  if (!Number.isFinite(result) || result < 0 || result > MAX_GRAPH_ARITHMETIC) {
    throw new RangeError(`${context} arithmetic is non-finite or out of bounds.`);
  }
  return result;
}

function checkedMultiply(left: number, right: number, context: string): number {
  const result = left * right;
  if (!Number.isFinite(result) || result < 0 || result > MAX_GRAPH_ARITHMETIC) {
    throw new RangeError(`${context} arithmetic is non-finite or out of bounds.`);
  }
  return result;
}

function assertSignedBounded(value: number, context: string): void {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_GRAPH_ARITHMETIC) {
    throw new RangeError(`${context} arithmetic is non-finite or out of bounds.`);
  }
}

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

export function buildAdjacency(graph: WeightedGraph): AdjacencyGraph {
  const normalizedEdges = graph.edges.map((edge, index) => {
    assertNodeId(edge.a, `Edge ${index} endpoint a`);
    assertNodeId(edge.b, `Edge ${index} endpoint b`);
    assertPositiveBounded(edge.weight, `Edge weight at index ${index}`);
    return compareCodeUnits(edge.a, edge.b) <= 0
      ? { a: edge.a, b: edge.b, weight: edge.weight }
      : { a: edge.b, b: edge.a, weight: edge.weight };
  });
  normalizedEdges.sort(
    (left, right) =>
      compareCodeUnits(left.a, right.a) ||
      compareCodeUnits(left.b, right.b) ||
      left.weight - right.weight,
  );

  for (let index = 0; index < graph.nodes.length; index++) {
    assertNodeId(graph.nodes[index], `Graph node at index ${index}`);
  }
  const nodes = [
    ...new Set([
      ...graph.nodes,
      ...normalizedEdges.flatMap((edge) => [edge.a, edge.b]),
    ]),
  ].sort(compareCodeUnits);
  const adjacency = new Map<string, Map<string, number>>();
  for (const node of nodes) adjacency.set(node, new Map());

  for (const edge of normalizedEdges) {
    const a = edge.a;
    const b = edge.b;
    const rowA = adjacency.get(a)!;
    const accumulated = checkedAdd(
      rowA.get(b) ?? 0,
      edge.weight,
      `Repeated-edge (${a}, ${b})`,
    );
    if (a === b) {
      rowA.set(a, accumulated);
      continue;
    }
    const rowB = adjacency.get(b)!;
    rowA.set(b, accumulated);
    rowB.set(a, accumulated);
  }

  const degree = new Map<string, number>();
  let degreeSum = 0;
  for (const node of nodes) {
    const row = adjacency.get(node) ?? new Map<string, number>();
    let deg = 0;
    for (const [neighbor, weight] of row) {
      // An undirected self-loop contributes two incident ends to degree. This is
      // essential after aggregation, where every intra-community edge becomes a
      // diagonal entry and must retain its original graph mass.
      const degreeContribution = neighbor === node
        ? checkedMultiply(weight, 2, `Degree self-loop for node ${node}`)
        : weight;
      deg = checkedAdd(deg, degreeContribution, `Degree for node ${node}`);
    }
    degree.set(node, deg);
    degreeSum = checkedAdd(degreeSum, deg, "Graph mass");
  }

  const totalWeight = degreeSum / 2;
  assertSignedBounded(totalWeight, "Graph mass");

  return {
    nodes,
    adjacency,
    degree,
    totalWeight,
  };
}

/**
 * Hard ceiling on local-moving passes at ONE hierarchy level — a floor under the
 * fixpoint, never the convergence criterion: the loop exits the moment a full
 * pass makes no move.
 *
 * MEASURED 2026-09-10, and the measurement corrects the premise this ceiling was
 * added under. The loop was bounded at `nodes + 8`, which reads like a pass
 * budget but is not the terminator: instrumenting the compiled loop over five
 * adversarial constructions — a banded dense graph, a SATURATED CLIQUE (the
 * dense shape refinement exists for), a 1,600-node chain, a two-scale nested
 * graph, and an LCG-sparse graph — gives ONE local-moving pass per level in
 * every case, at every level. A separate greedy-ascent replication confirms the
 * same shape from the other direction: the natural ascending sweep reaches its
 * fixpoint in 1-3 passes at n = 8…200. So the fixpoint always fires first.
 *
 * ⚠ THE CEILING IS THEREFORE NOT RED-DETECTABLE BY ANY TIMING TEST, and this is
 * stated rather than papered over: reverting it to `nodes + 8` leaves every
 * fixture partition byte-identical and every timing figure unchanged (verified —
 * `tests/shared/decompose.test.ts` + `tests/shared/content-coherence.test.ts`,
 * 51 passed both ways). It cannot bite a convergent run, and a PASS BUDGET is
 * not what bounds refinement cost anyway — that is the Θ(Σ degree) Louvain call
 * over a component carrying ~n² edges, pinned by
 * `tests/shared/content-coherence.test.ts`.
 *
 * What it protects is the non-convergent case, and the form of that protection
 * is what {@link localMovingPassBudget} exists to pin: at `nodes + 8` an O(n²)
 * pass on a saturated component was permitted O(n³) total; the budget is now
 * bounded by a CONSTANT independent of node count. A small constant cannot make
 * a convergent run converge differently; it bounds one that does not.
 */
export const MAX_LOCAL_MOVING_PASSES = 64;

/**
 * Pass budget for one level's local-moving loop: the node-count allowance,
 * SATURATED by {@link MAX_LOCAL_MOVING_PASSES} so the total work at one level is
 * bounded by a constant rather than by the graph size.
 *
 * Exported because it is the whole of the property the ceiling adds, and the
 * saturation is invisible to every behavioural input (see the constant's note).
 */
export function localMovingPassBudget(nodeCount: number): number {
  return Math.min(nodeCount + 8, MAX_LOCAL_MOVING_PASSES);
}

/** One level of the Louvain hierarchy: the community assignment per node. */
interface Level {
  /** node → community id (a representative node id). */
  communityOf: Map<string, string>;
}

/**
 * The loop's SECOND stop condition, and the only seam in it.
 *
 * Termination is normally the FIXPOINT (a full pass that moves nothing). The
 * pass ceiling exists for the case where that never arrives — and that case is
 * not reachable through any input: a measured sweep over banded-dense, clique,
 * chain, two-scale-nested, LCG-sparse and 1,200 randomized graphs (n = 6…200,
 * integral and fractional weights, γ = 0.5…2) reached its fixpoint in at most
 * 17 passes, against budgets of 14 to 64. So "the loop actually consults
 * {@link localMovingPassBudget}" is not observable from a `Partition`, and a
 * behavioral test cannot distinguish the budget from the retired `nodes + 8`:
 * measured, reverting it changes every fixture's partition and timing NOT AT
 * ALL.
 *
 * Hence this parameter: the caller's acceptance test for the partition a pass
 * reached. Left undefined — every production caller — the loop is exactly what
 * it always was. A caller that returns `false` refuses to stop at that
 * partition, which is precisely the non-convergent case the ceiling is for, and
 * makes the ceiling the terminator on demand. It is an ordinary predicate, so
 * the tests reach it through `louvain` and not through a parallel replica of the
 * loop: one definition, driven from the real entry point.
 *
 * Called once per pass, in order, at the end of that pass's sweep — on EVERY
 * pass, not only the ones that could end the loop, so a caller that also counts
 * them observes the loop rather than merely steering it. The return value only
 * matters where the fixpoint would otherwise stop it.
 */
export type PartitionAcceptance = (
  communityOf: ReadonlyMap<string, string>,
  levelIndex: number,
) => boolean;

/**
 * Local-moving phase: greedily move each node to the neighboring community that
 * most improves modularity at resolution γ, iterating in lexical node order until
 * a full pass makes no move. Returns node→community and whether anything moved.
 */
function localMoving(
  graph: AdjacencyGraph,
  resolution: number,
  partitionAccepted?: PartitionAcceptance,
  levelIndex = 0,
): { communityOf: Map<string, string>; moved: boolean } {
  const twoM = checkedMultiply(graph.totalWeight, 2, "Graph mass");
  // A community's degree is repeatedly added to and subtracted from as nodes
  // move, and floating-point residue from that scales with the MAGNITUDE of the
  // sums, not with a fixed absolute epsilon. A fixed -1e-12 therefore refused
  // ordinary fractional-weight graphs ("Community degree … became negative") as
  // soon as weights reached ~1e5 over ~100 nodes. Scale the tolerance to the
  // graph's own mass; a genuinely negative degree is a whole weight below zero
  // and stays far outside it.
  const negativeDegreeTolerance = Math.max(1e-9, twoM * 1e-12);
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
  // Terminate on the FIXPOINT (a full pass with no move) and carry a hard pass
  // ceiling as the floor under it — see {@link MAX_LOCAL_MOVING_PASSES} for why
  // the ceiling is a small constant and not the node count, and why shrinking it
  // cannot change a convergent partition.
  //
  // The ceiling is consulted through TWO conditions, and both are real: `guard`
  // counts passes against the budget, and `partitionAccepted` is the caller's
  // refusal to stop here. The second is undefined in production and the first is
  // never reached there either (measured: at most 17 passes against a budget of
  // 14–64), which is exactly why the budget needs a seam to be observed at all.
  let guard = 0;
  const maxPasses = localMovingPassBudget(graph.nodes.length);
  while (improved && guard < maxPasses) {
    improved = false;
    guard += 1;
    for (const node of graph.nodes) {
      const nodeDegree = graph.degree.get(node) ?? 0;
      const current = communityOf.get(node)!;
      // Remove node from its community.
      const remainingDegree = (communityDegree.get(current) ?? 0) - nodeDegree;
      assertSignedBounded(remainingDegree, `Community degree for ${current}`);
      if (remainingDegree < -negativeDegreeTolerance) {
        throw new RangeError(`Community degree for ${current} became negative.`);
      }
      communityDegree.set(current, Math.max(0, remainingDegree));

      // Weight from node into each candidate community (self-loop excluded — it
      // travels with the node and cannot distinguish communities).
      const weightToCommunity = new Map<string, number>();
      const row = graph.adjacency.get(node) ?? new Map<string, number>();
      for (const [neighbor, weight] of row) {
        if (neighbor === node) continue;
        const comm = communityOf.get(neighbor)!;
        weightToCommunity.set(
          comm,
          checkedAdd(
            weightToCommunity.get(comm) ?? 0,
            weight,
            `Modularity incident weight for ${node}`,
          ),
        );
      }

      // Isolation (staying in a fresh singleton) is the baseline: gain 0.
      let bestCommunity = current;
      let bestGain = 0;
      // Evaluate candidates in lexical order for a deterministic tie-break.
      const candidates = [...weightToCommunity.keys()].sort(compareCodeUnits);
      for (const comm of candidates) {
        const kiIn = weightToCommunity.get(comm) ?? 0;
        const sigmaTot = communityDegree.get(comm) ?? 0;
        const scaledDegree = checkedMultiply(
          resolution,
          nodeDegree,
          `Modularity resolution-degree product for ${node}`,
        );
        // DIVIDE BEFORE MULTIPLYING. The value γ·k_i·Σtot/2m is bounded by γ·k_i
        // because Σtot ≤ 2m, but the intermediate product γ·k_i·Σtot is not:
        // rescaling integral weights by 1e6 — the obvious way to make fractional
        // metrics exact — pushed it past MAX_SAFE_INTEGER and refused a graph
        // whose real arithmetic was nowhere near the limit. Bound the RESULT.
        const penalty = (scaledDegree / twoM) * sigmaTot;
        assertSignedBounded(penalty, `Modularity penalty for ${node}`);
        const gain = kiIn - penalty;
        assertSignedBounded(gain, `Modularity gain for ${node}`);
        if (
          gain > bestGain + 1e-12 ||
          (Math.abs(gain - bestGain) <= 1e-12 && compareCodeUnits(comm, bestCommunity) < 0)
        ) {
          bestGain = gain;
          bestCommunity = comm;
        }
      }

      // Re-add node to the chosen community.
      communityDegree.set(
        bestCommunity,
        checkedAdd(
          communityDegree.get(bestCommunity) ?? 0,
          nodeDegree,
          `Community degree for ${bestCommunity}`,
        ),
      );
      communityOf.set(node, bestCommunity);
      if (bestCommunity !== current) {
        improved = true;
        movedEver = true;
      }
    }
    // The caller's verdict on this pass's partition — see
    // {@link PartitionAcceptance}. Consulted ONLY where the fixpoint would
    // otherwise end the loop: a caller that accepts (the only kind production
    // has, by absence) leaves the stop condition exactly as it was, and a caller
    // that refuses replaces the fixpoint with the pass ceiling. Called on EVERY
    // pass, so a caller can also count them — which is the only way the ceiling
    // is observable at all.
    const accepted = partitionAccepted
      ? partitionAccepted(communityOf, levelIndex)
      : true;
    if (!improved && !accepted) {
      improved = true;
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
    if (existing === undefined || compareCodeUnits(node, existing) < 0) {
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
  const superNodes = [...members.keys()].sort(compareCodeUnits);
  // Sum weights between/within communities. Each undirected pair is visited once
  // by iterating the symmetric adjacency and only taking a ≤ b (self included).
  for (const node of graph.nodes) {
    const commA = communityOf.get(node)!;
    const row = graph.adjacency.get(node) ?? new Map<string, number>();
    for (const [neighbor, weight] of row) {
      if (compareCodeUnits(neighbor, node) < 0) continue; // count each pair once
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
export function louvain(
  graph: WeightedGraph,
  resolution: number,
  /**
   * The pass-level acceptance test — see {@link PartitionAcceptance}. Undefined
   * for every production caller, which is the loop exactly as it always was; a
   * caller that refuses every partition drives the ceiling instead of the
   * fixpoint, which is how the ceiling's own test observes it.
   */
  partitionAccepted?: PartitionAcceptance,
): Partition {
  assertPositiveBounded(resolution, "Modularity resolution");
  const base = buildAdjacency(graph);
  if (base.nodes.length === 0) return new Map();

  let current = base;

  const levels: Level[] = [];
  let guard = 0;
  const maxLevels = base.nodes.length + 4;
  while (guard < maxLevels) {
    guard += 1;
    const { communityOf, moved } = localMoving(
      current,
      resolution,
      partitionAccepted,
      levels.length,
    );
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
 * Score a partition with the resolution-parameterised modularity Q the
 * {@link louvain} local-moving phase optimises:
 *
 *   Q = Σ_c [ Σ_in(c)/m − γ·(Σ_tot(c)/2m)² ]
 *
 * where Σ_in(c) is the intra-community edge weight (each undirected pair counted
 * once, self-loops once), Σ_tot(c) the summed degree of its members, and m the
 * graph mass. The convention is self-consistent rather than universal, and that
 * is what it is for: the ONE trivial partition (every node in one community)
 * scores exactly `1 − γ`, so comparing a candidate partition against the whole
 * needs no tuned constant — at the canonical γ = 1 the comparison is against 0.
 *
 * Deterministic: communities are accumulated in lexical id order, so the same
 * graph and partition always yield the same float.
 */
export function modularityOf(
  graph: WeightedGraph,
  partition: Partition,
  resolution: number,
): number {
  assertPositiveBounded(resolution, "Modularity resolution");
  return modularityOfBase(buildAdjacency(graph), partition, resolution);
}

/**
 * {@link modularityOf} over an ALREADY-BUILT adjacency. Building one costs a
 * sort of every edge and the construction of two maps per node, which dominates
 * the score itself on a dense graph — and the one caller that compares two
 * partitions of the SAME graph (`refineAtModularityPeak`, which weighs a Louvain
 * proposal against keeping the component whole) was paying for that build twice
 * on identical input. `resolution` is passed through rather than re-validated:
 * the public entry point owns the guard, and a second one here would be a copy.
 */
export function modularityOfBase(
  base: AdjacencyGraph,
  partition: Partition,
  resolution: number,
): number {
  if (base.totalWeight === 0) return 0;
  const twoM = checkedMultiply(base.totalWeight, 2, "Graph mass");

  const internal = new Map<string, number>();
  const total = new Map<string, number>();
  for (const node of base.nodes) {
    const community = partition.get(node) ?? node;
    total.set(
      community,
      checkedAdd(
        total.get(community) ?? 0,
        base.degree.get(node) ?? 0,
        `Community degree for ${community}`,
      ),
    );
    const row = base.adjacency.get(node) ?? new Map<string, number>();
    for (const [neighbor, weight] of row) {
      // Visit each undirected pair once; a self-loop (neighbor === node) is not
      // skipped, so it contributes its weight exactly once.
      if (compareCodeUnits(neighbor, node) < 0) continue;
      if ((partition.get(neighbor) ?? neighbor) !== community) continue;
      internal.set(
        community,
        checkedAdd(
          internal.get(community) ?? 0,
          weight,
          `Community internal weight for ${community}`,
        ),
      );
    }
  }

  let quality = 0;
  for (const community of [...total.keys()].sort(compareCodeUnits)) {
    const share = (total.get(community) ?? 0) / twoM;
    quality += (internal.get(community) ?? 0) / base.totalWeight - resolution * share * share;
    assertSignedBounded(quality, `Modularity accumulation for ${community}`);
  }
  return quality;
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
