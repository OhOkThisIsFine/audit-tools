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

// ── What the packet delivers ─────────────────────────────────────────────────
//
// THE PACKET CARRIES NO CHARACTER LIMIT (owner, 2026-09-04). The rule this
// module used to state as "budget context: bounded, never whole-repo" is
// actually: THE TOOL DELIVERS WHAT IT NAMES, AND SIZING IS THE HOST'S. A
// backend's context or output window is transport config and never enters this
// package — the same boundary that retired the routing substrate. So every
// named doc, comment block, declaration set and stripped body reaches its
// packet IN FULL, and the coverage manifest states what was named against what
// was delivered rather than what a ceiling could afford.
//
// The one remaining bound is a READ-SAFETY guard, never a size budget: a file
// larger than READ_SAFETY_MAX_BYTES is not read at all, because a binary blob
// or a pathological generated file is noise rather than evidence. Such a file
// is recorded BY NAME in the coverage manifest as `unreadable_or_oversized`
// with its byte count. Nothing that IS read is ever cut short.

/**
 * The read-safety bound: the bytes a single file may occupy before this builder
 * declines to read it at all. NOT a delivery budget — a file under it is
 * delivered WHOLE, and a file over it is omitted BY NAME with its byte count,
 * never trimmed to fit.
 */
const READ_SAFETY_MAX_BYTES = 512 * 1024;

interface ExcerptCandidate {
  evidence_class: EvidenceClass;
  source_path: string;
  /** Every line available for this candidate, in ascending line order. */
  lines: NumberedSourceLine[];
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

/**
 * The outcome of reading one candidate file. `oversized` carries the byte count
 * so the omission can state WHY, rather than leaving a reader to guess whether
 * the file was missing, binary, or simply large.
 */
type RepoFileRead =
  | { kind: "text"; text: string }
  | { kind: "oversized"; bytes: number }
  | { kind: "unreadable" };

async function readRepoFile(
  root: string,
  path: string,
): Promise<RepoFileRead> {
  try {
    const buf = await readFile(join(root, path));
    if (buf.byteLength > READ_SAFETY_MAX_BYTES) {
      return { kind: "oversized", bytes: buf.byteLength };
    }
    return { kind: "text", text: buf.toString("utf8") };
  } catch {
    return { kind: "unreadable" };
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
      prefix_width: excerpt.prefix_width,
    })),
    coverage,
  };
}

interface PacketPlan {
  /** Synthesized, non-file sections (the structural tree and edge list). */
  fixedSections: { heading: string; body: string }[];
  /** Per class, every candidate considered — `named`, and every one delivered. */
  candidatesByClass: Map<EvidenceClass, ExcerptCandidate[]>;
  /** The only omissions there are: unreadable/oversized, and empty. */
  omitted: Map<
    EvidenceClass,
    { path: string; reason: OmissionReason; bytes?: number }[]
  >;
  /** Candidates named but carrying no content — counted in `named`. */
  namedByClass: Map<EvidenceClass, number>;
}

function emptyPlan(): PacketPlan {
  return {
    fixedSections: [],
    candidatesByClass: new Map(),
    omitted: new Map(),
    namedByClass: new Map(),
  };
}

function note(
  plan: PacketPlan,
  evidenceClass: EvidenceClass,
  path: string,
  reason: OmissionReason,
  bytes?: number,
): void {
  const list = plan.omitted.get(evidenceClass) ?? [];
  list.push({ path, reason, ...(bytes === undefined ? {} : { bytes }) });
  plan.omitted.set(evidenceClass, list);
}

/**
 * Read one named candidate, or record the read-safety omission and yield
 * nothing. The bound is on READING, not on delivering: a file this returns is
 * delivered whole, and a file it declines is named in the coverage manifest
 * with its byte count.
 */
async function readCandidate(
  plan: PacketPlan,
  root: string,
  evidenceClass: EvidenceClass,
  path: string,
): Promise<string | undefined> {
  const read = await readRepoFile(root, path);
  if (read.kind === "text") return read.text;
  note(
    plan,
    evidenceClass,
    path,
    "unreadable_or_oversized",
    read.kind === "oversized" ? read.bytes : undefined,
  );
  return undefined;
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
 * contents: stable path order, every named candidate delivered in full, and an
 * explicit per-class coverage record in which
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
      const text = await readCandidate(plan, params.root, "doc", path);
      if (text === undefined) continue;
      const lines = numberedLinesOf(text);
      if (lines.length === 0) {
        note(plan, "doc", path, "no_content");
        continue;
      }
      addCandidate(plan, { evidence_class: "doc", source_path: path, lines });
    }
    for (const path of memberPaths) {
      nameCandidate(plan, "comment");
      const text = await readCandidate(plan, params.root, "comment", path);
      if (text === undefined) continue;
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
      const text = await readCandidate(plan, params.root, "declaration", path);
      if (text === undefined) continue;
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
      const text = await readCandidate(
        plan,
        params.root,
        "stripped_source",
        path,
      );
      if (text === undefined) continue;
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

  const layout = layoutPacket(params.kind, plan);
  const markdown = renderPacket(
    params.kind,
    plan.fixedSections,
    layout.excerpts,
    layout.coverage,
  );
  return { markdown, coverage: layout.coverage, excerpts: layout.excerpts };
}

/**
 * Number every named excerpt and state what the packet delivered.
 *
 * Emission order is the order candidates were named — class by class in the
 * order the kind's branch reads them (docs before comments for `stated`), path
 * order within a class — so it is DERIVED, never a second hand-kept list that
 * could drift from the branch above.
 */
function layoutPacket(
  kind: CharterKind,
  plan: PacketPlan,
): { excerpts: PacketExcerpt[]; coverage: CharterPacketCoverage } {
  const excerpts: PacketExcerpt[] = [];
  for (const [evidenceClass, candidates] of plan.candidatesByClass) {
    for (const candidate of candidates) {
      excerpts.push({
        excerpt_id: `E${String(excerpts.length + 1).padStart(2, "0")}`,
        evidence_class: evidenceClass,
        source_path: candidate.source_path,
        line_runs: lineRunsOf(candidate.lines),
        lines: candidate.lines.map((entry) => ({
          line: entry.line,
          text: entry.text,
        })),
        prefix_width: prefixWidthFor(candidate.lines),
      });
    }
  }

  const classes: CharterPacketCoverageClass[] = [];
  for (const evidenceClass of EVIDENCE_CLASSES) {
    const named = plan.namedByClass.get(evidenceClass);
    if (named === undefined) continue;
    classes.push({
      evidence_class: evidenceClass,
      named,
      delivered: (plan.candidatesByClass.get(evidenceClass) ?? []).length,
      omitted: [...(plan.omitted.get(evidenceClass) ?? [])].sort((a, b) =>
        compareCodeUnits(a.path, b.path),
      ),
    });
  }

  return { excerpts, coverage: { kind, classes } };
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
    "Every file this channel names is delivered IN FULL — nothing here was cut",
    "short to fit a size budget, because this packet carries no character limit.",
    "Any file that could not be delivered at all is named at the end with its",
    "reason, so an absence is stated rather than silent.",
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
    entry.omitted.map(
      (row) =>
        `${row.path} (${OMISSION_PROSE[row.reason]}` +
        `${row.bytes === undefined ? "" : `, ${row.bytes} bytes`})`,
    ),
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
  unreadable_or_oversized: "unreadable or oversized",
  no_content: "no content of this evidence class in the file",
};
