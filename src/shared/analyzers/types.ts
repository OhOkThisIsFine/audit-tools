import { z } from "zod";
import { AnalyzerLeadProvenanceSchema } from "./provenance.js";
import { compareCodeUnits } from "../compareCodeUnits.js";
import {
  outcomeLostCoverage,
  type MeasuredOutcome,
} from "../measurement/measuredOutcome.js";

/** One normalized result imported from an external analyzer such as eslint or tsc. */
export const ExternalAnalyzerResultItemSchema = z
  .object({
    id: z.string(),
    category: z.string(),
    severity: z.string(),
    path: z.string(),
    line_start: z.number().optional(),
    line_end: z.number().optional(),
    summary: z.string(),
    rule: z.string().optional(),
    /** Preserves the analyzer-native payload when consumers need original detail. */
    raw: z.unknown().optional(),
    /** Content-anchored lead identity for the close-verify draw (item C). */
    provenance: AnalyzerLeadProvenanceSchema.optional(),
  })
  .strict();
export type ExternalAnalyzerResultItem = z.infer<
  typeof ExternalAnalyzerResultItemSchema
>;

/**
 * A normalized language-neutral graph edge contributed by an EXTERNAL analyzer
 * (ast-grep / broader-semgrep dataflow / CodeQL dataflow). `from`/`to` are repo
 * paths (resolved against the path lookup at extraction); `kind`/`confidence`/
 * `reason` are optional provenance, mirroring the in-tree {@link GraphEdge}
 * shape so external dataflow enriches the same edge set the language analyzers
 * feed — no per-ecosystem fork. Carried on the adapter contract so a malformed
 * native payload degrades to an empty edge list rather than throwing.
 */
export const ExternalAnalyzerGraphEdgeSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    kind: z.string().optional(),
    confidence: z.number().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ExternalAnalyzerGraphEdge = z.infer<
  typeof ExternalAnalyzerGraphEdgeSchema
>;

/** A normalized analyzer hint that a bounded set of files belongs to a root. */
export const ExternalAnalyzerOwnershipRootSchema = z
  .object({
    root: z.string(),
    paths: z.array(z.string()),
    kind: z.string().optional(),
    confidence: z.number().optional(),
    reason: z.string().optional(),
  })
  .strict();

/**
 * The analyzer status vocabulary, single-sourced (artifact:analyzer-status-vocabulary).
 * The zod enum below is BUILT from this tuple, so there is exactly one place a member
 * is added — and {@link EXTERNAL_ANALYZER_STATUS_CLASSIFICATION} below is an exhaustive
 * `Record` over it, so widening the tuple without classifying the new member is a
 * COMPILE error rather than a silent fall-through to "the run was fine".
 */
export const EXTERNAL_ANALYZER_TOOL_STATUSES = [
  "skipped",
  "success",
  "findings",
  "not_resolved",
  "spawn_error",
  "parse_error",
  "failed",
  /** The downloaded release asset did not match the pinned release checksums. */
  "checksum_mismatch",
] as const;

export type ExternalAnalyzerToolStatusValue =
  (typeof EXTERNAL_ANALYZER_TOOL_STATUSES)[number];

/**
 * What each status says about COVERAGE — the question every consumer of a status
 * record is really asking. `clean` is the ONLY value that may be read as "this tool
 * ran and found nothing"; `degraded` means the tool ran but its output cannot be
 * trusted as coverage; `not_run` means no coverage was produced at all.
 *
 * Exhaustive by construction: adding a member to
 * {@link EXTERNAL_ANALYZER_TOOL_STATUSES} without adding its row here fails
 * `npm run check`, so a new status can never default into `clean`.
 */
/**
 * What a status says about coverage: the shared {@link MeasuredOutcome}
 * vocabulary minus the one member an imported tool run can never be. A tool was
 * asked to run, so "there was nothing to measure" is not an answer available to
 * it — `not_applicable` belongs to channels whose input set can legitimately be
 * empty (an obligation with no planned tasks, an analyzer with no supported
 * files), not to a candidate the acquisition engine actually invoked.
 *
 * An ALIAS, deliberately, not a second copy: the words, their coverage
 * classification, and the member-level question all live in
 * `src/shared/measurement/measuredOutcome.ts`, so the two vocabularies cannot
 * drift.
 */
export type ExternalAnalyzerCoverage = Exclude<MeasuredOutcome, "not_applicable">;

/**
 * True when a coverage class means NO trustworthy coverage was produced — the
 * single member-level answer. Both consumers ask it here rather than each
 * re-typing `=== "degraded" || === "not_run"`, and it DELEGATES to the shared
 * vocabulary's own table, so widening the coverage vocabulary is one edit
 * guarded by a compile error, never a silent divergence between two copies of
 * the same comparison.
 */
export function isNonCleanAnalyzerCoverage(coverage: ExternalAnalyzerCoverage): boolean {
  return outcomeLostCoverage(coverage);
}

export const EXTERNAL_ANALYZER_STATUS_CLASSIFICATION: Record<
  ExternalAnalyzerToolStatusValue,
  ExternalAnalyzerCoverage
> = {
  skipped: "not_run",
  success: "clean",
  findings: "findings",
  not_resolved: "not_run",
  spawn_error: "degraded",
  parse_error: "degraded",
  failed: "degraded",
  checksum_mismatch: "degraded",
};

/**
 * True when a RECORD means "this tool did not produce trustworthy coverage".
 *
 * The status member alone cannot answer this, because degradation is not always
 * terminal: a run can exit non-zero, fail to parse, or drop rows and STILL surface
 * some items, which lands it on `findings` — an affirmative member describing a
 * partially-crashed run. Asking the member in isolation reports such a run as
 * trustworthy, which is the same success-shaped-empty mistake one level up.
 *
 * So the question is asked of the whole record: degraded when the member says so, OR
 * when the record carries a marker that findings were LOST —
 *  - a non-zero exit, or a NULL exit (killed by a signal, never exited on its own);
 *  - `dropped_rows` (parser rows plus normalizer items the run failed to report).
 *
 * `source_read_failures` is deliberately NOT in that set. Provenance is optional
 * everywhere on this contract: an item whose anchor could not be resolved is still a
 * fully reported lead, so an unresolved anchor is a weaker join key, not lost
 * coverage. It stays on the record because it is worth surfacing; it just does not
 * make the run untrustworthy.
 *
 * {@link EXTERNAL_ANALYZER_STATUS_CLASSIFICATION} remains the status-MEMBER map and
 * the compile gate; this is the consumer-facing answer.
 */
export function isDegradedExternalAnalyzerStatus(
  record: Pick<ExternalAnalyzerToolStatus, "status" | "exit_code" | "dropped_rows">,
): boolean {
  const classification = EXTERNAL_ANALYZER_STATUS_CLASSIFICATION[record.status];
  if (isNonCleanAnalyzerCoverage(classification)) return true;
  if (record.exit_code === null) return true;
  if (typeof record.exit_code === "number" && record.exit_code !== 0) return true;
  if ((record.dropped_rows ?? 0) > 0) return true;
  return false;
}

export const ExternalAnalyzerToolStatusSchema = z
  .object({
    tool: z.string(),
    command: z.string().optional(),
    resolved: z.boolean(),
    status: z.enum(EXTERNAL_ANALYZER_TOOL_STATUSES),
    exit_code: z.number().nullable().optional(),
    error: z.string().optional(),
    output_snippet: z.string().optional(),
    /**
     * The tool's own stderr, bounded. Present whenever stderr carried text — it is
     * the only post-run evidence of WHY a non-zero exit or a stderr-only run failed.
     */
    stderr_snippet: z.string().optional(),
    /**
     * Everything this run failed to report, as ONE count: rows the parser understood
     * the shape of but could not use (malformed CSV/JSON rows), PLUS items the
     * normalizer discarded for a missing path or summary. The engine merges the two
     * because they are the same question to a consumer — how much did this run lose?
     * A non-zero count means the run under-reports; it is never a clean scan.
     */
    dropped_rows: z.number().optional(),
    /**
     * Items that named a path + line but whose source could not be read, so their
     * content-anchored provenance was dropped. Distinguishes a broken read seam from
     * a tool that legitimately reports no line numbers.
     */
    source_read_failures: z.number().optional(),
    duration_ms: z.number().optional(),
  })
  .strict();
export type ExternalAnalyzerToolStatus = z.infer<
  typeof ExternalAnalyzerToolStatusSchema
>;

/**
 * The generic pre-normalization item shape every analyzer parser emits. `from`/`to`
 * are the optional dataflow-edge endpoints `normalizeGenericExternalEdges` reads.
 */
export interface ExternalAnalyzerParsedItem {
  id?: string;
  category?: string;
  severity?: string;
  path?: string;
  line_start?: number;
  line_end?: number;
  summary?: string;
  rule?: string;
  raw?: unknown;
  from?: unknown;
  to?: unknown;
}

/**
 * A parse that can SAY it degraded. A bare `[]` cannot distinguish "the tool found
 * nothing" from "the payload was unparseable" or "half the rows were malformed", and
 * that ambiguity is what makes a broken analyzer read as a clean scan downstream.
 */
export interface ExternalAnalyzerParseReport {
  items: ExternalAnalyzerParsedItem[];
  /** The payload could not be parsed at all (bad JSON/CSV, or the wrong top-level shape). */
  parse_failed?: boolean;
  /** Rows recognised but unusable — counted, never silently dropped. */
  dropped_rows?: number;
  /** Human-readable cause, carried onto the status record. */
  note?: string;
}

/**
 * What `ExternalAnalyzerCandidate.parse` returns. A plain array is the "nothing to
 * report beyond the items" form; the report form is how a parser reports degradation.
 * Read both through {@link readParseOutcome} so no consumer has to branch.
 */
export type ExternalAnalyzerParseOutcome =
  | ExternalAnalyzerParsedItem[]
  | ExternalAnalyzerParseReport;

/** Normalize either parse-outcome form into the report form. */
export function readParseOutcome(
  outcome: ExternalAnalyzerParseOutcome | undefined | null,
): Required<Pick<ExternalAnalyzerParseReport, "items">> &
  Omit<ExternalAnalyzerParseReport, "items"> {
  if (Array.isArray(outcome)) return { items: outcome };
  if (!outcome || typeof outcome !== "object" || !Array.isArray(outcome.items)) {
    return {
      items: [],
      parse_failed: true,
      note: "parser returned no usable outcome",
    };
  }
  return {
    items: outcome.items,
    ...(outcome.parse_failed !== undefined ? { parse_failed: outcome.parse_failed } : {}),
    ...(outcome.dropped_rows !== undefined ? { dropped_rows: outcome.dropped_rows } : {}),
    ...(outcome.note !== undefined ? { note: outcome.note } : {}),
  };
}

/** Imported analyzer output captured at a single generation time. */
export const ExternalAnalyzerResultsSchema = z
  .object({
    tool: z.string(),
    generated_at: z.string().optional(),
    ownership_roots: z.array(ExternalAnalyzerOwnershipRootSchema).optional(),
    /**
     * Language-neutral graph edges contributed by an external dataflow analyzer.
     * Optional so legacy/finding-only imports still parse under `.strict()`.
     */
    graph_edges: z.array(ExternalAnalyzerGraphEdgeSchema).optional(),
    tool_statuses: z.array(ExternalAnalyzerToolStatusSchema).optional(),
    results: z.array(ExternalAnalyzerResultItemSchema),
  })
  .strict();
export type ExternalAnalyzerResults = z.infer<
  typeof ExternalAnalyzerResultsSchema
>;

/**
 * Marker artifact written by the external-analyzer acquisition executor
 * (`external_analyzer_acquisition.json`). It records THAT acquisition ran for the
 * current {repo_manifest, file_disposition} and WITH WHAT outcome per candidate —
 * the obligation `external_analyzers_current` is satisfied when this marker is
 * present + fresh. The normalized findings themselves live in
 * `external_analyzer_results.json` (the per-tool array); this marker is the
 * provenance/run record + the staleness anchor, so a manifest/disposition change
 * re-stales it and re-runs acquisition. `enabled: false` is the hermetic no-op
 * (acquisition was not explicitly enabled for this advance) — no subprocess or
 * network ran; `tool_statuses` is empty.
 */
export const ExternalAnalyzerAcquisitionMarkerSchema = z
  .object({
    generated_at: z.string().optional(),
    enabled: z.boolean(),
    tool_statuses: z.array(ExternalAnalyzerToolStatusSchema),
  })
  .strict();
export type ExternalAnalyzerAcquisitionMarker = z.infer<
  typeof ExternalAnalyzerAcquisitionMarkerSchema
>;

/**
 * Merge one tool's results into the per-tool array artifact: the entry with the
 * same `tool` is REPLACED (a fresh run supersedes the prior one); otherwise the
 * entry is appended. Multiple producers (import / syntax-resolution / the
 * acquisition engine) each contribute their own tool entry without clobbering
 * the others. Returns a new array sorted by `tool` for deterministic output.
 */
export function upsertExternalToolResults(
  existing: ExternalAnalyzerResults[] | undefined,
  incoming: ExternalAnalyzerResults,
): ExternalAnalyzerResults[] {
  const next = (existing ?? []).filter((entry) => entry.tool !== incoming.tool);
  next.push(incoming);
  return next.sort((a, b) => compareCodeUnits(a.tool, b.tool));
}
