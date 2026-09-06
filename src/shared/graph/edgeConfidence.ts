// The one reading of a graph edge's stated confidence.
//
// It lives in `src/shared/graph/` — the established home for pure functions over
// the shared `GraphBundle`/`GraphEdge` contract (`graphPaths.ts`,
// `directedCycles.ts`) — and NOT in `src/shared/types/graph.ts`, which the
// duplication catalog proposed. That module holds only Zod schemas and their
// inferred types: zero functions, zero runtime logic. Putting behavior beside the
// schema declarations couples every type-only importer to a runtime module and
// sets the precedent that behavior accretes next to schemas.
import type { GraphEdge } from "../types/graph.js";

/**
 * A stated confidence, or 0 for an edge that never stated one.
 *
 * ⚠ The `Number.isFinite` guard is load-bearing and not defensive noise. A `NaN`
 * confidence makes EVERY comparison false, so a caller that picks the stronger of
 * two edges silently keeps whichever it happened to hold rather than the stronger
 * one — an arbitrary result that looks like a decision. Reading a non-finite value
 * as "never stated one" is both deterministic and what the contract means.
 */
export function edgeConfidence(edge: GraphEdge): number {
  return typeof edge.confidence === "number" && Number.isFinite(edge.confidence)
    ? edge.confidence
    : 0;
}
