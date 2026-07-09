import type { AuditTask } from "../types.js";
import type { GraphEdge } from "audit-tools/shared";
import { collectGraphEdges } from "audit-tools/shared";
import { UnionFind } from "./unionFind.js";
import { normalizeGraphPath } from "../extractors/graphPathUtils.js";

// Graph-edge primitives: collection, scoring, degree indexing, expansion
// predicate, group-key utilities, and the union-find merge step that derives
// the initial clustering from shared-file links and filtered graph edges.
// Imported by reviewPacketGraphClustering and reviewPacketGraph (barrel).
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

export function unionFindFromGroups(
  groups: Map<string, AuditTask[]>,
  graphEdges: GraphEdge[],
): UnionFind {
  const uf = new UnionFind(groups.keys());
  const fileToGroupKeys = buildFileToGroupKeys(groups);
  const degreeIndex = buildGraphDegreeIndex(graphEdges);
  const verbose = Boolean(process.env.AUDIT_CODE_VERBOSE);

  for (const keys of fileToGroupKeys.values()) {
    const [first, ...rest] = [...keys].sort((a, b) => a.localeCompare(b));
    if (!first) continue;
    for (const key of rest) {
      if (verbose) {
        const rootBefore = uf.find(key);
        const rootFirst = uf.find(first);
        uf.union(first, key);
        if (rootFirst !== rootBefore) {
          process.stderr.write(
            `[audit-code:packet-planning] shared-file merge: "${first}" + "${key}" (roots "${rootFirst}" + "${rootBefore}" → "${uf.find(first)}")\n`,
          );
        }
      } else {
        uf.union(first, key);
      }
    }
  }

  for (const edge of graphEdges) {
    const fromGroups = fileToGroupKeys.get(normalizeGraphPath(edge.from));
    const toGroups = fileToGroupKeys.get(normalizeGraphPath(edge.to));
    if (!isPacketExpansionEdge(edge, degreeIndex)) {
      if (verbose && fromGroups && toGroups) {
        // Edge has group mappings but was filtered — check if it was the
        // high fan-degree guard specifically.
        const fromFanOut = degreeIndex.fanOut.get(normalizeGraphPath(edge.from)) ?? 0;
        const toFanIn = degreeIndex.fanIn.get(normalizeGraphPath(edge.to)) ?? 0;
        const highFanEdge =
          fromFanOut > HIGH_FAN_DEGREE_THRESHOLD ||
          toFanIn > HIGH_FAN_DEGREE_THRESHOLD;
        if (highFanEdge) {
          process.stderr.write(
            `[audit-code:packet-planning] edge skip (high-fan-degree): "${edge.from}" → "${edge.to}" (fanOut=${fromFanOut}, fanIn=${toFanIn})\n`,
          );
        }
      }
      continue;
    }
    if (!fromGroups || !toGroups) {
      continue;
    }
    for (const fromKey of fromGroups) {
      for (const toKey of toGroups) {
        if (verbose) {
          const rootFrom = uf.find(fromKey);
          const rootTo = uf.find(toKey);
          uf.union(fromKey, toKey);
          if (rootFrom !== rootTo) {
            process.stderr.write(
              `[audit-code:packet-planning] edge-driven merge: "${fromKey}" + "${toKey}" via edge "${edge.from}" → "${edge.to}" (kind=${edge.kind ?? "unknown"})\n`,
            );
          }
        } else {
          uf.union(fromKey, toKey);
        }
      }
    }
  }

  return uf;
}
