import { createHash } from "node:crypto";
import type { GraphBundle, GraphEdge } from "@audit-tools/shared";

/**
 * Phase 4B — optional, bounded edge-reasoning pass.
 *
 * A deterministic transform that may only rewrite the human-readable `reason`
 * of existing low-confidence graph edges. It never adds, removes, re-targets, or
 * re-weights an edge: the `(from, to, kind, confidence, direction)` identity of
 * every edge is preserved exactly. Rewrites are host/provider-supplied (the same
 * conversation-first pattern as the Phase 6 synthesis narrative) — no in-process
 * LLM call. No rewrites (or the config flag off) → no-op, leaving the
 * deterministic graph byte-identical. This is part of the
 * `graph_enrichment_current` obligation.
 *
 * The pass is bounded to edges below a confidence floor (default 0.65) because
 * those are exactly the heuristic edges whose terse machine reason benefits from
 * a clearer explanation; high-confidence compiler/import edges are left alone.
 * {@link buildEdgeReasoningPrompt} and {@link edgeReasoningContentHash} let a
 * host produce and cache that single rewriting call by edge-set content hash.
 */

const EDGE_REASONING_VERSION = 1;
export const DEFAULT_EDGE_CONFIDENCE_FLOOR = 0.65;
/** Bound the candidate set so one pathological repo cannot balloon the call. */
export const MAX_REASONED_EDGES = 200;

/** One host-supplied reason rewrite, matched to an edge by (from, to, kind). */
export interface EdgeReasonRewrite {
  from: string;
  to: string;
  /** Optional; when omitted the rewrite matches any candidate with from+to. */
  kind?: string;
  reason: string;
}

export interface EdgeReasoningResults {
  rewrites: EdgeReasonRewrite[];
}

export interface EdgeReasoningOptions {
  /** Edges strictly below this confidence are candidates (default 0.65). */
  confidenceFloor?: number;
}

export interface EdgeReasoningSummary {
  rewritten: number;
  candidates: number;
}

function confidenceOf(edge: GraphEdge): number {
  return typeof edge.confidence === "number" && Number.isFinite(edge.confidence)
    ? edge.confidence
    : 0;
}

function edgeSignature(edge: GraphEdge): string {
  return `${edge.from}\0${edge.to}\0${edge.kind ?? ""}`;
}

/**
 * Collect the low-confidence edges (the actual edge objects, so the caller can
 * mutate `reason` in place) in a deterministic order. Routes are excluded — they
 * carry no `reason`/`confidence`.
 */
export function collectLowConfidenceEdges(
  bundle: GraphBundle,
  floor: number = DEFAULT_EDGE_CONFIDENCE_FLOOR,
): GraphEdge[] {
  const candidates: GraphEdge[] = [];
  for (const bucket of [
    bundle.graphs.imports,
    bundle.graphs.calls,
    bundle.graphs.references,
  ]) {
    for (const edge of bucket ?? []) {
      if (confidenceOf(edge) < floor) {
        candidates.push(edge);
      }
    }
  }
  return candidates
    .sort((a, b) => edgeSignature(a).localeCompare(edgeSignature(b)))
    .slice(0, MAX_REASONED_EDGES);
}

/** Stable content hash of the candidate edge set, for host-side call caching. */
export function edgeReasoningContentHash(candidates: GraphEdge[]): string {
  const basis = JSON.stringify({
    version: EDGE_REASONING_VERSION,
    edges: candidates.map((edge) => ({
      from: edge.from,
      to: edge.to,
      kind: edge.kind ?? "",
      confidence: confidenceOf(edge),
      reason: edge.reason ?? "",
    })),
  });
  return createHash("sha256").update(basis).digest("hex");
}

/** The single bounded prompt a host runs to produce {@link EdgeReasoningResults}. */
export function buildEdgeReasoningPrompt(candidates: GraphEdge[]): string {
  const lines = candidates.map(
    (edge) =>
      `- from: ${edge.from} | to: ${edge.to} | kind: ${edge.kind ?? "?"} | confidence: ${confidenceOf(edge).toFixed(2)} | current: ${edge.reason ?? "(none)"}`,
  );
  return [
    "You are improving the human-readable 'reason' for low-confidence edges in a code dependency graph.",
    "Each edge links a source file to a target file by a relationship 'kind'.",
    "For each edge you can improve, write one clear, specific sentence explaining why that relationship plausibly holds.",
    "Do NOT invent new edges, drop edges, or change which files are linked — only rewrite the reason text.",
    "Omit any edge whose reason you cannot improve.",
    "",
    "Edges:",
    ...lines,
    "",
    'Respond with JSON only: {"rewrites":[{"from":"...","to":"...","kind":"...","reason":"..."}]}',
  ].join("\n");
}

/**
 * Apply host-supplied reason rewrites to `bundle` (mutated in place). Only edges
 * below the confidence floor are eligible; a rewrite that matches no eligible
 * edge is ignored. Returns a summary; the edge set itself is invariant.
 */
export function applyEdgeReasoning(
  bundle: GraphBundle,
  results: EdgeReasoningResults | undefined,
  options: EdgeReasoningOptions = {},
): EdgeReasoningSummary {
  const floor = options.confidenceFloor ?? DEFAULT_EDGE_CONFIDENCE_FLOOR;
  const candidates = collectLowConfidenceEdges(bundle, floor);
  if (!results || !Array.isArray(results.rewrites) || candidates.length === 0) {
    return { rewritten: 0, candidates: candidates.length };
  }

  const bySignature = new Map<string, GraphEdge>();
  const byEndpoints = new Map<string, GraphEdge>();
  for (const edge of candidates) {
    bySignature.set(edgeSignature(edge), edge);
    const endpoints = `${edge.from}\0${edge.to}`;
    if (!byEndpoints.has(endpoints)) {
      byEndpoints.set(endpoints, edge);
    }
  }

  let rewritten = 0;
  const seen = new Set<GraphEdge>();
  for (const rewrite of results.rewrites) {
    if (
      !rewrite ||
      typeof rewrite.from !== "string" ||
      typeof rewrite.to !== "string" ||
      typeof rewrite.reason !== "string" ||
      rewrite.reason.trim().length === 0
    ) {
      continue;
    }
    const edge =
      rewrite.kind !== undefined
        ? bySignature.get(`${rewrite.from}\0${rewrite.to}\0${rewrite.kind}`)
        : byEndpoints.get(`${rewrite.from}\0${rewrite.to}`);
    if (!edge || seen.has(edge)) {
      continue;
    }
    edge.reason = rewrite.reason.trim();
    seen.add(edge);
    rewritten += 1;
  }

  return { rewritten, candidates: candidates.length };
}
