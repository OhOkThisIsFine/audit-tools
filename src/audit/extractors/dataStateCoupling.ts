// Data/state coupling extractor (Phase B behavior-exhibited source; design of
// record spec/conceptual-design-review-design.md §"Structure decomposition
// sources"): "code touching the same artifact/state even with no direct call."
//
// Realized deterministically + language-neutrally as BIBLIOGRAPHIC COUPLING: two
// files that reference the SAME targets are coupled through that shared state,
// even when neither calls the other. This is distinct from the direct
// call/import source (which is the edges themselves) — here the signal is shared
// OUT-neighbors, computed purely from the existing structural edge set (no file
// reads, no new IO).
//
// A target referenced by nearly everything (a ubiquitous util / logger) carries
// no grouping signal — like a stop-word — so targets whose in-degree exceeds a
// genericness cap are dropped before pairing. This also bounds the cost: a hub
// with N referrers would otherwise contribute O(N²) pairs.

import type { GraphBundle } from "audit-tools/shared";
import { allGraphEdges } from "./graphSignals.js";

/** An undirected weighted coupling edge (canonical `a < b`). */
export interface CouplingEdge {
  a: string;
  b: string;
  weight: number;
}

export interface DataStateCouplingOptions {
  /**
   * A target is "generic" (dropped) once its referrer count exceeds
   * max(genericAbsolute, genericFraction × universe). Ubiquitous targets carry no
   * grouping signal and would otherwise couple everything.
   */
  genericFraction?: number;
  genericAbsolute?: number;
  /** Minimum shared-target count for an edge to be emitted. */
  minSharedTargets?: number;
}

const DEFAULT_GENERIC_FRACTION = 0.25;
const DEFAULT_GENERIC_ABSOLUTE = 12;
const DEFAULT_MIN_SHARED_TARGETS = 2;

/**
 * Derive data/state coupling edges from a graph bundle's structural edges. Two
 * source files sharing K non-generic targets get one undirected edge of weight K.
 * Deterministic: edges are canonicalized (`a < b`) and sorted by (a, b). Degrades
 * to `[]` for an edgeless / malformed bundle (never throws).
 */
export function deriveDataStateCoupling(
  graphBundle: GraphBundle,
  options: DataStateCouplingOptions = {},
): CouplingEdge[] {
  const genericFraction = options.genericFraction ?? DEFAULT_GENERIC_FRACTION;
  const genericAbsolute = options.genericAbsolute ?? DEFAULT_GENERIC_ABSOLUTE;
  const minSharedTargets = options.minSharedTargets ?? DEFAULT_MIN_SHARED_TARGETS;

  const edges = allGraphEdges(graphBundle);
  if (edges.length === 0) return [];

  // target → set of source files that reference it (self-references dropped).
  const referrersByTarget = new Map<string, Set<string>>();
  const sources = new Set<string>();
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    sources.add(edge.from);
    let referrers = referrersByTarget.get(edge.to);
    if (!referrers) {
      referrers = new Set();
      referrersByTarget.set(edge.to, referrers);
    }
    referrers.add(edge.from);
  }

  const genericThreshold = Math.max(
    genericAbsolute,
    Math.ceil(sources.size * genericFraction),
  );

  // Accumulate shared-target counts per source pair, over non-generic targets.
  const sharedByPair = new Map<string, number>();
  for (const referrers of referrersByTarget.values()) {
    if (referrers.size < 2 || referrers.size > genericThreshold) continue;
    const members = [...referrers].sort((a, b) => a.localeCompare(b));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const key = `${members[i]} ${members[j]}`;
        sharedByPair.set(key, (sharedByPair.get(key) ?? 0) + 1);
      }
    }
  }

  const result: CouplingEdge[] = [];
  for (const [key, weight] of sharedByPair) {
    if (weight < minSharedTargets) continue;
    const idx = key.indexOf(" ");
    result.push({ a: key.slice(0, idx), b: key.slice(idx + 1), weight });
  }
  result.sort((x, y) => x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return result;
}
