// sites-pinned: tests/audit/systemic-challenge.test.ts, tests/audit/review-file-map-context.test.ts
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
 * It is a lane ASSET, not a submission: the complete render
 * (`renderReviewFileMap`) reaches the round as a READ-ONLY context file the lane
 * materializer writes and binds into the lane's review binding, so acceptance
 * re-hashes it and refuses a submission made against an edited copy; the prompt
 * carries only a summary and the file's path (`reviewFileMapContext`). The file
 * is never on a path any lane's write scope covers, and no submission schema has
 * a field for it — a round has no route by which to write back, because the
 * only thing it hands over is its own findings. Updates
 * go through a separate recon pass (the graph builder), which is the only thing
 * that can change what the next round receives. Otherwise the map quietly
 * absorbs one reviewer's assumption and reaches the next reviewer as fact.
 *
 * The map is SCOPED to what the reading round reviews — the files its own prompt
 * names as under review, which only the consumer knows: every file in that scope
 * gets an anchor carrying its COMPLETE caller and callee lists, and nothing outside
 * it is anchored. There is no cap. An earlier version anchored the path-sorted
 * FIRST 60 authored files and listed at most 25 call sites each — neither number
 * measured — so on a repository with more connected files a round received recon
 * for files that merely sort early and had to re-derive the map for the ones it
 * was judging, the exact waste this artefact exists to remove. Whatever the map
 * leaves out (in-scope files with no edge, files outside the scope) is STATED in
 * the render: a silently thin map reads as a complete one.
 *
 * Deterministic and content-derived: every array is ordered by a stable key, so
 * the file does not churn between emissions of an unchanged round.
 */

import { compareCodeUnits } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";

/**
 * The files a reading round reviews — the set the map anchors, completely. The
 * consumer derives it from what its own prompt names as under review (it is the
 * only party that knows), so the map and the prompt cannot disagree about it.
 */
export interface ReviewFileMapScope {
  /** Repo-relative paths under review. Deduplicated and path-sorted by the map. */
  files: readonly string[];
  /** One clause naming what this scope is, stated to the reading lane. */
  basis: string;
}

export interface ReviewFileMapAnchor {
  /** The repo-relative file the call sites below target. */
  path: string;
  /** Every file that references it, path-sorted. */
  callers: string[];
  /** Every file it references, path-sorted. */
  callees: string[];
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
  /** What the map covers — stated to the reading lane before the anchors. */
  scope: {
    basis: string;
    /** Files under review: each is anchored or counted in `files_without_edges`. */
    file_count: number;
    /**
     * Authored (manifest) files outside the scope, so not anchored. Stated in the
     * render: an unanchored file is outside this map, not unconnected.
     */
    outside_scope: number;
  };
  /** One anchor per in-scope file the graph connects, path-sorted. */
  anchors: ReviewFileMapAnchor[];
  /**
   * In-scope files the graph records NO edge for, so no anchor could be built.
   * Always stated: an omission the reading lane has to infer is the silent
   * truncation this artefact exists to avoid, and these are exactly the files
   * whose absence a round must not read as "nothing depends on it".
   */
  files_without_edges: number;
}

/**
 * Build the map from the dependency graph the audit already extracted. Edges are
 * read in both directions per anchor — callers and callees — because the review
 * questions this feeds ("what does this change ripple into") need both and a
 * round that re-derives one direction has re-derived the whole thing. Anchors are
 * exactly the files in `scope`; their callers and callees are whatever the graph
 * records, in or out of scope.
 */
export function buildReviewFileMap(
  bundle: ArtifactBundle,
  scope: ReviewFileMapScope,
): ReviewFileMap {
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

  const inScope = [...new Set(scope.files)].sort(compareCodeUnits);
  const inScopeSet = new Set(inScope);
  const outsideScope = (bundle.repo_manifest?.files ?? []).filter(
    (file) => !inScopeSet.has(file.path),
  ).length;

  const anchors: ReviewFileMapAnchor[] = [];
  let filesWithoutEdges = 0;
  for (const path of inScope) {
    const callers = [...(incoming.get(path) ?? [])].sort(compareCodeUnits);
    const callees = [...(outgoing.get(path) ?? [])].sort(compareCodeUnits);
    if (callers.length === 0 && callees.length === 0) {
      filesWithoutEdges += 1;
      continue;
    }
    anchors.push({ path, callers, callees });
  }

  return {
    provenance: {
      author: "tool",
      sources,
      edge_count: edgeCount,
      graph_present: graphs !== undefined,
    },
    scope: {
      basis: scope.basis,
      file_count: inScope.length,
      outside_scope: outsideScope,
    },
    anchors,
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
    `Scope: ${map.scope.basis} — ${map.scope.file_count} file(s) under review. Every one the graph ` +
      "connects is listed below with its COMPLETE caller and callee lists; nothing is capped.",
    "",
  ];
  if (map.scope.outside_scope > 0) {
    lines.push(
      `${map.scope.outside_scope} other authored file(s) lie outside this scope and are not ` +
        "anchored; they still appear as callers or callees wherever an edge reaches them. An " +
        "unanchored file is outside this map, not unconnected — derive its call sites yourself " +
        "if your review follows the code there.",
      "",
    );
  }

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
    lines.push(`  - referenced by: ${anchor.callers.join(", ") || "(none recorded)"}`);
    lines.push(`  - references: ${anchor.callees.join(", ") || "(none recorded)"}`);
  }
  if (map.files_without_edges > 0) {
    // In-scope files the graph has no edge for at all: a drop, so it is stated.
    lines.push("", `⚠ ${noEdgeLine(map.files_without_edges)}`);
  }
  lines.push("");
  return lines;
}

/** A file the tool generates for a lane — the shape a lane spec's `generatedContext` carries. */
export interface ReviewFileMapContextFile {
  filename: string;
  label: string;
  text: string;
}

/** One build of the map, split into what the prompt carries and what the file carries. */
export interface ReviewFileMapContext {
  /** The prompt's share: provenance, the read-only rule, scope and counts, where the file is. */
  summaryLines: string[];
  /** The complete render, written read-only beside the lane prompt and bound into its review. */
  contextFile: ReviewFileMapContextFile;
}

/** The context file's name. Its directory is content-addressed by the lane materializer. */
const REVIEW_FILE_MAP_FILENAME = "review-call-site-map.md";

/**
 * Split one map into the prompt summary and the read-only context file, so the
 * two cannot come from different builds. The complete map is uncapped and can be
 * large, so the prompt does not inline it: it states the provenance, the
 * read-only rule and every count the map's own render states (scope, anchors,
 * edge-less files, files outside the scope), and points at the file the lane
 * materializer lists under its "Read-only context files" section.
 */
export function reviewFileMapContext(map: ReviewFileMap): ReviewFileMapContext {
  const noRecon = "so the map is NO RECON — an absent edge is not evidence that no caller exists";
  const edges =
    map.provenance.sources.length > 0
      ? `from ${map.provenance.sources.join(", ")}`
      : map.provenance.graph_present
        ? `the dependency graph carried no edges, ${noRecon}`
        : `no dependency graph was available, ${noRecon}`;
  const summaryLines = [
    "### Verified call-site map (provenance: machine-derived prior recon — you did NOT author this)",
    "",
    "The audit tool derived a call-site map from the dependency graph and the repository manifest " +
      `extracted earlier in this run and wrote it to the read-only file \`${REVIEW_FILE_MAP_FILENAME}\`, ` +
      'whose full path is listed under "Read-only context files" at the end of this prompt. Read it ' +
      "BEFORE re-deriving any call site: it is a factual input handed to you so this round spends its " +
      "budget on judgment, and you are expected to TRUST it as a starting point, not to reproduce it.",
    "",
    "**You cannot write back to it.** The file is read-only and bound into this review, so a " +
      "submission made against an edited copy is refused, and a correction reaches the next round " +
      "only through a fresh extraction pass. If it disagrees with what you find in the source, say " +
      "so explicitly in your finding — name the file and the symbol that contradicts the map. Your " +
      "VERDICT remains entirely your own; only the recon is shared.",
    "",
    `Scope: ${map.scope.basis} — ${map.scope.file_count} file(s) under review; ` +
      `${map.anchors.length} anchored with their complete caller and callee lists; ` +
      `${map.files_without_edges} carry no graph edge; ` +
      `${map.scope.outside_scope} other authored file(s) lie outside this scope and are not anchored.`,
    `Edges consulted: ${map.provenance.edge_count} — ${edges}.`,
    "",
  ];
  return {
    summaryLines,
    contextFile: {
      filename: REVIEW_FILE_MAP_FILENAME,
      label: "Verified call-site map (tool-generated prior recon)",
      text: renderReviewFileMap(map).join("\n"),
    },
  };
}
