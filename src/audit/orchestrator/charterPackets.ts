// Channel-pure charter-extraction PACKETS (design resolution 4, 2026-08-05):
// blindness enforced by FEEDING, never instruction. Each extraction lane gets a
// materialized packet holding ONLY its evidence channel —
//   stated     → doc-intent files + extracted comments (testimony),
//   structural → file tree + import/call edges + top-level declaration lines
//                (intent frozen into organization; no bodies, no docs, no
//                comments),
//   revealed   → comment-stripped member bodies (behavior)
// — so channel purity stops depending on agent obedience and the comment-dense
// collapse (headers doubling as the stated channel) is fixed as a side effect.
//
// This module is ALSO the single home of the charter layer's read-set
// (design-check resolution-4 constraint 6): `charterPacketReadSet` names exactly
// which repo files packet materialization consumes, and the staleness slice
// (`dependencySlices.ts` → `charterReadFileSlice`) derives from it, so the
// packets and the staleness edge can never drift apart.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  CharterKind,
  CharterPacketCoverage,
  CharterPacketCoverageClass,
  CharterPacketManifest,
  EvidenceClass,
  OmissionReason,
  PacketExcerpt,
  PacketLineRun,
} from "audit-tools/shared";
import {
  CHARTER_PACKET_MANIFEST_SCHEMA_VERSION,
  EVIDENCE_CLASSES,
  compareCodeUnits,
} from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { isDocIntentFile } from "../decompose/buildStructureDecomposition.js";
import {
  extractCommentLines,
  strippedSourceLines,
  type NumberedSourceLine,
} from "../extractors/commentDecomposition.js";

/**
 * The charter layer's read-set over the repo: consensus MEMBER files (every
 * channel is a projection of member content — comments for stated, organization
 * for structural, stripped bodies for revealed) plus every doc-intent file per
 * the pipeline's single doc predicate (`isDocIntentFile` — the stated channel's
 * doc universe). The staleness slice consumes this same function.
 */
export function charterPacketReadSet(bundle: ArtifactBundle): {
  memberPaths: string[];
  docPaths: string[];
} {
  const members = new Set<string>();
  for (const node of bundle.structure_decomposition?.consensus ?? []) {
    for (const member of node.members) members.add(member);
  }
  const docs = new Set<string>();
  for (const file of bundle.file_disposition?.files ?? []) {
    if (isDocIntentFile(file.path, file.status)) docs.add(file.path);
  }
  return {
    memberPaths: [...members].sort((a, b) => compareCodeUnits(a, b)),
    docPaths: [...docs].sort((a, b) => compareCodeUnits(a, b)),
  };
}

/**
 * The dependency-edge lines the STRUCTURAL channel's packet embeds: every
 * `imports`/`calls`/`references` edge whose BOTH endpoints are consensus
 * members, rendered one per line, sorted. The single home of this derivation —
 * the packet renders it and the staleness slice (`dependencySlices.ts` →
 * `charterGraphEdgeSlice`) compares it, so what the packet shows and what
 * re-stales it can never drift.
 */
export function memberDependencyEdgeLines(bundle: ArtifactBundle): string[] {
  const { memberPaths } = charterPacketReadSet(bundle);
  const members = new Set(memberPaths);
  const edges: string[] = [];
  const graphs = bundle.graph_bundle?.graphs;
  for (const family of ["imports", "calls", "references"] as const) {
    for (const edge of graphs?.[family] ?? []) {
      if (members.has(edge.from) && members.has(edge.to)) {
        edges.push(`${edge.from} → ${edge.to} (${edge.kind ?? family})`);
      }
    }
  }
  return edges.sort((a, b) => compareCodeUnits(a, b));
}


/**
 * Top-level declaration lines of a masked source: non-blank lines at indent zero
 * that do not merely close a scope. A deliberate language-neutral HEURISTIC (a
 * lead, not a parse): in brace- and indent-family languages alike, a file's
 * organization — imports, exports, signatures, class/type heads — sits at column
 * 0 while implementation bodies sit indented. Good enough to show the structural
 * channel what the file declares without leaking how it works.
 *
 * It takes NUMBERED lines and returns numbered lines, so a declaration keeps the
 * line it actually occupies in its own file. Feeding it `stripCommentText` output
 * would number every declaration against a collapsed view — a confidently wrong
 * citation, which is worse than none.
 */
export function topLevelDeclarationLines(
  lines: readonly NumberedSourceLine[],
): NumberedSourceLine[] {
  const kept: NumberedSourceLine[] = [];
  for (const entry of lines) {
    if (entry.text.length === 0) continue;
    if (/^\s/.test(entry.text)) continue;
    if (/^[}\])`>,;]+\s*$/.test(entry.text)) continue;
    kept.push({
      line: entry.line,
      text:
        entry.text.length > 200 ? `${entry.text.slice(0, 200)}…` : entry.text,
    });
  }
  return kept;
}

// ── Packet budget ────────────────────────────────────────────────────────────
//
// PACKET_TOTAL_CHARS is the hard ceiling and stays exactly what it was: bounded,
// never whole-repo. What changed is that it is no longer spent by whoever is
// rendered FIRST.
//
// The old builder walked one greedy budget over sections in doc-then-comment
// order and, on overflow, kept the heading only. On a 335-file repo the 95
// doc-intent files cost 459,907 chars against a 150,000 budget — 3.07x over
// before the comment loop was even reached — so 0 of 72 comment sections
// survived. That is an ordering artifact, not a size problem: reversing the order
// would starve docs instead. So the budget is now split by CLASS QUOTA and filled
// by a two-pass water-fill, which is what makes a coverage figure mean anything.

const PER_FILE_CHARS = 6_000;
const PACKET_TOTAL_CHARS = 150_000;
/**
 * An excerpt below this is a stub, not evidence — too small to characterize a
 * file's purpose. A candidate TRUNCATED below it is omitted by name instead, and
 * its allocation returns to the pool. A file whose whole content is smaller than
 * this is COMPLETE, not a stub, and is delivered.
 */
const MIN_EXCERPT_CHARS = 400;
const MAX_READ_BYTES = 512 * 1024;

/**
 * Metadata is charged against the ceiling BEFORE the content quotas are derived,
 * so the manifest and the per-line prefixes are paid for rather than silently
 * pushing the packet over its own bound.
 *
 * The real overhead, measured rather than guessed: one pretty-printed manifest
 * excerpt row runs ~150-200 chars (id, path, class, runs, counts, prefix width),
 * so 176 candidates — the motivating repo's 95 docs + 81 members — cost ~30 KB,
 * about 20% of the ceiling. The per-line `NNN| ` prefix is 5-8 chars against a
 * mean source line of 38.7 chars measured over this repo's own `src/**\/*.ts`
 * (101,830 lines / 3,944,266 chars), i.e. 13-21%, not the 12% a 7-char estimate
 * suggested. Prefix cost is not estimated here at all — it is charged exactly,
 * because allocation measures the RENDERED body, prefixes included.
 */
const MANIFEST_ROW_CHARS = 180;
/** Preamble, manifest envelope, headings and the omitted-list chrome. */
const PACKET_CHROME_CHARS = 1_600;

interface ExcerptCandidate {
  evidence_class: EvidenceClass;
  source_path: string;
  /** Every line available for this candidate, in ascending line order. */
  lines: NumberedSourceLine[];
}

interface AllocatedExcerpt {
  candidate: ExcerptCandidate;
  lines: NumberedSourceLine[];
  truncated: boolean;
  cost: number;
}

interface ClassAllocation {
  delivered: AllocatedExcerpt[];
  omitted: { path: string; reason: OmissionReason }[];
  spent: number;
}

/** The uniform prefix width for an excerpt: widest line number, plus `"| "`. */
function prefixWidthFor(lines: readonly NumberedSourceLine[]): number {
  const widest = lines.reduce((max, entry) => Math.max(max, entry.line), 0);
  return String(widest).length + 2;
}

function renderExcerptBody(lines: readonly NumberedSourceLine[]): string {
  const pad = prefixWidthFor(lines) - 2;
  return lines
    .map((entry) => `${String(entry.line).padStart(pad)}| ${entry.text}`)
    .join("\n");
}

function headingFor(
  excerptId: string,
  candidate: ExcerptCandidate,
  runs: readonly PacketLineRun[],
): string {
  const label = CLASS_LABELS[candidate.evidence_class];
  const spans = runs
    .map((run) => (run.start === run.end ? `${run.start}` : `${run.start}-${run.end}`))
    .join(", ");
  return `[${excerptId}] ${label}: ${candidate.source_path} — lines ${spans}`;
}

const CLASS_LABELS: Record<EvidenceClass, string> = {
  comment: "Comments extracted from",
  declaration: "Top-level declarations (heuristic lead)",
  doc: "Doc",
  stripped_source: "Comment-stripped source",
};

/** Contiguous runs of TRUE line numbers over an ascending line list. */
function lineRunsOf(lines: readonly NumberedSourceLine[]): PacketLineRun[] {
  const runs: PacketLineRun[] = [];
  for (const entry of lines) {
    const last = runs[runs.length - 1];
    if (last && entry.line === last.end + 1) last.end = entry.line;
    else runs.push({ start: entry.line, end: entry.line });
  }
  return runs;
}

/** The rendered cost of delivering these lines (prefixes included) plus a heading. */
function costOf(lines: readonly NumberedSourceLine[]): number {
  if (lines.length === 0) return 0;
  return renderExcerptBody(lines).length + HEADING_OVERHEAD_CHARS;
}

const HEADING_OVERHEAD_CHARS = 90;

/** Take as many leading lines as fit in `cap`, measured on the RENDERED body. */
function fitLines(
  lines: readonly NumberedSourceLine[],
  cap: number,
): { lines: NumberedSourceLine[]; truncated: boolean; cost: number } {
  const whole = costOf(lines);
  if (whole <= cap) return { lines: [...lines], truncated: false, cost: whole };
  const kept: NumberedSourceLine[] = [];
  for (const entry of lines) {
    const next = [...kept, entry];
    if (costOf(next) > cap) break;
    kept.push(entry);
  }
  return { lines: kept, truncated: true, cost: costOf(kept) };
}

/**
 * Fill one evidence class's quota by a two-pass water-fill, in PATH order.
 *
 * Pass 1 gives every candidate `min(need, floor(B/N))`, so no candidate can
 * consume the class before another is considered — the property the greedy loop
 * lacked. Pass 2 spills the class's unspent remainder to candidates that still
 * have need, in path order, up to `PER_FILE_CHARS`. A candidate left TRUNCATED
 * below `MIN_EXCERPT_CHARS` is a stub: it is omitted by name (`total_budget`),
 * its allocation returns to the pool, and the fill is recomputed — iterating to a
 * fixpoint, which terminates because the active set strictly shrinks.
 *
 * Deterministic in (candidates, budget): no filesystem order, no completion
 * order, no randomness.
 */
function allocateClass(
  candidates: readonly ExcerptCandidate[],
  budget: number,
): ClassAllocation {
  const omitted: { path: string; reason: OmissionReason }[] = [];
  let active = [...candidates];

  for (;;) {
    if (active.length === 0 || budget <= 0) break;
    const share = Math.floor(budget / active.length);
    const fills = active.map((candidate) => fitLines(candidate.lines, share));
    let remainder = budget - fills.reduce((sum, fill) => sum + fill.cost, 0);

    // Pass 2 — spill the unspent remainder in path order, clamped per file.
    for (let i = 0; i < active.length && remainder > 0; i += 1) {
      if (!fills[i]!.truncated) continue;
      const cap = Math.min(PER_FILE_CHARS, fills[i]!.cost + remainder);
      if (cap <= fills[i]!.cost) continue;
      const refill = fitLines(active[i]!.lines, cap);
      remainder -= refill.cost - fills[i]!.cost;
      fills[i] = refill;
    }

    // A truncated stub is worse than a named omission; a small COMPLETE file is
    // not a stub, so completeness is checked before size.
    const stubs = new Set<number>();
    for (let i = 0; i < fills.length; i += 1) {
      if (fills[i]!.truncated && fills[i]!.cost < MIN_EXCERPT_CHARS) stubs.add(i);
    }
    if (stubs.size === 0) {
      return {
        delivered: active.map((candidate, i) => ({
          candidate,
          lines: fills[i]!.lines,
          truncated: fills[i]!.truncated,
          cost: fills[i]!.cost,
        })),
        omitted,
        spent: fills.reduce((sum, fill) => sum + fill.cost, 0),
      };
    }
    for (const i of [...stubs].sort((a, b) => a - b)) {
      omitted.push({ path: active[i]!.source_path, reason: "total_budget" });
    }
    active = active.filter((_, i) => !stubs.has(i));
  }

  for (const candidate of active) {
    omitted.push({ path: candidate.source_path, reason: "total_budget" });
  }
  return { delivered: [], omitted, spent: 0 };
}

/**
 * Split a content budget across the classes a kind emits, then SPILL what a class
 * cannot use to the class that can. The `stated` channel splits 50/50 between
 * docs and comments: neither class is a priori more valuable, and the 100/0
 * outcome that starved every source comment was never chosen — it fell out of
 * render order. Spill keeps the split from becoming a new cap: a repo with three
 * docs still yields a full comment channel.
 */
function allocateStated(
  docs: readonly ExcerptCandidate[],
  comments: readonly ExcerptCandidate[],
  budget: number,
): { doc: ClassAllocation; comment: ClassAllocation } {
  // Spill tracks the REMAINING TOTAL, never a sum of halves: giving each class
  // "its half plus the other's leftover" double-counts the shared pool, and a
  // single oversized doc then swallowed 200k against a 148k budget.
  const half = Math.floor(budget / 2);
  const firstDoc = allocateClass(docs, half);
  const comment = allocateClass(comments, budget - firstDoc.spent);
  const remaining = budget - firstDoc.spent - comment.spent;
  const doc =
    remaining > 0 ? allocateClass(docs, firstDoc.spent + remaining) : firstDoc;
  return { doc, comment };
}

async function readRepoFile(
  root: string,
  path: string,
): Promise<string | undefined> {
  try {
    const buf = await readFile(join(root, path));
    if (buf.byteLength > MAX_READ_BYTES) return undefined;
    return buf.toString("utf8");
  } catch {
    return undefined;
  }
}

export interface MaterializeCharterPacketParams {
  root: string;
  bundle: ArtifactBundle;
  kind: CharterKind;
}

export interface MaterializedCharterPacket {
  markdown: string;
  coverage: CharterPacketCoverage;
  excerpts: PacketExcerpt[];
}

/**
 * The machine header a lane copies its citations from, and — byte-identically —
 * the lane asset the emit pass persists for the ingest pass. ONE function builds
 * both, so what a lane reads and what a validator checks against cannot drift.
 */
export function buildCharterPacketManifest(
  kind: CharterKind,
  excerpts: readonly PacketExcerpt[],
  coverage: CharterPacketCoverage,
): CharterPacketManifest {
  return {
    schema_version: CHARTER_PACKET_MANIFEST_SCHEMA_VERSION,
    kind,
    excerpts: excerpts.map((excerpt) => ({
      excerpt_id: excerpt.excerpt_id,
      source_path: excerpt.source_path,
      evidence_class: excerpt.evidence_class,
      line_runs: excerpt.line_runs,
      line_count: excerpt.lines.length,
      truncated: excerpt.truncated,
      prefix_width: excerpt.prefix_width,
    })),
    coverage,
  };
}

interface PacketPlan {
  /** Synthesized, non-file sections (the structural tree and edge list). */
  fixedSections: { heading: string; body: string }[];
  /** Per class, every candidate considered — `named`, before any budget. */
  candidatesByClass: Map<EvidenceClass, ExcerptCandidate[]>;
  /** Omissions decided before allocation (unreadable, empty). */
  preOmitted: Map<EvidenceClass, { path: string; reason: OmissionReason }[]>;
  /** Candidates named but carrying no content — counted in `named`. */
  namedByClass: Map<EvidenceClass, number>;
}

function emptyPlan(): PacketPlan {
  return {
    fixedSections: [],
    candidatesByClass: new Map(),
    preOmitted: new Map(),
    namedByClass: new Map(),
  };
}

function note(
  plan: PacketPlan,
  evidenceClass: EvidenceClass,
  path: string,
  reason: OmissionReason,
): void {
  const list = plan.preOmitted.get(evidenceClass) ?? [];
  list.push({ path, reason });
  plan.preOmitted.set(evidenceClass, list);
}

function nameCandidate(plan: PacketPlan, evidenceClass: EvidenceClass): void {
  plan.namedByClass.set(
    evidenceClass,
    (plan.namedByClass.get(evidenceClass) ?? 0) + 1,
  );
}

function addCandidate(plan: PacketPlan, candidate: ExcerptCandidate): void {
  const list = plan.candidatesByClass.get(candidate.evidence_class) ?? [];
  list.push(candidate);
  plan.candidatesByClass.set(candidate.evidence_class, list);
}

/**
 * Materialize ONE kind's evidence packet. Deterministic given the bundle + file
 * contents: stable path order, class quotas, an order-independent allocator, and
 * an explicit per-class coverage record in which
 * `delivered + omitted.length === named` for every class — so a file that
 * contributed nothing is NAMED rather than silently absent.
 */
export async function materializeCharterPacket(
  params: MaterializeCharterPacketParams,
): Promise<MaterializedCharterPacket> {
  const { memberPaths, docPaths } = charterPacketReadSet(params.bundle);
  const plan = emptyPlan();

  if (params.kind === "stated") {
    for (const path of docPaths) {
      nameCandidate(plan, "doc");
      const text = await readRepoFile(params.root, path);
      if (text === undefined) {
        note(plan, "doc", path, "unreadable_or_oversized");
        continue;
      }
      const lines = numberedLinesOf(text);
      if (lines.length === 0) {
        note(plan, "doc", path, "no_content");
        continue;
      }
      addCandidate(plan, { evidence_class: "doc", source_path: path, lines });
    }
    for (const path of memberPaths) {
      nameCandidate(plan, "comment");
      const text = await readRepoFile(params.root, path);
      if (text === undefined) {
        note(plan, "comment", path, "unreadable_or_oversized");
        continue;
      }
      const lines = extractCommentLines(text, path);
      if (lines.length === 0) {
        // Previously a bare `continue`: a member with no comments appeared in
        // neither the delivered nor the omitted list, so `named` could not be
        // reconciled and 9 of 81 members were invisible.
        note(plan, "comment", path, "no_content");
        continue;
      }
      addCandidate(plan, { evidence_class: "comment", source_path: path, lines });
    }
  } else if (params.kind === "structural") {
    const manifestByPath = new Map(
      (params.bundle.repo_manifest?.files ?? []).map((f) => [f.path, f]),
    );
    plan.fixedSections.push({
      heading: "File tree (members)",
      body: memberPaths
        .map((path) => {
          const entry = manifestByPath.get(path);
          return entry ? `${path} (${entry.size_bytes} bytes)` : path;
        })
        .join("\n"),
    });
    const edgeLines = memberDependencyEdgeLines(params.bundle);
    if (edgeLines.length > 0) {
      plan.fixedSections.push({
        heading: "Dependency edges among members",
        body: edgeLines.join("\n"),
      });
    }
    for (const path of memberPaths) {
      nameCandidate(plan, "declaration");
      const text = await readRepoFile(params.root, path);
      if (text === undefined) {
        note(plan, "declaration", path, "unreadable_or_oversized");
        continue;
      }
      const lines = topLevelDeclarationLines(strippedSourceLines(text, path));
      if (lines.length === 0) {
        note(plan, "declaration", path, "no_content");
        continue;
      }
      addCandidate(plan, {
        evidence_class: "declaration",
        source_path: path,
        lines,
      });
    }
  } else if (params.kind === "revealed") {
    for (const path of memberPaths) {
      nameCandidate(plan, "stripped_source");
      const text = await readRepoFile(params.root, path);
      if (text === undefined) {
        note(plan, "stripped_source", path, "unreadable_or_oversized");
        continue;
      }
      const lines = strippedSourceLines(text, path);
      if (lines.length === 0) {
        note(plan, "stripped_source", path, "no_content");
        continue;
      }
      addCandidate(plan, {
        evidence_class: "stripped_source",
        source_path: path,
        lines,
      });
    }
  } else {
    // `true` is never an extraction lane (nominated by the miner at deepest);
    // materializing a packet for it is a caller bug, surfaced loudly.
    throw new Error(
      `no evidence packet exists for charter kind '${params.kind}' — 'true' is nominated downstream by the delta miner, never extracted`,
    );
  }

  // Charge the metadata BEFORE deriving the content quotas, so the manifest and
  // the fixed sections are paid for rather than pushing the packet over its bound.
  const candidateCount = [...plan.candidatesByClass.values()].reduce(
    (sum, list) => sum + list.length,
    0,
  );
  const fixedCost = plan.fixedSections.reduce(
    (sum, section) => sum + section.heading.length + section.body.length + 8,
    0,
  );
  const estimatedOverhead =
    PACKET_CHROME_CHARS + candidateCount * MANIFEST_ROW_CHARS + fixedCost;

  // MANIFEST_ROW_CHARS is an ESTIMATE, and an estimate is not a bound: an excerpt
  // with many scattered runs (comment blocks through a long file) costs more than
  // a typical row. So the first layout is measured, and if the real metadata
  // pushed the packet over its ceiling the layout is recomputed ONCE against the
  // measured overhead. It converges: a smaller content budget delivers no more
  // lines, so no more runs, so no larger manifest.
  let layout = layoutPacket(params.kind, plan, PACKET_TOTAL_CHARS - estimatedOverhead);
  let markdown = renderPacket(
    params.kind,
    plan.fixedSections,
    layout.excerpts,
    layout.coverage,
  );
  if (markdown.length > PACKET_TOTAL_CHARS) {
    const measuredOverhead = markdown.length - layout.coverage.spent_chars;
    layout = layoutPacket(
      params.kind,
      plan,
      PACKET_TOTAL_CHARS - measuredOverhead,
    );
    markdown = renderPacket(
      params.kind,
      plan.fixedSections,
      layout.excerpts,
      layout.coverage,
    );
  }

  return { markdown, coverage: layout.coverage, excerpts: layout.excerpts };
}

/** Allocate, number, and measure one packet against a content budget. */
function layoutPacket(
  kind: CharterKind,
  plan: PacketPlan,
  contentBudget: number,
): { excerpts: PacketExcerpt[]; coverage: CharterPacketCoverage } {
  const budget = Math.max(0, contentBudget);
  const allocations = new Map<EvidenceClass, ClassAllocation>();
  if (kind === "stated") {
    const { doc, comment } = allocateStated(
      plan.candidatesByClass.get("doc") ?? [],
      plan.candidatesByClass.get("comment") ?? [],
      budget,
    );
    allocations.set("doc", doc);
    allocations.set("comment", comment);
  } else {
    for (const [evidenceClass, candidates] of plan.candidatesByClass) {
      allocations.set(evidenceClass, allocateClass(candidates, budget));
    }
  }

  // Emission order = class order within the packet, path order within a class.
  const emissionOrder: EvidenceClass[] =
    kind === "stated" ? ["doc", "comment"] : [...plan.candidatesByClass.keys()];
  const excerpts: PacketExcerpt[] = [];
  for (const evidenceClass of emissionOrder) {
    for (const allocated of allocations.get(evidenceClass)?.delivered ?? []) {
      if (allocated.lines.length === 0) continue;
      excerpts.push({
        excerpt_id: `E${String(excerpts.length + 1).padStart(2, "0")}`,
        evidence_class: evidenceClass,
        source_path: allocated.candidate.source_path,
        line_runs: lineRunsOf(allocated.lines),
        lines: allocated.lines.map((entry) => ({
          line: entry.line,
          text: entry.text,
        })),
        truncated: allocated.truncated,
        prefix_width: prefixWidthFor(allocated.lines),
      });
    }
  }

  const classes: CharterPacketCoverageClass[] = [];
  for (const evidenceClass of EVIDENCE_CLASSES) {
    const named = plan.namedByClass.get(evidenceClass);
    if (named === undefined) continue;
    const allocation = allocations.get(evidenceClass);
    const delivered = (allocation?.delivered ?? []).filter(
      (entry) => entry.lines.length > 0,
    );
    const omitted = [
      ...(plan.preOmitted.get(evidenceClass) ?? []),
      ...(allocation?.omitted ?? []),
    ].sort((a, b) => compareCodeUnits(a.path, b.path));
    classes.push({
      evidence_class: evidenceClass,
      named,
      delivered: delivered.length,
      truncated: delivered.filter((entry) => entry.truncated).length,
      omitted,
    });
  }

  return {
    excerpts,
    coverage: {
      kind,
      classes,
      budget_chars: budget,
      spent_chars: [...allocations.values()].reduce(
        (sum, allocation) => sum + allocation.spent,
        0,
      ),
    },
  };
}

/** Every non-empty line of a file, with its TRUE 1-based number. */
function numberedLinesOf(text: string): NumberedSourceLine[] {
  const out: NumberedSourceLine[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    out.push({ line: i + 1, text: line });
  }
  return out;
}

/**
 * Render the packet: a machine manifest a lane copies citations OUT of, then the
 * human excerpts, every content line carrying its TRUE source line number.
 *
 * The two are orthogonal and both are load-bearing. The per-line prefix is what
 * lets a lane cite a SPECIFIC line without counting; the run header on each
 * heading is what tells it which ranges are legitimate to name at all.
 */
function renderPacket(
  kind: CharterKind,
  fixedSections: readonly { heading: string; body: string }[],
  excerpts: readonly PacketExcerpt[],
  coverage: CharterPacketCoverage,
): string {
  const lines: string[] = [
    `# Charter evidence packet — \`${kind}\` channel`,
    "",
    "This packet is your ONLY input. It was materialized by the tool to contain",
    "exactly this channel's evidence; do not read repository files directly.",
    "",
    "Every content line below is prefixed with its TRUE line number in its own",
    "source file, and the manifest names the exact line runs delivered. A correct",
    "citation is COPIED from here — never counted, inferred, or reconstructed.",
    "",
    "## Provenance manifest",
    "",
    "```json",
    JSON.stringify(buildCharterPacketManifest(kind, excerpts, coverage), null, 2),
    "```",
    "",
  ];
  for (const section of fixedSections) {
    lines.push(`## ${section.heading}`, "", section.body, "");
  }
  for (const excerpt of excerpts) {
    lines.push(
      `## ${headingFor(excerpt.excerpt_id, { evidence_class: excerpt.evidence_class, source_path: excerpt.source_path, lines: [] }, excerpt.line_runs)}`,
      "",
      renderExcerptBody(excerpt.lines),
      "",
    );
  }
  const omitted = coverage.classes.flatMap((entry) =>
    entry.omitted.map((row) => `${row.path} (${OMISSION_PROSE[row.reason]})`),
  );
  if (omitted.length > 0) {
    lines.push(
      "## Omitted (content not shown, paths listed for honesty)",
      "",
      ...omitted.map((o) => `- ${o}`),
      "",
    );
  }
  return lines.join("\n");
}

const OMISSION_PROSE: Record<OmissionReason, string> = {
  per_file_cap: "capped at the per-file limit",
  total_budget: "no room left in this channel's budget",
  unreadable_or_oversized: "unreadable or oversized",
  no_content: "no content of this evidence class in the file",
};
