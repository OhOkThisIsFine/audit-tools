import type { GraphBundle, GraphEdge } from "audit-tools/shared";
import { isRecord } from "audit-tools/shared";
import type {
  ReviewPacketGraphEdge,
  ReviewPacketQuality,
} from "../types/reviewPlanning.js";
import { normalizeGraphPath } from "../extractors/graphPathUtils.js";
import { isConcreteGraphEdge, graphEdgeConfidence } from "./reviewPacketGraphEdges.js";

// Packet-level graph context: entrypoint extraction, internal/boundary edge
// classification, cohesion scoring, key-edge selection. Consumed by buildPacket
// in reviewPackets.ts and by prompt rendering in dispatch.ts.

const MAX_PACKET_KEY_EDGES = 8;
const MAX_PACKET_BOUNDARY_FILES = 12;

export function roundQuality(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function compareGraphEdges(a: GraphEdge, b: GraphEdge): number {
  const confidenceDelta = graphEdgeConfidence(b) - graphEdgeConfidence(a);
  if (confidenceDelta !== 0) return confidenceDelta;
  return (
    a.from.localeCompare(b.from) ||
    a.to.localeCompare(b.to) ||
    (a.kind ?? "").localeCompare(b.kind ?? "")
  );
}

function reviewPacketGraphEdge(edge: GraphEdge): ReviewPacketGraphEdge {
  const result: ReviewPacketGraphEdge = {
    from: edge.from,
    to: edge.to,
    confidence: graphEdgeConfidence(edge),
  };
  if (edge.kind) result.kind = edge.kind;
  if (edge.reason) result.reason = edge.reason;
  return result;
}

function packetEntrypoints(
  filePaths: string[],
  graphBundle?: GraphBundle,
): string[] {
  const fileSet = new Set(filePaths.map(normalizeGraphPath));
  const routes = Array.isArray(graphBundle?.graphs.routes)
    ? graphBundle.graphs.routes
    : [];

  return routes
    .filter(
      (route) =>
        isRecord(route) &&
        typeof route.handler === "string" &&
        typeof route.path === "string" &&
        fileSet.has(normalizeGraphPath(route.handler)),
    )
    .map((route) => {
      const method = typeof route.method === "string" ? `${route.method} ` : "";
      return `${method}${route.path} -> ${route.handler}`;
    })
    .sort((a, b) => a.localeCompare(b));
}

export function buildPacketGraphContext(
  filePaths: string[],
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
): {
  keyEdges: ReviewPacketGraphEdge[];
  boundaryFiles: string[];
  entrypoints: string[];
  quality: ReviewPacketQuality;
} {
  const fileSet = new Set(filePaths.map(normalizeGraphPath));
  const internalEdges: GraphEdge[] = [];
  const boundaryFiles = new Set<string>();
  let boundaryEdgeCount = 0;

  for (const edge of graphEdges) {
    if (!isConcreteGraphEdge(edge)) {
      continue;
    }
    const fromInPacket = fileSet.has(normalizeGraphPath(edge.from));
    const toInPacket = fileSet.has(normalizeGraphPath(edge.to));
    if (fromInPacket && toInPacket) {
      internalEdges.push(edge);
    } else if (fromInPacket !== toInPacket) {
      boundaryEdgeCount += 1;
      boundaryFiles.add(fromInPacket ? edge.to : edge.from);
    }
  }

  const internallyConnectedFiles = new Set<string>();
  for (const edge of internalEdges) {
    internallyConnectedFiles.add(normalizeGraphPath(edge.from));
    internallyConnectedFiles.add(normalizeGraphPath(edge.to));
  }

  const unexplainedFileCount =
    filePaths.length <= 1
      ? 0
      : filePaths.filter(
          (path) => !internallyConnectedFiles.has(normalizeGraphPath(path)),
        ).length;
  const cohesionScore =
    filePaths.length <= 1
      ? 1
      : Math.min(1, internalEdges.length / (filePaths.length - 1));

  return {
    keyEdges: internalEdges
      .sort(compareGraphEdges)
      .slice(0, MAX_PACKET_KEY_EDGES)
      .map(reviewPacketGraphEdge),
    boundaryFiles: [...boundaryFiles]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_PACKET_BOUNDARY_FILES),
    entrypoints: packetEntrypoints(filePaths, graphBundle),
    quality: {
      cohesion_score: roundQuality(cohesionScore),
      internal_edge_count: internalEdges.length,
      boundary_edge_count: boundaryEdgeCount,
      unexplained_file_count: unexplainedFileCount,
    },
  };
}
