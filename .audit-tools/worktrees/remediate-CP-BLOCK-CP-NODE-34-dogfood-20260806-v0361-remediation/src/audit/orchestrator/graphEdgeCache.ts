/**
 * Persistence for the per-file graph-edge cache (C2 incremental graph-build).
 *
 * The cache is an internal incremental-reuse artifact, NOT a deliverable and NOT a
 * staleness-DAG node: it is self-describing (it carries the global `path_lookup_hash`
 * and a per-file `content_key`), so reuse validity is decided entirely by comparing
 * those against the fresh build — no `artifact_metadata` baseline is needed. Loaded
 * specially in `loadArtifactBundle` and written specially in `writeCoreArtifacts`
 * (the same pattern as `active_dispatch` / `design_review_snapshots`), so it never
 * needs an `ARTIFACT_DEFINITIONS` entry or a dependency-map row.
 */
import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "audit-tools/shared";
import type { GraphEdgeCache } from "../extractors/graph.js";

const GRAPH_EDGE_CACHE_FILENAME = "graph-edge-cache.json";

export function graphEdgeCachePath(artifactsDir: string): string {
  return join(artifactsDir, GRAPH_EDGE_CACHE_FILENAME);
}

export async function loadGraphEdgeCache(
  artifactsDir: string,
): Promise<GraphEdgeCache | undefined> {
  return readOptionalJsonFile<GraphEdgeCache>(graphEdgeCachePath(artifactsDir));
}

export async function writeGraphEdgeCache(
  artifactsDir: string,
  cache: GraphEdgeCache,
): Promise<void> {
  await writeJsonFile(graphEdgeCachePath(artifactsDir), cache);
}
