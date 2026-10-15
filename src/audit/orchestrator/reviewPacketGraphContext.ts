// sites-pinned: tests/audit/review-packet-graph-context.test.ts, tests/audit/review-packets.test.ts
import type { GraphBundle, GraphEdge } from "audit-tools/shared";
import { isRecord, compareCodeUnits } from "audit-tools/shared";
import type {
  ReviewPacketGraphEdge,
  ReviewPacketQuality,
} from "../types/reviewPlanning.js";
import { normalizeGraphPath } from "../extractors/graphPathUtils.js";
import {
  isConcreteGraphEdge,
  graphEdgeConfidence,
  compareGraphEdges,
} from "./reviewPacketGraphEdges.js";

// Packet-level graph context: entrypoint extraction, internal/boundary edge
// classification, cohesion scoring, key-edge selection. Consumed by buildPacket
// in reviewPackets.ts and by prompt rendering in dispatch.ts.

const MAX_PACKET_KEY_EDGES = 8;
const MAX_PACKET_BOUNDARY_FILES = 12;

export function roundQuality(value: number): number {
  return Math.round(value * 1000) / 1000;
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

/** Immutable-input, synchronous-call-local incidence index; never persisted. */
export interface PacketGraphContextIndex {
  readonly graphEdges: readonly GraphEdge[];
  readonly edgeOrdinalsByPath: ReadonlyMap<string, readonly number[]>;
  readonly routesByHandler: ReadonlyMap<
    string,
    readonly { ordinal: number; route: Record<string, unknown> }[]
  >;
}

export function createPacketGraphContextIndex(
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
): PacketGraphContextIndex {
  const edgeOrdinalsByPath = new Map<string, number[]>();
  graphEdges.forEach((edge, ordinal) => {
    // A self-edge (including aliased endpoints) has only one incidence entry.
    const endpoints = new Set([
      normalizeGraphPath(edge.from),
      normalizeGraphPath(edge.to),
    ]);
    for (const path of endpoints) {
      const ordinals = edgeOrdinalsByPath.get(path) ?? [];
      ordinals.push(ordinal);
      edgeOrdinalsByPath.set(path, ordinals);
    }
  });
  const routesByHandler = new Map<
    string,
    { ordinal: number; route: Record<string, unknown> }[]
  >();
  const routes = Array.isArray(graphBundle?.graphs.routes)
    ? graphBundle.graphs.routes
    : [];
  routes.forEach((route, ordinal) => {
    if (
      !isRecord(route) ||
      typeof route.handler !== "string" ||
      typeof route.path !== "string"
    ) return;
    const handler = normalizeGraphPath(route.handler);
    const occurrences = routesByHandler.get(handler) ?? [];
    occurrences.push({ ordinal, route });
    routesByHandler.set(handler, occurrences);
  });
  return { graphEdges, edgeOrdinalsByPath, routesByHandler };
}

function packetEntrypoints(
  fileSet: ReadonlySet<string>,
  index: PacketGraphContextIndex,
): string[] {
  const entrypoints: string[] = [];
  for (const path of fileSet) {
    for (const { route } of index.routesByHandler.get(path) ?? []) {
      const method = typeof route.method === "string" ? `${route.method} ` : "";
      entrypoints.push(`${method}${route.path} -> ${route.handler}`);
    }
  }
  return entrypoints.sort((a, b) => compareCodeUnits(a, b));
}

/** Direct-call seam; planning shares one index across its packet materializations. */
export function buildPacketGraphContext(
  filePaths: string[],
  graphEdges: GraphEdge[],
  graphBundle?: GraphBundle,
) {
  return buildPacketGraphContextFromIndex(
    filePaths,
    createPacketGraphContextIndex(graphEdges, graphBundle),
  );
}

export function buildPacketGraphContextFromIndex(
  filePaths: string[],
  index: PacketGraphContextIndex,
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

  const incidentOrdinals = new Set<number>();
  for (const path of fileSet) {
    for (const ordinal of index.edgeOrdinalsByPath.get(path) ?? []) {
      incidentOrdinals.add(ordinal);
    }
  }
  // Restore source order before the stable comparator sort: reason is not a key.
  // Ordinals dedupe selection, never distinct equal-valued edge occurrences.
  for (const ordinal of [...incidentOrdinals].sort((a, b) => a - b)) {
    const edge = index.graphEdges[ordinal]!;
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
      .sort((a, b) => compareCodeUnits(a, b))
      .slice(0, MAX_PACKET_BOUNDARY_FILES),
    entrypoints: packetEntrypoints(fileSet, index),
    quality: {
      cohesion_score: roundQuality(cohesionScore),
      internal_edge_count: internalEdges.length,
      boundary_edge_count: boundaryEdgeCount,
      unexplained_file_count: unexplainedFileCount,
    },
  };
}
