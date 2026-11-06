// sites-pinned: tests/audit/systemic-challenge.test.ts, tests/audit/review-file-map-context.test.ts, tests/audit/review-evidence-right-sizing.test.ts
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
 * It is a lane ASSET, not a submission: each slice reaches the round as a
 * READ-ONLY context file the lane materializer writes and binds into the lane's
 * review binding, so acceptance re-hashes it and refuses a submission made
 * against an edited copy; the prompt carries only the index and the provenance
 * (`reviewFileMapContext`). No file is on a path any lane's write scope covers,
 * and no submission schema has a field for it — a round has no route by which to
 * write back, because the only thing it hands over is its own findings. Updates
 * go through a separate recon pass (the graph builder), which is the only thing
 * that can change what the next round receives. Otherwise the map quietly
 * absorbs one reviewer's assumption and reaches the next reviewer as fact.
 *
 * The map is SCOPED to what the reading round judges — which only the consumer
 * knows: every file in that scope gets an anchor carrying its COMPLETE caller and
 * callee lists, and nothing outside it is anchored. There is no cap. An earlier
 * version anchored the path-sorted FIRST 60 authored files and listed at most 25
 * call sites each — neither number measured. Whatever the map leaves out
 * (in-scope files with no edge, files outside the scope, graph buckets that are
 * not call sites) is STATED: a silently thin map reads as a complete one.
 *
 * It is SLICED by unit, not capped. The uncapped map was one file — 480 KB and
 * 2,563 lines for the six starting-point units of the 0.55.15 dogfood run — and
 * every lane told to read it whole fell back to grep. The prompt now carries a
 * compact index (one row per unit: its counts and its slice file) and each unit's
 * anchors live in their own slice, so a lane reads exactly the slices of the
 * units it judges, each whole. Only call-site buckets feed it
 * (`isDependencyEdgeBucket`): a co-changed file is not a caller.
 *
 * Deterministic and content-derived: every array is ordered by a stable key, so
 * no file churns between emissions of an unchanged round.
 */

import { compareCodeUnits } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { isDependencyEdgeBucket } from "../extractors/graphSignals.js";

/** A unit as the map slices by it: an id and the files it owns. */
export interface ReviewFileMapUnit {
  unit_id: string;
  files: readonly string[];
}

/**
 * The files a reading round judges — the set the map anchors, completely. The
 * consumer derives it from what its own prompt names (it is the only party that
 * knows), so the map and the prompt cannot disagree about it.
 */
export interface ReviewFileMapScope {
  /** Repo-relative paths under review. Deduplicated and path-sorted by the map. */
  files: readonly string[];
  /** One clause naming what this scope is, stated to the reading lane. */
  basis: string;
  /**
   * The units the index lists and the slices follow, in the order the consumer
   * names them. A file belongs to the FIRST unit that lists it; a file no unit
   * lists lands in the `unassigned` slice. Omitted: the run's unit manifest.
   */
  units?: readonly ReviewFileMapUnit[];
  /**
   * Per-file notes rendered under the file's anchor (the systemic round's
   * deterministic leads). A noted file is anchored even when the graph records
   * no edge for it — the note is the reason it is under review.
   */
  notes?: ReadonlyMap<string, readonly string[]>;
}

export interface ReviewFileMapAnchor {
  /** The repo-relative file the call sites below target. */
  path: string;
  /** Every file that references it, path-sorted. */
  callers: string[];
  /** Every file it references, path-sorted. */
  callees: string[];
  /** The scope's notes for this file, in the order given. */
  notes: string[];
}

/** One unit's share of the map: the files under review it owns and the slice file holding them. */
export interface ReviewFileMapSlice {
  /** The owning unit, or `null` for in-scope files no unit lists. */
  unit_id: string | null;
  /** The slice file's name. Unique within one map. */
  filename: string;
  /** This unit's files under review, path-sorted. */
  files: string[];
}

export interface ReviewFileMap {
  /** What produced this map — the provenance the reading lane is told to trust. */
  provenance: {
    /** `tool` — the map is machine-derived, never authored by a reviewer. */
    author: "tool";
    /** The call-site buckets the edges were read from. */
    sources: string[];
    /** Edges consulted, so a thin map is visibly thin rather than silently so. */
    edge_count: number;
    /** Graph buckets present but not read, because they are not call sites. */
    omitted_sources: string[];
    /** Whether an edge category was present at all in the graph. */
    graph_present: boolean;
  };
  /** What the map covers — stated to the reading lane before the anchors. */
  scope: {
    basis: string;
    /** Files under review: each is anchored or counted in `files_without_edges`. */
    file_count: number;
    /**
     * Authored (manifest) files outside the scope, so not anchored. Stated: an
     * unanchored file is outside this map, not unconnected.
     */
    outside_scope: number;
  };
  /** One anchor per in-scope file the graph connects or the scope notes, path-sorted. */
  anchors: ReviewFileMapAnchor[];
  /**
   * In-scope files the graph records NO edge for. Always stated: these are
   * exactly the files whose absence a round must not read as "nothing depends
   * on it".
   */
  files_without_edges: number;
  /** One entry per listed unit, in scope order, then `unassigned` when any file is. */
  slices: ReviewFileMapSlice[];
}

const REVIEW_FILE_MAP_PREFIX = "review-call-site-map";

/**
 * A slice file name unique within one map. Uniqueness is checked on the
 * CASE-FOLDED name: unit ids `Unit` and `unit` would otherwise name two files
 * that are one file on a case-insensitive filesystem (win32, default darwin),
 * and one slice would overwrite the other.
 */
function sliceFilename(unitId: string | null, used: Set<string>): string {
  const slug = (unitId ?? "unassigned").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unit";
  let name = `${REVIEW_FILE_MAP_PREFIX}.${slug}.md`;
  for (let suffix = 2; used.has(name.toLowerCase()); suffix += 1) {
    name = `${REVIEW_FILE_MAP_PREFIX}.${slug}-${suffix}.md`;
  }
  used.add(name.toLowerCase());
  return name;
}

/**
 * Which unit owns each file: the FIRST unit, in the order given, that lists it.
 * The one ownership rule the map's slices and any per-unit count a consumer
 * renders beside them both read, so a file two units list is counted once.
 */
export function unitOwnership(units: readonly ReviewFileMapUnit[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const unit of units) {
    for (const file of unit.files) {
      if (!owner.has(file)) owner.set(file, unit.unit_id);
    }
  }
  return owner;
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
  const omittedSources: string[] = [];
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  let edgeCount = 0;

  for (const [kind, edges] of Object.entries(graphs ?? {})) {
    if (!Array.isArray(edges)) continue;
    if (!isDependencyEdgeBucket(kind)) {
      if (edges.length > 0) omittedSources.push(`${kind} (${edges.length} edge(s))`);
      continue;
    }
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
  omittedSources.sort(compareCodeUnits);

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
    const notes = [...(scope.notes?.get(path) ?? [])];
    if (callers.length === 0 && callees.length === 0) {
      filesWithoutEdges += 1;
      if (notes.length === 0) continue;
    }
    anchors.push({ path, callers, callees, notes });
  }

  // Slice by unit: the consumer's units in its order, else the manifest's by id.
  const units =
    scope.units ??
    [...(bundle.unit_manifest?.units ?? [])].sort((a, b) => compareCodeUnits(a.unit_id, b.unit_id));
  const owner = unitOwnership(units);
  const used = new Set<string>();
  const slices: ReviewFileMapSlice[] = [];
  const seenUnits = new Set<string>();
  for (const unit of units) {
    if (seenUnits.has(unit.unit_id)) continue;
    seenUnits.add(unit.unit_id);
    const unitFiles = inScope.filter((file) => owner.get(file) === unit.unit_id);
    // The consumer's units are all listed (they ARE its index); the manifest's
    // only where they hold a file under review.
    if (unitFiles.length === 0 && scope.units === undefined) continue;
    slices.push({ unit_id: unit.unit_id, filename: sliceFilename(unit.unit_id, used), files: unitFiles });
  }
  const unassigned = inScope.filter((file) => !owner.has(file));
  if (unassigned.length > 0) {
    slices.push({ unit_id: null, filename: sliceFilename(null, used), files: unassigned });
  }

  return {
    provenance: {
      author: "tool",
      sources,
      edge_count: edgeCount,
      omitted_sources: omittedSources,
      graph_present: graphs !== undefined,
    },
    scope: {
      basis: scope.basis,
      file_count: inScope.length,
      outside_scope: outsideScope,
    },
    anchors,
    files_without_edges: filesWithoutEdges,
    slices,
  };
}

function sliceAnchors(map: ReviewFileMap, slice: ReviewFileMapSlice): ReviewFileMapAnchor[] {
  const files = new Set(slice.files);
  return map.anchors.filter((anchor) => files.has(anchor.path));
}

function unitLabel(slice: ReviewFileMapSlice): string {
  return slice.unit_id ?? "(no unit)";
}

/**
 * Render one slice: a short provenance header, then every anchor of the unit with
 * its complete caller and callee lists and its notes. Returned as text rather
 * than JSON so a lane reads it as data-that-was-handed-over.
 */
export function renderReviewFileMapSlice(map: ReviewFileMap, slice: ReviewFileMapSlice): string[] {
  const anchors = sliceAnchors(map, slice);
  const edgeless = slice.files.length - anchors.filter((a) => a.callers.length + a.callees.length > 0).length;
  const lines: string[] = [
    `### Call-site map slice — unit ${unitLabel(slice)} (provenance: machine-derived prior recon — you did NOT author this)`,
    "",
    "Derived by the audit tool from this run's dependency graph (call-site buckets only). Read-only " +
      "and bound into your review: if it disagrees with the source, say so in your finding and name the " +
      "file and symbol that contradict it.",
    "",
    `${slice.files.length} file(s) of this unit are under review; ${anchors.length} are listed below ` +
      `with their COMPLETE caller and callee lists; ${edgeless} carry no graph edge` +
      (edgeless > 0
        ? " — an absent edge is a gap in this extraction, not a finding that nothing depends on the file."
        : "."),
    "",
  ];
  for (const anchor of anchors) {
    lines.push(`- **${anchor.path}**`);
    lines.push(`  - referenced by: ${anchor.callers.join(", ") || "(none recorded)"}`);
    lines.push(`  - references: ${anchor.callees.join(", ") || "(none recorded)"}`);
    for (const note of anchor.notes) lines.push(`  - lead: ${note}`);
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

/** One build of the map, split into what the prompt carries and what the files carry. */
export interface ReviewFileMapContext {
  /** The prompt's share: provenance, the read-only rule, scope, counts, and the unit index. */
  summaryLines: string[];
  /** One read-only slice per unit with an anchor, bound into the lane's review. */
  contextFiles: ReviewFileMapContextFile[];
}

/** An extra column of the unit index, filled per unit by the consumer. */
export interface ReviewFileMapIndexColumn {
  header: string;
  cell: (unitId: string | null) => string;
}

/**
 * Split one map into the prompt's index and the read-only slice files, so the
 * two cannot come from different builds. The index states the provenance, the
 * read-only rule, every count, the omitted buckets, and one row per unit naming
 * its slice — the lane materializer lists each slice's full path under its
 * "Read-only context files" section.
 */
export function reviewFileMapContext(
  map: ReviewFileMap,
  options: { columns?: readonly ReviewFileMapIndexColumn[] } = {},
): ReviewFileMapContext {
  const noRecon = "so the map is NO RECON — an absent edge is not evidence that no caller exists";
  const edges =
    map.provenance.sources.length > 0
      ? `from ${map.provenance.sources.join(", ")}`
      : map.provenance.graph_present
        ? `the dependency graph carried no call-site edges, ${noRecon}`
        : `no dependency graph was available, ${noRecon}`;
  const contextFiles: ReviewFileMapContextFile[] = [];
  const sliced = new Set<string>();
  for (const slice of map.slices) {
    if (sliceAnchors(map, slice).length === 0) continue;
    sliced.add(slice.filename);
    contextFiles.push({
      filename: slice.filename,
      label: `Call-site map slice — unit ${unitLabel(slice)} (tool-generated prior recon)`,
      text: renderReviewFileMapSlice(map, slice).join("\n"),
    });
  }
  const columns = options.columns ?? [];
  const header = ["unit", "files under review", "anchored", "no graph edge", ...columns.map((c) => c.header), "slice file"];
  const rows = map.slices.map((slice) => {
    const anchors = sliceAnchors(map, slice);
    const edgeless = slice.files.length - anchors.filter((a) => a.callers.length + a.callees.length > 0).length;
    return [
      unitLabel(slice),
      String(slice.files.length),
      String(anchors.length),
      String(edgeless),
      ...columns.map((column) => column.cell(slice.unit_id)),
      sliced.has(slice.filename) ? `\`${slice.filename}\`` : "—",
    ];
  });

  const summaryLines = [
    "### Verified call-site map (provenance: machine-derived prior recon — you did NOT author this)",
    "",
    "The audit tool derived a call-site map from the dependency graph and the repository manifest " +
      "extracted earlier in this run and wrote it as one read-only SLICE file per unit, indexed below; " +
      'each slice\'s full path is listed under "Read-only context files" at the end of this prompt. ' +
      "Before re-deriving any call site, find the unit of the file you are judging in the index and read " +
      "that unit's slice whole — it lists every anchored file of the unit with its complete caller and " +
      "callee lists. Read only the slices of the units you judge. It is a factual input handed to you so " +
      "this round spends its budget on judgment: TRUST it as a starting point, do not reproduce it.",
    "",
    "**You cannot write back to it.** Every slice is read-only and bound into this review, so a " +
      "submission made against an edited copy is refused, and a correction reaches the next round " +
      "only through a fresh extraction pass. If it disagrees with what you find in the source, say " +
      "so explicitly in your finding — name the file and the symbol that contradicts the map. Your " +
      "VERDICT remains entirely your own; only the recon is shared.",
    "",
    `Scope: ${map.scope.basis} — ${map.scope.file_count} file(s) under review; ` +
      `${map.anchors.length} anchored with their complete caller and callee lists; ` +
      `${map.files_without_edges} carry no graph edge (an absent edge is a gap in this extraction, ` +
      "not a finding that nothing depends on the file); " +
      `${map.scope.outside_scope} other authored file(s) lie outside this scope and are not anchored ` +
      "(outside this map, not unconnected — they still appear as callers or callees wherever an edge " +
      "reaches them).",
    `Edges consulted: ${map.provenance.edge_count} — ${edges}.`,
    ...(map.provenance.omitted_sources.length > 0
      ? [
          `Not read: ${map.provenance.omitted_sources.join(", ")} — not a call site (co_change records ` +
            "files changed in the same commits; routes is not an edge list), so not listed.",
        ]
      : []),
    "",
  ];
  if (rows.length > 0) {
    summaryLines.push(
      `| ${header.join(" | ")} |`,
      `|${header.map(() => "---").join("|")}|`,
      ...rows.map((row) => `| ${row.join(" | ")} |`),
      "",
    );
  }
  return { summaryLines, contextFiles };
}
