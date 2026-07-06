// Structure-layer source adapter (Phase B): turns the audit graph substrate into
// the independently-sourced views the overlay-and-delta operator consumes. PURE —
// the async extraction (comment/doc reads, git co-change) happens in the executor;
// this module only shapes already-gathered signals into partitions.
//
// Behavior-exhibited sources (call/import, git co-change, data/state) each become
// a WEIGHTED GRAPH clustered across the resolution ladder → a multi-resolution
// partition family (feeds both agreed-across-source and stable-across-scale).
// Intent-declared sources (directory depths, docs, comments) each become one or
// more PARTITIONS over the same file universe (feed agreed-across-source only).

import type {
  DecompositionSource,
  GraphBundle,
  Partition,
} from "audit-tools/shared";
import { resolutionSweep } from "audit-tools/shared";
import { allGraphEdges } from "../extractors/graphSignals.js";
import { GIT_CO_CHANGE_CATEGORY } from "../extractors/gitHistory.js";
import {
  deriveDataStateCoupling,
  type CouplingEdge,
} from "../extractors/dataStateCoupling.js";

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Aggregate undirected edges over the universe into a WeightedGraph. */
function weightedGraph(
  universe: string[],
  edges: CouplingEdge[],
): { nodes: string[]; edges: CouplingEdge[] } {
  const inScope = new Set(universe);
  const byPair = new Map<string, number>();
  for (const edge of edges) {
    const a = toPosix(edge.a);
    const b = toPosix(edge.b);
    if (a === b || !inScope.has(a) || !inScope.has(b)) continue;
    if (!(edge.weight > 0)) continue;
    const lo = a.localeCompare(b) <= 0 ? a : b;
    const hi = a.localeCompare(b) <= 0 ? b : a;
    const key = `${lo} ${hi}`;
    byPair.set(key, (byPair.get(key) ?? 0) + edge.weight);
  }
  const aggregated: CouplingEdge[] = [];
  for (const [key, weight] of byPair) {
    const idx = key.indexOf(" ");
    aggregated.push({ a: key.slice(0, idx), b: key.slice(idx + 1), weight });
  }
  return { nodes: universe, edges: aggregated };
}

/** Directed graph edges → undirected coupling edges (weight = confidence or 1). */
function edgesFromGraph(
  raw: unknown,
): CouplingEdge[] {
  if (!Array.isArray(raw)) return [];
  const out: CouplingEdge[] = [];
  for (const edge of raw) {
    if (
      !edge ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string"
    ) {
      continue;
    }
    const weight =
      typeof edge.confidence === "number" && edge.confidence > 0
        ? edge.confidence
        : 1;
    out.push({ a: edge.from, b: edge.to, weight });
  }
  return out;
}

/** Build a single partition from disjoint member groups; ungrouped → singleton. */
function partitionFromGroups(
  universe: string[],
  groups: string[][],
): Partition {
  const partition: Partition = new Map();
  for (const node of universe) partition.set(node, node);
  for (const group of groups) {
    const rep = [...group].sort((a, b) => a.localeCompare(b))[0];
    if (!rep) continue;
    for (const member of group) {
      const m = toPosix(member);
      if (partition.has(m)) partition.set(m, rep);
    }
  }
  return partition;
}

/** Directory-prefix partition at a given depth (community = first `depth` segs). */
function directoryPartition(universe: string[], depth: number): Partition {
  const partition: Partition = new Map();
  for (const node of universe) {
    const segs = node.split("/");
    // A file with fewer than depth+1 segments has no dir at this depth → itself.
    const community =
      segs.length > depth ? segs.slice(0, depth).join("/") : node;
    partition.set(node, community);
  }
  return partition;
}

export interface StructureSourcesInput {
  /** In-scope files (posix, sorted, unique) — the shared node universe. */
  universe: string[];
  graphBundle: GraphBundle;
  /** Comment cross-reference edges from deriveCommentDecomposition. */
  commentEdges: CouplingEdge[];
  /** Doc-declared groups from deriveDocGroups. */
  docGroups: string[][];
  resolutions?: readonly number[];
  /** Directory depths for the intent directory family (default [1,2,3]). */
  directoryDepths?: number[];
}

const DEFAULT_DIRECTORY_DEPTHS = [1, 2, 3];

/**
 * Build the structure-layer decomposition sources. Behavior sources with no edges
 * and intent sources with no non-trivial grouping are omitted so an empty source
 * never dilutes the agreement mean.
 */
export function buildStructureSources(
  input: StructureSourcesInput,
): DecompositionSource[] {
  const universe = [...new Set(input.universe.map(toPosix))].sort((a, b) =>
    a.localeCompare(b),
  );
  const sources: DecompositionSource[] = [];

  // --- Behavior-exhibited sources ---
  const callImport = weightedGraph(
    universe,
    allGraphEdges(input.graphBundle).map((e) => ({
      a: e.from,
      b: e.to,
      weight: typeof e.confidence === "number" && e.confidence > 0 ? e.confidence : 1,
    })),
  );
  if (callImport.edges.length > 0) {
    sources.push({
      id: "call_import",
      family: "behavior",
      partitions: resolutionSweep(callImport, input.resolutions),
    });
  }

  const coChangeRaw = (
    input.graphBundle.graphs as Record<string, unknown>
  )[GIT_CO_CHANGE_CATEGORY];
  const coChange = weightedGraph(universe, edgesFromGraph(coChangeRaw));
  if (coChange.edges.length > 0) {
    sources.push({
      id: "co_change",
      family: "behavior",
      partitions: resolutionSweep(coChange, input.resolutions),
    });
  }

  const dataState = weightedGraph(
    universe,
    deriveDataStateCoupling(input.graphBundle),
  );
  if (dataState.edges.length > 0) {
    sources.push({
      id: "data_state",
      family: "behavior",
      partitions: resolutionSweep(dataState, input.resolutions),
    });
  }

  // --- Intent-declared sources ---
  const depths = input.directoryDepths ?? DEFAULT_DIRECTORY_DEPTHS;
  const directoryPartitions = depths.map((d) => directoryPartition(universe, d));
  // Include the directory source only when at least one depth actually groups
  // files (a flat repo with all files at the root yields only singletons).
  const directoryGroups = directoryPartitions.some((p) =>
    hasNonTrivialGroup(p),
  );
  if (directoryGroups) {
    sources.push({
      id: "directory",
      family: "intent",
      partitions: directoryPartitions,
    });
  }

  if (input.docGroups.length > 0) {
    sources.push({
      id: "docs",
      family: "intent",
      partitions: [partitionFromGroups(universe, input.docGroups)],
    });
  }

  const commentGraph = weightedGraph(universe, input.commentEdges);
  if (commentGraph.edges.length > 0) {
    // Comment cross-references are a coupling graph; cluster it at the ladder so a
    // comment web forms boundaries the same way behavior graphs do.
    sources.push({
      id: "comments",
      family: "intent",
      partitions: resolutionSweep(commentGraph, input.resolutions),
    });
  }

  return sources;
}

function hasNonTrivialGroup(partition: Partition): boolean {
  const counts = new Map<string, number>();
  for (const comm of partition.values()) {
    counts.set(comm, (counts.get(comm) ?? 0) + 1);
  }
  for (const count of counts.values()) if (count >= 2) return true;
  return false;
}
