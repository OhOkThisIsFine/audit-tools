/**
 * The charter evidence PACKET contract — what a blind lane was handed, stated in
 * a shape the lane can copy a citation out of and a consumer can measure.
 *
 * Two defects made these types necessary, and both were invisible from inside a
 * run. (1) The packet was two strings per section, so every transform that built
 * it destroyed line correspondence; the prompt then forbade opening real files
 * while asking for a `ref`, so a lane that OBEYED could only emit its offset into
 * the concatenated packet — obedience produced the wrong answer. (2) The builder
 * walked one greedy budget in doc-then-comment order, so the "stated" channel,
 * whose whole job is source comments, delivered zero of 72 comment blocks and
 * said so only in prose inside a file that was then deleted.
 *
 * LINE RUNS, NEVER A SPAN. An excerpt is deliberately non-contiguous: extracted
 * comment blocks and top-level declaration lines are scattered through their
 * file. A first-to-last `start_line`/`end_line` pair over such an excerpt is
 * false precision of exactly the kind the 2026-07-28 citation trap rejects — it
 * would let a validator CERTIFY a 238-line claim over 60 delivered lines. The
 * runs are what was delivered, so the runs are what is published and checked.
 */
import type { CharterKind } from "./charter.js";

/**
 * Which channel of evidence an excerpt carries. A packet's coverage is reported
 * per class, because a packet that delivers every doc and no comment is not
 * "94% covered" — it is one class complete and one class empty.
 */
export type EvidenceClass =
  | "doc"
  | "comment"
  | "declaration"
  | "stripped_source";

/** Canonical class order — the one home, so every consumer sorts identically. */
export const EVIDENCE_CLASSES: readonly EvidenceClass[] = [
  "comment",
  "declaration",
  "doc",
  "stripped_source",
];

/**
 * Why a named candidate did not reach the packet. `no_content` is the reason
 * that closes the two SILENT skips: a member with no comments and a file with no
 * top-level declarations used to appear in neither the delivered nor the omitted
 * list, so `delivered + omitted === named` could not be reconciled at all.
 *
 * There are exactly TWO reasons, because the packet carries no character limit
 * (owner, 2026-09-04): a file is either read and delivered WHOLE, or it is named
 * here. `unreadable_or_oversized` is the read-safety guard — a file too large to
 * read at all, recorded with its byte count — and never a budget verdict; the
 * `total_budget` reason died with the ceiling, the per-file clamp and the
 * allocator that produced it.
 *
 * EVERY value here has a producer, and a contract test pins that: a vocabulary
 * value with no producer is a claim the data can never make, so it would only
 * ever mislead a reader of the coverage record.
 */
export type OmissionReason = "unreadable_or_oversized" | "no_content";

/** One delivered source line, carrying its TRUE 1-based number in its own file. */
export interface PacketExcerptLine {
  line: number;
  text: string;
}

/** One contiguous run of TRUE 1-based source lines actually delivered. */
export interface PacketLineRun {
  start: number;
  end: number;
}

/**
 * One excerpt as delivered. `line_runs` is derived from `lines` and is the
 * surface a lane copies a citation from: a `ref` names ONE run, never a
 * first-to-last span across the gaps between them.
 *
 * `prefix_width` is the fixed character width of the emitted `NNN| ` prefix on
 * every content line of this excerpt. A validator strips it POSITIONALLY by this
 * number — never by a regex, which would eat the leading cells out of the
 * markdown table rows the doc class delivers verbatim.
 */
export interface PacketExcerpt {
  /** `E01`, `E02`, … in emission order, which is path order. */
  excerpt_id: string;
  evidence_class: EvidenceClass;
  /** Repo-relative, forward-slashed. */
  source_path: string;
  line_runs: PacketLineRun[];
  lines: PacketExcerptLine[];
  prefix_width: number;
}

/** Per-class delivery figures. `delivered + omitted.length === named` is an invariant. */
export interface CharterPacketCoverageClass {
  evidence_class: EvidenceClass;
  /** Every candidate file considered for this class. */
  named: number;
  /** Excerpts delivered — in full, which is the only way they are delivered. */
  delivered: number;
  /**
   * Path-sorted; every named candidate that did not make it, with its reason.
   * `bytes` is the file's size, stated on the read-safety omission so the record
   * says WHY rather than leaving a reader to guess between missing and huge.
   */
  omitted: { path: string; reason: OmissionReason; bytes?: number }[];
}

/**
 * What one packet delivered against what it named. It renders UNCONDITIONALLY
 * into the report — unlike the submission-drift section, where clean is the
 * expected case and presence is the statement. Here the measured case was
 * 0-of-72, and a silent section would leave "complete" indistinguishable from
 * "not measured", which is the exact false-green this contract exists to close.
 */
export interface CharterPacketCoverage {
  kind: CharterKind;
  /** One entry per class this kind emits, sorted by canonical class order. */
  classes: CharterPacketCoverageClass[];
}

export const CHARTER_PACKET_MANIFEST_SCHEMA_VERSION =
  "charter-packet-manifest/v1";

/** A manifest row: an excerpt's coordinates without its text. */
export interface CharterPacketManifestExcerpt {
  excerpt_id: string;
  source_path: string;
  evidence_class: EvidenceClass;
  line_runs: PacketLineRun[];
  line_count: number;
  prefix_width: number;
}

/**
 * The machine header at the top of every packet, and — byte-identically — the
 * lane asset the emit pass persists so the INGEST pass (a different invocation)
 * can fold coverage into the register and check citations against what was
 * actually delivered. One value, two renderings, emitted by one function, so the
 * manifest a lane reads and the manifest a validator checks against cannot drift.
 */
export interface CharterPacketManifest {
  schema_version: typeof CHARTER_PACKET_MANIFEST_SCHEMA_VERSION;
  kind: CharterKind;
  excerpts: CharterPacketManifestExcerpt[];
  coverage: CharterPacketCoverage;
}

/**
 * The affirmation that the citation check RAN. `validation_issues: []` is
 * unfalsifiable on its own — it printed identically at 1-of-15 correct citations
 * and at 75-of-75 — so an empty issue list is only ever emitted beside a stated
 * status and a stated count.
 *
 * `not_run` is a RECORDED ABSTENTION, never an implicit pass: it means no
 * repository root was available to check against. `no_citations` is the omit
 * path — a pass that authored nothing has nothing to certify, and must not
 * report `checked` over work it never examined.
 */
export interface CitationValidationSummary {
  status: "checked" | "not_run" | "no_citations";
  /** Provenance refs seen. */
  citation_count: number;
  /** Refs parsed and validated. */
  checked_count: number;
  failed_count: number;
  /**
   * Whether the delivered-evidence leg ran. False when no packet manifest was
   * available at ingest — the range was still checked against the file, but
   * "was this line ever handed to the author" was not asked.
   */
  delivered_evidence_checked: boolean;
}
