import { posix } from "node:path";
import { isRecord } from "../validation/basic.js";
import type { GraphBundle, GraphEdge } from "../types/graph.js";

/**
 * Graph-path + graph-edge primitives that operate purely on the shared
 * `GraphBundle`/`GraphEdge` contract — so they live in `audit-tools/shared`
 * where BOTH orchestrators (and the shared continuity scorer) can single-source
 * them. Audit re-exports `normalizeGraphPath` (from `extractors/graphPathUtils`)
 * and `collectGraphEdges` (from `orchestrator/reviewPacketGraphEdges`) from here
 * so its 28+ existing import sites are unchanged; remediate imports them for the
 * continuity consumer.
 */

/** Canonical repo-relative graph key: forward slashes, posix-normalized, no `./`. */
export function normalizeGraphPath(path: string): string {
  return posix
    .normalize(path.replace(/\\/g, "/"))
    .replace(/^\.\//, "");
}

/**
 * Flatten the import/call/reference buckets of a `graph_bundle` into a single
 * validated `GraphEdge[]`. Malformed entries (missing string `from`/`to`) are
 * skipped, never thrown on — a bad manifest degrades to fewer edges. Optional
 * `direction`/`confidence`/`reason` are carried through when well-formed;
 * `confidence` is clamped to [0,1].
 */
export function collectGraphEdges(graphBundle?: GraphBundle): GraphEdge[] {
  if (!graphBundle?.graphs) {
    return [];
  }
  const edges: GraphEdge[] = [];
  for (const key of ["imports", "calls", "references"]) {
    const raw = graphBundle.graphs[key];
    if (!Array.isArray(raw)) {
      continue;
    }
    for (const item of raw) {
      if (!isRecord(item)) {
        continue;
      }
      if (typeof item.from !== "string" || typeof item.to !== "string") {
        continue;
      }
      const edge: GraphEdge = {
        from: item.from,
        to: item.to,
        kind: typeof item.kind === "string" ? item.kind : undefined,
      };
      if (item.direction === "directed" || item.direction === "undirected") {
        edge.direction = item.direction;
      }
      if (typeof item.confidence === "number" && Number.isFinite(item.confidence)) {
        edge.confidence = Math.min(1, Math.max(0, item.confidence));
      }
      if (typeof item.reason === "string" && item.reason.trim().length > 0) {
        edge.reason = item.reason.trim();
      }
      edges.push(edge);
    }
  }
  return edges;
}
