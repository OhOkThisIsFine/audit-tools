import type { AccessMemory } from "./types/accessMemory.js";
import type { GraphBundle } from "./types/graph.js";
import { collectGraphEdges, normalizeGraphPath } from "./graph/graphPaths.js";

/**
 * Continuity scoring (context-efficiency access-memory track, increment 2b/2d).
 *
 * SINGLE-SOURCED in `audit-tools/shared` so BOTH orchestrators consume the
 * identical scorer — the auditor/remediator mirroring the harvest core
 * (`deriveAccessMemoryFromEvents`) already established. Audit re-exports
 * `computeContinuityScores` (thin adapter, byte-identical) and biases review-
 * packet ORDERING with it; remediate biases file-ownership sub-wave admission.
 *
 * Turns the per-run `access_memory.json` record (which files earlier steps
 * covered/edited, with step-ordinal recency) into a per-file continuity score
 * used to bias later work toward files already in play — the known god-file-
 * re-read waste hotspot.
 *
 * The score is an *ideal composition* (per the design of record), NOT a cheap
 * tier-ladder: a recency×frequency seed propagated over the language-neutral
 * dependency graph via **deterministic personalized PageRank**. Recency/frequency
 * are the seed; the graph is the propagation, so a touched file lifts its
 * structural neighbours too (direct + structural continuity). The derived
 * ORDERING is deterministic — power iteration runs to a FIXED count (no
 * convergence-threshold nondeterminism), node/neighbour iteration is sorted
 * (stable float accumulation order for a given runtime), and step-ordinal recency
 * keeps wall-clock out of the signal. (The raw float scores are not claimed
 * bit-portable across V8 versions, but they are never persisted or hashed — only
 * the `access_memory.json` integer counters are — and the mass rounding in
 * {@link continuityMassForPaths} absorbs ULP differences well before they could
 * flip an ordering.)
 *
 * When there is no graph (remediate has no `graph_bundle` at dispatch), pass
 * `graphBundle` as `undefined`: adjacency is empty and PageRank degrades to a
 * pure recency×frequency seed ordering — a valid, weaker continuity signal.
 *
 * Scores are derived JIT at dispatch and never persisted (only the raw counters
 * in `access_memory.json` are). Returns an empty map when there is no signal yet
 * (no access-memory, or every record has zero frequency) — callers treat an empty
 * map as "no bias", so behaviour is identical to pre-continuity on the first steps.
 */
const PAGERANK_ALPHA = 0.85;
const PAGERANK_ITERATIONS = 20;
/** Per-step recency decay in STEP-ORDINAL space (not wall-clock). */
const RECENCY_DECAY = 0.9;
/** `edited` weighted above `covered` — an edit is stronger continuity than a read. */
const EDITED_WEIGHT = 3;

function pushNeighbour(
  adjacency: Map<string, Set<string>>,
  from: string,
  to: string,
): void {
  let set = adjacency.get(from);
  if (!set) {
    set = new Set<string>();
    adjacency.set(from, set);
  }
  set.add(to);
}

export function computeContinuityScores(
  accessMemory: AccessMemory | undefined,
  graphBundle: GraphBundle | undefined,
): Map<string, number> {
  if (!accessMemory || accessMemory.paths.length === 0) {
    return new Map();
  }

  // 1. Seed vector: recency(step-ordinal decay) × frequency, edited > covered.
  const totalOrdinals = Math.max(1, accessMemory.total_ordinals);
  const seed = new Map<string, number>();
  for (const record of accessMemory.paths) {
    const frequency = record.covered_count + EDITED_WEIGHT * record.edited_count;
    if (frequency <= 0) continue;
    const stepsAgo = Math.max(0, totalOrdinals - 1 - record.last_ordinal);
    const recency = Math.pow(RECENCY_DECAY, stepsAgo);
    const path = normalizeGraphPath(record.path);
    seed.set(path, (seed.get(path) ?? 0) + frequency * recency);
  }
  if (seed.size === 0) {
    return new Map();
  }
  // Normalize the seed to a probability distribution (the PageRank personalization
  // vector) so α/(1-α) teleport mass is well-defined. Guard seedTotal>0 (not just
  // seed.size>0): if every seeded record is so many step-ordinals stale that its
  // recency underflows to 0, seedTotal is 0 and the division would poison every
  // score with NaN — degrade to "no signal" instead.
  const seedTotal = [...seed.values()].reduce((sum, value) => sum + value, 0);
  if (!(seedTotal > 0)) {
    return new Map();
  }
  for (const [key, value] of seed) {
    seed.set(key, value / seedTotal);
  }

  // 2. Undirected structural adjacency over the same edge set packet planning
  //    uses. Continuity flows both ways along an edge: a touched file makes its
  //    neighbours likely-relevant regardless of import/call direction. Parallel
  //    edges are deduped so a hub isn't over-weighted by edge multiplicity.
  const adjacency = new Map<string, Set<string>>();
  const nodes = new Set<string>(seed.keys());
  for (const edge of collectGraphEdges(graphBundle)) {
    const from = normalizeGraphPath(edge.from);
    const to = normalizeGraphPath(edge.to);
    if (from === to) continue;
    nodes.add(from);
    nodes.add(to);
    pushNeighbour(adjacency, from, to);
    pushNeighbour(adjacency, to, from);
  }

  // Sorted node list + sorted neighbour lists → stable float accumulation order.
  const nodeList = [...nodes].sort();
  const neighbours = new Map<string, string[]>();
  for (const node of nodeList) {
    const set = adjacency.get(node);
    neighbours.set(node, set ? [...set].sort() : []);
  }

  // 3. Personalized PageRank via power iteration to a FIXED count (deterministic).
  //    rank₀ = seed distribution; dangling (no-neighbour) mass teleports back to
  //    the seed distribution so an isolated touched file keeps its score.
  let rank = new Map<string, number>();
  for (const node of nodeList) {
    rank.set(node, seed.get(node) ?? 0);
  }
  for (let iteration = 0; iteration < PAGERANK_ITERATIONS; iteration++) {
    const next = new Map<string, number>();
    for (const node of nodeList) {
      next.set(node, (1 - PAGERANK_ALPHA) * (seed.get(node) ?? 0));
    }
    let danglingMass = 0;
    for (const node of nodeList) {
      const r = rank.get(node) ?? 0;
      const outs = neighbours.get(node) ?? [];
      if (outs.length === 0) {
        danglingMass += r;
        continue;
      }
      const share = (PAGERANK_ALPHA * r) / outs.length;
      for (const neighbour of outs) {
        next.set(neighbour, (next.get(neighbour) ?? 0) + share);
      }
    }
    if (danglingMass > 0) {
      for (const [node, seedShare] of seed) {
        next.set(node, (next.get(node) ?? 0) + PAGERANK_ALPHA * danglingMass * seedShare);
      }
    }
    rank = next;
  }

  return rank;
}

/**
 * Sum a work-unit's member-file continuity scores (rounded to fixed precision so
 * ULP-level float differences can't reorder units). Higher = more of the unit's
 * files are connected to already-touched code. Single-sourced so audit's
 * per-packet mass and remediate's per-block mass reduce identically — both
 * normalize each path with {@link normalizeGraphPath} to match the scorer's seed
 * keys, and both round at 1e6 so the derived ordering is stable.
 */
export function continuityMassForPaths(
  paths: readonly string[],
  scores: Map<string, number>,
): number {
  let sum = 0;
  for (const path of paths) {
    sum += scores.get(normalizeGraphPath(path)) ?? 0;
  }
  return Math.round(sum * 1e6) / 1e6;
}
