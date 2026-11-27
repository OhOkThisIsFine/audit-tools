// sites-pinned: tests/audit/review-packet-graph-context.test.ts, tests/audit/review-packets.test.ts
import type { GraphEdge } from "audit-tools/shared";
import { normalizeGraphPath } from "../extractors/graphPathUtils.js";

// Graph-edge primitives for packet presentation and quality metrics: scoring,
// ordering and degree indexing. Membership comes exclusively from shared
// content coherence.

/**
 * Fan-in / fan-out degree above which a node is treated as a hub. Exported so
 * the delta-scope expansion skips the same hubs that the packet metrics count,
 * preventing scope blow-up through highly-connected modules.
 */
export const HIGH_FAN_DEGREE_THRESHOLD = 12;

export function graphEdgeConfidence(edge: GraphEdge): number {
  if (typeof edge.confidence === "number" && Number.isFinite(edge.confidence)) {
    return Math.min(1, Math.max(0, edge.confidence));
  }
  if (edge.kind === "heuristic-container-edge") {
    return 0.25;
  }
  if (edge.kind?.startsWith("heuristic-")) {
    return 0.5;
  }
  return 0.8;
}

export function isConcreteGraphEdge(edge: GraphEdge): boolean {
  return edge.kind !== "heuristic-container-edge";
}

export interface GraphDegreeIndex {
  fanIn: Map<string, number>;
  fanOut: Map<string, number>;
}

export function buildGraphDegreeIndex(edges: GraphEdge[]): GraphDegreeIndex {
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();

  for (const edge of edges) {
    if (!isConcreteGraphEdge(edge)) {
      continue;
    }
    const from = normalizeGraphPath(edge.from);
    const to = normalizeGraphPath(edge.to);
    fanOut.set(from, (fanOut.get(from) ?? 0) + 1);
    fanIn.set(to, (fanIn.get(to) ?? 0) + 1);
  }

  return { fanIn, fanOut };
}
