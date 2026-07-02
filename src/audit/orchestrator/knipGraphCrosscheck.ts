import type {
  GraphBundle,
  SurfaceManifest,
  CriticalFlowManifest,
} from "audit-tools/shared";
import { allGraphEdges } from "../extractors/graphSignals.js";
import { ANALYZER_REGISTRY } from "../extractors/analyzers/registry.js";

/**
 * Render-time knip↔graph cross-check tag for a single knip "unused export" lead.
 *
 * - `LIKELY-DEAD`   — the lead file has normalized in-degree 0, is NOT a known
 *                     entrypoint, AND its own language analyzer actually ran
 *                     (present in `graph_bundle.analyzers_used`). Only then is a
 *                     zero-in-degree verdict trustworthy for this file.
 * - `HAS-IMPORTERS` — the lead file has normalized in-degree > 0 (something
 *                     imports it) → refutes "dead".
 * - `ENTRYPOINT`    — in-degree 0 but the file is a surface/critical-flow
 *                     entrypoint → reachable by definition, not dead.
 * - `UNVERIFIED`    — `analyzers_used` is empty OR the lead's language analyzer
 *                     is absent from it → per-file graph fidelity is unknown, so
 *                     the graph cannot confirm or refute deadness.
 */
export type KnipGraphTag =
  | "LIKELY-DEAD"
  | "HAS-IMPORTERS"
  | "UNVERIFIED"
  | "ENTRYPOINT";

/**
 * A pre-derived, normalized index over one {@link GraphBundle} +
 * surface/critical-flow entrypoints, ready for O(1) lookups per lead.
 *
 * CE-001: `deriveGraphSignals` keys fanIn by the RAW `edge.to`, so a
 * Windows-backslash / mixed-case graph node id (`src\\Foo.ts`) never matches a
 * POSIX-normalized knip lead path (`src/Foo.ts`). This index re-keys EVERY node
 * (both `from` and `to` endpoints) and every entrypoint through
 * `normalizeNodeKey` (POSIX separators, `./` stripped, lower-cased) so the lead
 * path — normalized the same way — matches regardless of separator or case.
 */
export interface KnipGraphIndex {
  /** Normalized node id → incoming edge count over the structural edge set. */
  inDegree: Map<string, number>;
  /** Normalized entrypoint paths from surface_manifest + critical_flows. */
  entrypoints: Set<string>;
  /** Analyzer ids that actually ran (from graph_bundle.analyzers_used). */
  analyzersUsed: Set<string>;
}

/**
 * Normalize a graph node id / path / entrypoint to one comparable key:
 * backslashes → forward slashes, leading `./` stripped, lower-cased. Single
 * source so the index and every lookup key agree (CE-001).
 */
export function normalizeNodeKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * Map a lead file's extension to the id of the language analyzer that owns it
 * (CE-003). Reuses the analyzer registry's own `supports(file)` predicate
 * so extension→analyzer stays single-sourced in the analyzers, not duplicated.
 * Returns null when no registered analyzer claims the file.
 */
export function analyzerIdForFile(path: string): string | null {
  for (const analyzer of ANALYZER_REGISTRY) {
    if (analyzer.supports(path)) return analyzer.id;
  }
  return null;
}

/**
 * Build the normalized cross-check index from the three artifacts. Degrades to
 * empty (never throws) on any missing/malformed input — an absent bundle yields
 * an empty index whose every lead classifies UNVERIFIED.
 */
export function buildKnipGraphIndex(params: {
  graphBundle?: GraphBundle;
  surfaceManifest?: SurfaceManifest;
  criticalFlows?: CriticalFlowManifest;
}): KnipGraphIndex {
  const inDegree = new Map<string, number>();
  const entrypoints = new Set<string>();
  const analyzersUsed = new Set<string>();

  const { graphBundle, surfaceManifest, criticalFlows } = params;

  if (graphBundle?.graphs) {
    for (const edge of allGraphEdges(graphBundle)) {
      const to = normalizeNodeKey(edge.to);
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
      // Ensure `from`-only nodes are still known (in-degree 0), so a lead that
      // appears only as an edge source is treated as present-but-uncited, not
      // absent. Lookups default missing keys to 0 anyway; recording the source
      // node keeps the index a faithful node set.
      const from = normalizeNodeKey(edge.from);
      if (!inDegree.has(from)) inDegree.set(from, 0);
    }
  }

  for (const surface of surfaceManifest?.surfaces ?? []) {
    if (typeof surface.entrypoint === "string") {
      entrypoints.add(normalizeNodeKey(surface.entrypoint));
    }
  }
  for (const flow of criticalFlows?.flows ?? []) {
    for (const entry of flow.entrypoints ?? []) {
      if (typeof entry === "string") entrypoints.add(normalizeNodeKey(entry));
    }
  }

  for (const id of graphBundle?.analyzers_used ?? []) {
    if (typeof id === "string") analyzersUsed.add(id);
  }

  return { inDegree, entrypoints, analyzersUsed };
}

/**
 * Classify one knip lead path against the pre-built index. Pure: no IO, no
 * mutation. See {@link KnipGraphTag} for the decision table.
 */
export function classifyKnipLead(
  leadPath: string,
  index: KnipGraphIndex,
): KnipGraphTag {
  const key = normalizeNodeKey(leadPath);
  const inDegree = index.inDegree.get(key) ?? 0;

  if (inDegree > 0) return "HAS-IMPORTERS";
  if (index.entrypoints.has(key)) return "ENTRYPOINT";

  // In-degree 0 and non-entrypoint: only trust the "dead" reading when this
  // file's OWN language analyzer actually ran (per-file fidelity, CE-003).
  const analyzerId = analyzerIdForFile(leadPath);
  if (
    index.analyzersUsed.size === 0 ||
    analyzerId === null ||
    !index.analyzersUsed.has(analyzerId)
  ) {
    return "UNVERIFIED";
  }
  return "LIKELY-DEAD";
}
