import type { GraphBundle, GraphEdge, NodeMetric } from "audit-tools/shared";
import { GIT_CO_CHANGE_CATEGORY } from "./gitHistory.js";

/** A per-node structural metric surfaced as a flat, deterministically sorted row. */
export interface NodeMetricSignal {
  /** Repo-path node id the metric was computed for. */
  node: string;
  /** Raw metric value. */
  value: number;
  /** Concrete algorithm name (e.g. `cyclomatic-approx`, `duplicate-line-count`). */
  measure: string;
  /** Scope of source the measure actually covered. */
  reach: NodeMetric["reach"];
}

/**
 * A seam: an edge of the undirected graph projection whose removal disconnects
 * the two endpoints (a bridge / cut-edge). Seams flag the load-bearing single
 * connections in the dependency graph — the places where one link is the only
 * thing keeping two regions joined. `from`/`to` are sorted lexicographically so
 * the same undirected edge always has a stable orientation.
 */
export interface SeamSignal {
  from: string;
  to: string;
}

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
  /**
   * Per-node complexity rows READ from `bundle.node_metrics` (no source access,
   * no IO — a pure reader). Sorted by node id. Empty when node_metrics is
   * absent/malformed.
   */
  complexity: NodeMetricSignal[];
  /**
   * Per-node duplication rows READ from `bundle.node_metrics` (no source access,
   * no IO — a pure reader). Sorted by node id. Empty when node_metrics is
   * absent/malformed.
   */
  duplication: NodeMetricSignal[];
  /**
   * Seams: bridges / cut-edges of the UNDIRECTED projection of the merged edge
   * set ({@link allGraphEdges}). Derived (not read): parallel edges of differing
   * kind are merged so they are not misreported as bridges, self-loops are
   * dropped, and articulation/bridge detection runs via a low-link DFS that
   * terminates correctly across disconnected components. Sorted by from-then-to.
   */
  seams: SeamSignal[];
}

/**
 * Flatten every edge bucket of a graph bundle into one edge list. `routes` is
 * excluded (it is a `{path,handler,method}` shape, not a `from`/`to` edge); the
 * `co_change` bucket is excluded too — it is temporal coupling (git-history
 * mining), not a structural dependency, so it must never feed cycle / hub / seam
 * detection. Malformed entries (missing string endpoints) are dropped so a bad
 * analyzer output can never throw here.
 */
export function allGraphEdges(graphBundle: GraphBundle): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const [key, value] of Object.entries(graphBundle.graphs)) {
    if (key === "routes" || key === GIT_CO_CHANGE_CATEGORY || !Array.isArray(value)) {
      continue;
    }
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
 * Read one metric kind out of `bundle.node_metrics` into flat, node-id-sorted
 * rows. Pure reader — no source access, no IO. Degrades to empty for any
 * missing/malformed shape (node_metrics absent or not an object, a bad entry, a
 * metric missing its numeric `value` / string `measure` / string `reach`); a
 * malformed node_metrics can never throw here.
 */
function readNodeMetricSignals(
  graphBundle: GraphBundle,
  kind: "complexity" | "duplication",
): NodeMetricSignal[] {
  const metrics = (graphBundle as { node_metrics?: unknown }).node_metrics;
  if (!metrics || typeof metrics !== "object") return [];
  const signals: NodeMetricSignal[] = [];
  for (const [node, entry] of Object.entries(metrics as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const metric = (entry as Record<string, unknown>)[kind];
    if (!metric || typeof metric !== "object") continue;
    const { value, measure, reach } = metric as Record<string, unknown>;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      typeof measure !== "string" ||
      typeof reach !== "string"
    ) {
      continue;
    }
    signals.push({
      node,
      value,
      measure,
      reach: reach as NodeMetric["reach"],
    });
  }
  signals.sort((a, b) => a.node.localeCompare(b.node));
  return signals;
}

/**
 * Derive seams (bridges / cut-edges) over the UNDIRECTED projection of the
 * merged edge set. Steps:
 *  1. Project to undirected: each edge contributes an unordered {a,b} pair.
 *     Self-loops (a === b) are dropped. Parallel edges between the same pair —
 *     even of differing `kind` — collapse to ONE undirected edge, so a pair
 *     joined by two distinct edge kinds is NOT misreported as a bridge.
 *  2. Bridge detection via a low-link (Tarjan-style) DFS: an edge u–v is a
 *     bridge when low[v] > disc[u]. The DFS iterates every node as a root so it
 *     terminates correctly across disconnected components.
 * Degrades to empty (no edges → no seams) and never throws.
 */
function deriveSeams(edges: GraphEdge[]): SeamSignal[] {
  // Undirected adjacency keyed by node; a Set of neighbors collapses parallel
  // edges (any kind) to a single undirected link.
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue; // drop self-loops
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    if (!adjacency.has(edge.to)) adjacency.set(edge.to, new Set());
    adjacency.get(edge.from)!.add(edge.to);
    adjacency.get(edge.to)!.add(edge.from);
  }

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const bridges: SeamSignal[] = [];
  let timer = 0;

  // Iterative DFS (explicit stack) so deep graphs cannot overflow the call
  // stack. Each frame tracks the node, its parent, and an iterator over its
  // neighbors; bridge checks run as we pop children back up.
  for (const root of adjacency.keys()) {
    if (disc.has(root)) continue;
    const stack: Array<{
      node: string;
      parent: string | null;
      iter: Iterator<string>;
    }> = [
      {
        node: root,
        parent: null,
        iter: (adjacency.get(root) ?? new Set<string>()).values(),
      },
    ];
    disc.set(root, timer);
    low.set(root, timer);
    timer += 1;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.iter.next();
      if (next.done) {
        stack.pop();
        const parent = frame.parent;
        if (parent !== null) {
          // Fold this node's low-link up into its parent, then test the edge.
          const parentLow = Math.min(
            low.get(parent)!,
            low.get(frame.node)!,
          );
          low.set(parent, parentLow);
          if (low.get(frame.node)! > disc.get(parent)!) {
            const a = parent < frame.node ? parent : frame.node;
            const b = parent < frame.node ? frame.node : parent;
            bridges.push({ from: a, to: b });
          }
        }
        continue;
      }
      const neighbor = next.value;
      if (neighbor === frame.parent) continue; // skip the edge back to parent
      if (disc.has(neighbor)) {
        // Back-edge: tighten this node's low-link with the neighbor's disc time.
        low.set(
          frame.node,
          Math.min(low.get(frame.node)!, disc.get(neighbor)!),
        );
        continue;
      }
      disc.set(neighbor, timer);
      low.set(neighbor, timer);
      timer += 1;
      stack.push({
        node: neighbor,
        parent: frame.node,
        iter: (adjacency.get(neighbor) ?? new Set<string>()).values(),
      });
    }
  }

  bridges.sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
  return bridges;
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
    complexity: readNodeMetricSignals(graphBundle, "complexity"),
    duplication: readNodeMetricSignals(graphBundle, "duplication"),
    seams: deriveSeams(edges),
  };
}
