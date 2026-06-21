import type { GraphBundle, GraphEdge } from "audit-tools/shared";

/**
 * Whole-graph derived signals, single-sourced.
 *
 * The audit graph is built per-file by the language analyzers (compiler-fidelity
 * import/call/reference edges) and the regex floor. Several architectural
 * heuristics are not edges but *queries over the merged edge set* — cycles, hub
 * concentration, orphans, and the "deletion test" (low-in-degree leaves). These
 * were previously recomputed ad-hoc inside the design assessment; they live here
 * now so BOTH the design assessment and the risk register read one source of
 * truth, and so the risk register can finally weight graph-structural risk.
 *
 * Language-neutral by construction: it consumes only `from`/`to` node ids (repo
 * paths), so every analyzer that contributes import/call edges — TS, Python, … —
 * feeds these signals identically. No new dependency, no per-ecosystem fork.
 */
export interface GraphSignals {
  /**
   * Deduplicated directed cycles. Each entry is the node sequence of one cycle
   * (the cycle closes from the last node back to the first); rotations of the
   * same directed cycle are collapsed, distinct directed cycles over the same
   * node set are kept apart.
   */
  cycles: string[][];
  /** Per-node incoming edge count (number of edges whose `to` is the node). */
  fanIn: Map<string, number>;
  /** Per-node outgoing edge count (number of edges whose `from` is the node). */
  fanOut: Map<string, number>;
  /** Every node that participates in at least one cycle. */
  nodesInCycles: Set<string>;
  /** Hub nodes: `fanIn >= hubThreshold && fanOut >= hubThreshold`. */
  hubs: Set<string>;
  /** The fan-in/fan-out threshold a node must meet on both sides to be a hub. */
  hubThreshold: number;
  /**
   * Deletion-test candidates (the ralph-architecture-sweep heuristic): nodes that
   * nothing imports (`fanIn === 0`) yet which import others (`fanOut > 0`). A
   * low-in-degree leaf is an easy deletion/refactor target — though it may also be
   * a legitimate entrypoint (CLI main, test root), so this is an advisory signal
   * the LLM lenses adjudicate, not a verdict. Pure orphans (`fanIn === 0 &&
   * fanOut === 0`) are deliberately NOT here — those are the separate zero-edge
   * orphan signal ({@link connected}-based) and would otherwise double-report.
   */
  deletionCandidates: Set<string>;
  /** Every node touched by any edge (as `from` or `to`) — the connected set. */
  connected: Set<string>;
}

/**
 * Flatten every edge bucket of a graph bundle into one edge list. `routes` is
 * excluded (it is a `{path,handler,method}` shape, not a `from`/`to` edge);
 * malformed entries (missing string endpoints) are dropped so a bad analyzer
 * output can never throw here.
 */
export function allGraphEdges(graphBundle: GraphBundle): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [key, value] of Object.entries(graphBundle.graphs)) {
    if (key === "routes" || !Array.isArray(value)) continue;
    for (const edge of value) {
      if (edge && typeof edge.from === "string" && typeof edge.to === "string") {
        edges.push(edge);
      }
    }
  }
  return edges;
}

function dfsVisit(
  node: string,
  path: string[],
  adjacency: Map<string, Set<string>>,
  visited: Set<string>,
  stack: Set<string>,
  cycles: string[][],
): void {
  if (stack.has(node)) {
    const cycleStart = path.indexOf(node);
    if (cycleStart >= 0) {
      cycles.push(path.slice(cycleStart));
    }
    return;
  }
  if (visited.has(node)) return;

  visited.add(node);
  stack.add(node);
  path.push(node);

  for (const neighbor of adjacency.get(node) ?? []) {
    dfsVisit(neighbor, path, adjacency, visited, stack, cycles);
  }

  path.pop();
  stack.delete(node);
}

function detectCycles(adjacency: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  // Each DFS root gets a fresh per-DFS visited set so that nodes already fully
  // explored via one root are re-entered from a new root. This is required
  // because a shared visited set across DFS starts prevents detection of cycles
  // that are reachable from a later root only through an already-visited node
  // (the "diamond reachability" case). The stack (current DFS path) is still
  // per-path-bookkeeping and correctly identifies back-edges within each DFS.
  for (const node of adjacency.keys()) {
    const visited = new Set<string>();
    const stack = new Set<string>();
    dfsVisit(node, [], adjacency, visited, stack, cycles);
  }
  return cycles;
}

// Canonicalize a directed cycle by rotating it so the lexicographically
// smallest node leads, preserving order/direction. Rotation (not sort) keeps
// distinct directed cycles over the same node set apart (A→B→C→A vs A→C→B→A)
// while still deduping the same cycle discovered from different DFS start nodes
// (which differ only by rotation).
function canonicalCycleKey(cycle: string[]): string {
  if (cycle.length === 0) return "";
  let minIdx = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i]! < cycle[minIdx]!) minIdx = i;
  }
  const rotated = [...cycle.slice(minIdx), ...cycle.slice(0, minIdx)];
  return rotated.join("\0");
}

function deduplicateCycles(cycles: string[][]): string[][] {
  const seen = new Set<string>();
  const unique: string[][] = [];
  for (const cycle of cycles) {
    const normalized = canonicalCycleKey(cycle);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      unique.push(cycle);
    }
  }
  return unique;
}

/**
 * Derive every whole-graph signal from a graph bundle in one pass. Pure: no IO,
 * no mutation of the input — a deterministic function of the edge set, so the
 * structure executor (which has the live bundle) and the design-assessment
 * executor (which re-reads the persisted bundle) compute identical signals
 * without a new persisted artifact.
 */
export function deriveGraphSignals(graphBundle: GraphBundle): GraphSignals {
  const edges = allGraphEdges(graphBundle);

  const adjacency = new Map<string, Set<string>>();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  const connected = new Set<string>();

  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from)!.add(edge.to);
    fanOut.set(edge.from, (fanOut.get(edge.from) ?? 0) + 1);
    fanIn.set(edge.to, (fanIn.get(edge.to) ?? 0) + 1);
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const cycles = deduplicateCycles(detectCycles(adjacency));
  const nodesInCycles = new Set<string>();
  for (const cycle of cycles) {
    for (const node of cycle) nodesInCycles.add(node);
  }

  const hubThreshold = Math.max(8, Math.ceil(connected.size * 0.15));
  const hubs = new Set<string>();
  const deletionCandidates = new Set<string>();
  for (const node of connected) {
    const inCount = fanIn.get(node) ?? 0;
    const outCount = fanOut.get(node) ?? 0;
    if (inCount >= hubThreshold && outCount >= hubThreshold) {
      hubs.add(node);
    }
    if (inCount === 0 && outCount > 0) {
      deletionCandidates.add(node);
    }
  }

  return {
    cycles,
    fanIn,
    fanOut,
    nodesInCycles,
    hubs,
    hubThreshold,
    deletionCandidates,
    connected,
  };
}
