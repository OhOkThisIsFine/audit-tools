/**
 * The VERIFIED CALL-SITE MAP a design-review round receives as a read-only,
 * provenanced input.
 *
 * A 2026-07-19 design-check step ran four adversarial rounds; each spawned a
 * FRESH agent that re-grepped the same call-site map from scratch — roughly
 * 135k subagent tokens a round, nearly all of it identical recon. The instinct
 * that this buys independence is wrong in one specific way: it conflates
 * independence of VERDICT with independence of INPUT. What a round must not do
 * is judge work it authored. Being handed a factual map it did not produce
 * leaves the verdict entirely its own.
 *
 * So the map is derived ONCE, by the tool, from artifacts the round did not
 * produce either (the repository manifest and the dependency graph the audit
 * pipeline already extracted), and handed over labelled as prior verified recon.
 * It is a lane ASSET, not a submission: it is RENDERED into the round's prompt
 * (`renderReviewFileMap`), never written to a path any lane's write scope covers,
 * and no submission schema has a field for it — a round has no route by which to
 * write back, because the only thing it hands over is its own findings. Updates
 * go through a separate recon pass (the graph builder), which is the only thing
 * that can change what the next round receives. Otherwise the map quietly
 * absorbs one reviewer's assumption and reaches the next reviewer as fact.
 *
 * Deterministic and content-derived: every array is ordered by a stable key, so
 * the file does not churn between emissions of an unchanged round. A cap that
 * drops entries STATES the drop — a silently truncated map reads as a complete
 * one, which is the failure mode this whole artefact exists to avoid.
 */

import { compareCodeUnits } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";

/** How many call sites per anchor are listed before the drop is stated. */
const MAX_CALLERS_PER_ANCHOR = 25;

export interface ReviewFileMapAnchor {
  /** The repo-relative file the call sites below target. */
  path: string;
  /** Files that reference it (path-sorted), capped — see `callers_omitted`. */
  callers: string[];
  /** How many callers were dropped by the cap (0 when none were). */
  callers_omitted: number;
  /** Files it references (path-sorted), capped — see `callees_omitted`. */
  callees: string[];
  /** How many callees were dropped by the cap (0 when none were). */
  callees_omitted: number;
}

export interface ReviewFileMap {
  /** What produced this map — the provenance the reading lane is told to trust. */
  provenance: {
    /** `tool` — the map is machine-derived, never authored by a reviewer. */
    author: "tool";
    /** The artifacts the edges were read from. */
    sources: string[];
    /** Edges consulted, so a thin map is visibly thin rather than silently so. */
    edge_count: number;
    /** Whether an edge category was present at all in the graph. */
    graph_present: boolean;
  };
  /** The anchors, path-sorted. */
  anchors: ReviewFileMapAnchor[];
  /** Anchors dropped by the top-level cap, if any. */
  anchors_omitted: number;
  /**
   * Authored files the graph records NO edge for, so no anchor could be built.
   * Always stated: an omission the reading lane has to infer is the silent
   * truncation this artefact exists to avoid, and these are exactly the files
   * whose absence a round must not read as "nothing depends on it".
   */
  files_without_edges: number;
}

/** How many authored files are mapped before the drop is stated. */
const MAX_ANCHORS = 60;

/**
 * Build the map from the dependency graph the audit already extracted. Edges are
 * read in both directions per anchor — callers and callees — because the review
 * questions this feeds ("what does this change ripple into") need both and a
 * round that re-derives one direction has re-derived the whole thing.
 */
export function buildReviewFileMap(
  bundle: ArtifactBundle,
  options: { maxAnchors?: number } = {},
): ReviewFileMap {
  const maxAnchors = options.maxAnchors ?? MAX_ANCHORS;
  const graphs = bundle.graph_bundle?.graphs;
  const sources: string[] = [];
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  let edgeCount = 0;

  for (const [kind, edges] of Object.entries(graphs ?? {})) {
    if (!Array.isArray(edges)) continue;
    let kindCount = 0;
    for (const edge of edges) {
      if (
        typeof edge !== "object" ||
        edge === null ||
        typeof (edge as { from?: unknown }).from !== "string" ||
        typeof (edge as { to?: unknown }).to !== "string"
      ) {
        continue;
      }
      const { from, to } = edge as { from: string; to: string };
      if (from === to) continue;
      (outgoing.get(from) ?? outgoing.set(from, new Set()).get(from)!).add(to);
      (incoming.get(to) ?? incoming.set(to, new Set()).get(to)!).add(from);
      kindCount += 1;
    }
    if (kindCount > 0) sources.push(`${kind} (${kindCount} edge(s))`);
    edgeCount += kindCount;
  }
  sources.sort(compareCodeUnits);

  // Anchors are the files this repository actually authored — the manifest is the
  // authority on that, not the graph's node vocabulary, which may include
  // synthetic roots and external specifiers.
  const authored = (bundle.repo_manifest?.files ?? [])
    .map((file) => file.path)
    .sort(compareCodeUnits);

  const anchors: ReviewFileMapAnchor[] = [];
  let filesWithoutEdges = 0;
  for (const path of authored) {
    const callers = [...(incoming.get(path) ?? [])].sort(compareCodeUnits);
    const callees = [...(outgoing.get(path) ?? [])].sort(compareCodeUnits);
    if (callers.length === 0 && callees.length === 0) {
      filesWithoutEdges += 1;
      continue;
    }
    anchors.push({
      path,
      callers: callers.slice(0, MAX_CALLERS_PER_ANCHOR),
      callers_omitted: Math.max(0, callers.length - MAX_CALLERS_PER_ANCHOR),
      callees: callees.slice(0, MAX_CALLERS_PER_ANCHOR),
      callees_omitted: Math.max(0, callees.length - MAX_CALLERS_PER_ANCHOR),
    });
  }

  return {
    provenance: {
      author: "tool",
      sources,
      edge_count: edgeCount,
      graph_present: graphs !== undefined,
    },
    anchors: anchors.slice(0, maxAnchors),
    anchors_omitted: Math.max(0, anchors.length - maxAnchors),
    files_without_edges: filesWithoutEdges,
  };
}

/**
 * Render the map for a prompt. Returned as text rather than JSON so a lane reads
 * it as data-that-was-handed-over; the `provenance` block is stated FIRST and in
 * prose, because the whole point is that this lane did not author it.
 */
export function renderReviewFileMap(map: ReviewFileMap): string[] {
  const lines: string[] = [
    "### Verified call-site map (provenance: machine-derived prior recon — you did NOT author this)",
    "",
    "This map was produced by the audit tool from the dependency graph and the repository manifest " +
      "extracted earlier in this run. It is a factual input, handed to you so this round spends its " +
      "budget on judgment instead of re-deriving the same call-site map from scratch. You are " +
      "expected to TRUST it as a starting point, not to reproduce it.",
    "",
    "**You cannot write back to it.** It is not part of your submission and nothing you return " +
      "modifies it; a correction reaches the next round only through a fresh extraction pass. So if " +
      "it disagrees with what you find in the source, say so explicitly in your finding — name the " +
      "file and the symbol that contradicts the map. Silence would let a wrong map stand as an " +
      "unchallenged premise for the next round. Your VERDICT remains entirely your own; only the " +
      "recon is shared.",
    "",
    `Edges consulted: ${map.provenance.edge_count}` +
      (map.provenance.sources.length > 0
        ? ` — from ${map.provenance.sources.join(", ")}.`
        : map.provenance.graph_present
          ? " — the dependency graph carried no edges."
          : " — no dependency graph was available."),
    "",
  ];

  const noEdgeLine = (count: number): string =>
    `${count} authored file(s) carry no graph edge and are NOT listed — their absence is a gap ` +
    "in this extraction, not a finding that nothing depends on them.";

  if (map.anchors.length === 0) {
    lines.push(
      "No call sites are mapped (no graph edges connect the authored files). Treat this as NO " +
        "RECON rather than as a map showing everything is unconnected — the absence of an edge in " +
        "this repository's extraction is not evidence that no caller exists.",
      "",
    );
    if (map.files_without_edges > 0) {
      lines.push(noEdgeLine(map.files_without_edges), "");
    }
    return lines;
  }

  for (const anchor of map.anchors) {
    lines.push(`- **${anchor.path}**`);
    lines.push(
      `  - referenced by: ${anchor.callers.join(", ") || "(none recorded)"}` +
        (anchor.callers_omitted > 0
          ? ` — and ${anchor.callers_omitted} more not listed`
          : ""),
    );
    lines.push(
      `  - references: ${anchor.callees.join(", ") || "(none recorded)"}` +
        (anchor.callees_omitted > 0
          ? ` — and ${anchor.callees_omitted} more not listed`
          : ""),
    );
  }
  if (map.anchors_omitted > 0) {
    lines.push(
      "",
      `⚠ ${map.anchors_omitted} further file(s) with call sites are NOT listed above (this map is ` +
        "capped). Their absence is a cap, not a finding — do not report an unlisted file as having " +
        "no connections.",
    );
  }
  if (map.files_without_edges > 0) {
    // Distinct from the cap above: these are not omitted by a budget, they are
    // files the graph has no edge for at all. Both are drops, so both are stated.
    lines.push("", `⚠ ${noEdgeLine(map.files_without_edges)}`);
  }
  lines.push("");
  return lines;
}
