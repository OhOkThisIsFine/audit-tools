import type { GraphEdge } from "@audit-tools/shared";

// Analyzer edge confidences are set above their regex-floor counterparts so the
// group-aware merge below prefers the compiler-derived edge for the same
// (from, to) relationship. Floor import kinds sit at 0.95 (see graph.ts).
export const TS_IMPORT_EDGE_CONFIDENCE = 0.99;
export const TS_REEXPORT_EDGE_CONFIDENCE = 0.99;
export const TS_EXTENDS_EDGE_CONFIDENCE = 0.97;
export const TS_IMPLEMENTS_EDGE_CONFIDENCE = 0.97;
export const TS_CALL_EDGE_CONFIDENCE = 0.9;

/**
 * Kinds that represent the same underlying relationship collapse together during
 * a merge (highest confidence wins). Kinds with no group keep their distinct
 * (from, to, kind) identity — so floor-only relationships such as
 * `heuristic-container-edge` or `heuristic-auth-session-link` are never dropped
 * by an analyzer that happens to connect the same two nodes a different way.
 */
const EDGE_GROUP: Record<string, string> = {
  // import relationship
  esm: "import",
  "re-export": "import",
  "dynamic-import": "import",
  commonjs: "import",
  "ts-import": "import",
  "ts-reexport": "import",
  // inheritance relationship
  "ts-extends": "inheritance",
  "ts-implements": "inheritance",
  // call relationship
  "ts-call": "call",
};

function edgeGroupOf(edge: GraphEdge): string | undefined {
  return edge.kind ? EDGE_GROUP[edge.kind] : undefined;
}

function confidenceOf(edge: GraphEdge): number {
  return typeof edge.confidence === "number" && Number.isFinite(edge.confidence)
    ? edge.confidence
    : 0;
}

function groupedKey(edge: GraphEdge, group: string): string {
  return `${edge.from}\0${edge.to}\0${group}`;
}

function ungroupedKey(edge: GraphEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.kind ?? ""}`;
}

function sortEdges(edges: GraphEdge[]): GraphEdge[] {
  return edges.sort(
    (a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      (a.kind ?? "").localeCompare(b.kind ?? ""),
  );
}

/**
 * Merge analyzer edges into an existing floor bucket (e.g. `graphs.imports`).
 * Within a known relationship group, edges sharing (from, to) collapse to the
 * highest-confidence one (ties favour the later/analyzer edge); ungrouped kinds
 * keep their per-kind identity. Self-edges are dropped. Result is deduped and
 * sorted, matching the floor's ordering contract.
 */
export function mergeAnalyzerEdges(
  floor: GraphEdge[],
  analyzer: GraphEdge[],
): GraphEdge[] {
  const grouped = new Map<string, GraphEdge>();
  const ungrouped = new Map<string, GraphEdge>();

  for (const edge of [...floor, ...analyzer]) {
    if (edge.from === edge.to) continue;
    const group = edgeGroupOf(edge);
    if (group) {
      const key = groupedKey(edge, group);
      const existing = grouped.get(key);
      if (!existing || confidenceOf(edge) >= confidenceOf(existing)) {
        grouped.set(key, edge);
      }
    } else {
      ungrouped.set(ungroupedKey(edge), edge);
    }
  }

  return sortEdges([...grouped.values(), ...ungrouped.values()]);
}
