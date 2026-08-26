import type { AuditTask } from "../types.js";
import type { GraphEdge } from "audit-tools/shared";
import { collectGraphEdges, compareCodeUnits } from "audit-tools/shared";
import { normalizeGraphPath } from "../extractors/graphPathUtils.js";

// Graph-edge primitives: collection, scoring, degree indexing, expansion
// predicate, and group-key utilities used only for presentation metrics.
// Membership comes exclusively from shared content coherence.
// `collectGraphEdges` is single-sourced in `audit-tools/shared` (the shared
// continuity scorer needs it too) and re-exported here so this barrel's
// consumers are unchanged.
export { normalizeGraphPath, collectGraphEdges };

const PACKET_EXPANSION_MIN_CONFIDENCE = 0.65;
/**
 * Fan-in / fan-out degree above which a node is treated as a hub. Exported so
 * the Phase 3 delta-scope expansion skips the same hubs that packet planning
 * skips, preventing scope blow-up through highly-connected modules.
 */
export const HIGH_FAN_DEGREE_THRESHOLD = 12;
const HIGH_FAN_EXPANSION_CONFIDENCE = 0.99;

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

/**
 * Stable edge ordering: confidence descending, then content-derived tiebreak.
 * Lives beside `graphEdgeConfidence` because it sorts by it — co-located so the
 * comparator's delta arithmetic cannot drift away from the score it reads.
 */
export function compareGraphEdges(a: GraphEdge, b: GraphEdge): number {
  const confidenceDelta = graphEdgeConfidence(b) - graphEdgeConfidence(a);
  if (confidenceDelta !== 0) return confidenceDelta;
  return (
    compareCodeUnits(a.from, b.from) ||
    compareCodeUnits(a.to, b.to) ||
    compareCodeUnits(a.kind ?? "", b.kind ?? "")
  );
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

export function isPacketExpansionEdge(
  edge: GraphEdge,
  degreeIndex: GraphDegreeIndex,
): boolean {
  if (!isConcreteGraphEdge(edge)) {
    return false;
  }
  const confidence = graphEdgeConfidence(edge);
  if (confidence < PACKET_EXPANSION_MIN_CONFIDENCE) {
    return false;
  }

  const fromFanOut = degreeIndex.fanOut.get(normalizeGraphPath(edge.from)) ?? 0;
  const toFanIn = degreeIndex.fanIn.get(normalizeGraphPath(edge.to)) ?? 0;
  const highFanEdge =
    fromFanOut > HIGH_FAN_DEGREE_THRESHOLD ||
    toFanIn > HIGH_FAN_DEGREE_THRESHOLD;

  return !highFanEdge || confidence >= HIGH_FAN_EXPANSION_CONFIDENCE;
}

export function buildFileToGroupKeys(
  groups: Map<string, AuditTask[]>,
): Map<string, Set<string>> {
  const fileToGroupKeys = new Map<string, Set<string>>();
  for (const [key, tasks] of groups) {
    for (const path of new Set(tasks.flatMap((task) => task.file_paths))) {
      const normalized = normalizeGraphPath(path);
      const existing = fileToGroupKeys.get(normalized) ?? new Set<string>();
      existing.add(key);
      fileToGroupKeys.set(normalized, existing);
    }
  }
  return fileToGroupKeys;
}
