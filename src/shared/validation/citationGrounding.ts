/**
 * Citation grounding — ONE core, two draws.
 *
 * A citation is `path`, `path:line`, or `path:start-end`. This module is the
 * single authority that parses one, resolves its path against the repository,
 * checks its line range against the file's REAL length, optionally re-verifies a
 * quoted span, and — when the caller can say what evidence was actually handed to
 * the author — checks that the cited lines lie inside evidence that was delivered.
 *
 * Two draws consume it:
 *   - the REMEDIATE draw asks the existential question ("does this evidence
 *     string cite at least one real, in-range location?") through
 *     `evidenceCitesRealPath`, a thin wrapper in `src/remediate/phases/grounding.ts`;
 *   - the AUDIT draw asks the per-citation question over a charter register's
 *     `provenance[].ref` / `.quote` and records each verdict.
 *
 * **The core is SYNCHRONOUS**, over an injected {@link SyncSourceReader}. That is
 * a deliberate constraint, not an oversight: the remediate draw's callers
 * (`evidenceCitesRealPath`, `groundEvidence`) are synchronous predicates called
 * inside `.some()` over every finding's evidence, and making them async would
 * cascade through the whole grounding pass for no gain — the reads are small,
 * memoized per pass, and already synchronous today.
 *
 * **It REJECTS, it never REPAIRS.** A wrong line number is reported unchanged;
 * there is no nearest-enclosing-declaration resolution. That pass was tried and
 * rejected repo-wide on 2026-07-28 (see `docs/backlog/durable-traps.md`, "Cite a
 * SYMBOL, never a bare line number"): it swapped an honest stale number for a
 * confident wrong one. The verdict enum has no repair state, so the exclusion is
 * by construction rather than by intent.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { compareCodeUnits } from "../compareCodeUnits.js";
import {
  isBareBasename,
  quoteMatches,
  resolveBasenameToTrackedPath,
} from "./findingGrounding.js";

/** Reads a source file's text synchronously; injectable so the core is testable without fs. */
export type SyncSourceReader = (absolutePath: string) => string;

const defaultSyncSourceReader: SyncSourceReader = (absolutePath) =>
  readFileSync(absolutePath, "utf8");

/**
 * A {@link SyncSourceReader} memoized by absolute path, for ONE checking pass: a
 * batch of citations into the same file reads that file once. Failures are cached
 * too, so an unreadable path is not retried per citation.
 *
 * Scope it to a single pass and discard it — a reader that outlived the pass
 * would serve stale bytes after a later edit, which is exactly what re-checking
 * a citation against disk exists to catch.
 */
export function createMemoizedSyncSourceReader(): SyncSourceReader {
  const hits = new Map<string, string>();
  const misses = new Map<string, unknown>();
  return (absolutePath) => {
    const cached = hits.get(absolutePath);
    if (cached !== undefined) return cached;
    if (misses.has(absolutePath)) throw misses.get(absolutePath);
    try {
      const text = defaultSyncSourceReader(absolutePath);
      hits.set(absolutePath, text);
      return text;
    } catch (error) {
      misses.set(absolutePath, error);
      throw error;
    }
  };
}

/**
 * The number of TRUE lines in a source text.
 *
 * Two corrections over a bare `split("\n").length`, both of which produced a
 * silent off-by-one that let `path:<n+1>` ground into an n-line file:
 *   - a single TRAILING empty segment is dropped — a file that ends with a line
 *     terminator has n lines, not n+1;
 *   - carriage returns are stripped first, so a CRLF checkout counts the same as
 *     an LF one (`OS/platform-agnostic`: the same file must not have two lengths
 *     depending on who checked it out).
 * Empty content is zero lines.
 */
export function countSourceLines(content: string): number {
  if (content.length === 0) return 0;
  const segments = content.replace(/\r/g, "").split("\n");
  if (segments.length > 1 && segments[segments.length - 1] === "") {
    segments.pop();
  }
  return segments.length;
}

/** A parsed citation reference. `end_line` is absent for a single-line citation. */
export interface ParsedCitation {
  /** The reference exactly as it was written — never rewritten, never repaired. */
  raw: string;
  path: string;
  start_line?: number;
  end_line?: number;
}

/** The `:<start>[-<end>]` suffix, anchored at the end of a reference. */
const LINE_SUFFIX_RE = /:(\d+)(?:-(\d+))?$/;

/**
 * Parse `path`, `path:12`, or `path:12-19` into its parts. Returns `undefined`
 * when the reference carries no path at all (empty, or a bare line suffix).
 * The path half is taken verbatim: resolving it is a separate step, so a
 * component id or a checkpoint field parses here and fails to resolve later,
 * which is the honest split.
 */
export function parseCitationRef(ref: string): ParsedCitation | undefined {
  const trimmed = ref.trim();
  if (trimmed.length === 0) return undefined;
  const suffix = LINE_SUFFIX_RE.exec(trimmed);
  if (!suffix) return { raw: ref, path: trimmed };
  const path = trimmed.slice(0, suffix.index);
  if (path.length === 0) return undefined;
  const start = Number(suffix[1]);
  const end = suffix[2] === undefined ? undefined : Number(suffix[2]);
  return end === undefined
    ? { raw: ref, path, start_line: start }
    : { raw: ref, path, start_line: start, end_line: end };
}

/**
 * Candidate `path[:start[-end]]` citations inside a prose string. A token must
 * look like a path (contains a separator or a dot-extension) to be considered;
 * bare prose words never match. THE one home of the embedded-citation grammar —
 * the range half is what a `(?::(\d+))?` grammar silently dropped, validating a
 * citation's start while its end overshot the file by 50x.
 */
const EVIDENCE_PATH_TOKEN_RE =
  /(?<path>[A-Za-z0-9_@.-]*[/\\][A-Za-z0-9_@./\\-]+|[A-Za-z0-9_@-]+\.[A-Za-z0-9_-]+)(?::(?<start>\d+)(?:-(?<end>\d+))?)?/g;

/** Every citation reference embedded in a prose string, in source order. */
export function extractCitationRefs(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(EVIDENCE_PATH_TOKEN_RE)) {
    const path = match.groups?.path;
    if (!path) continue;
    const start = match.groups?.start;
    const end = match.groups?.end;
    refs.push(
      start === undefined
        ? path
        : end === undefined
          ? `${path}:${start}`
          : `${path}:${start}-${end}`,
    );
  }
  return refs;
}

/**
 * Strip the emitted `NNN| ` line prefix from every line of a quoted span,
 * POSITIONALLY — by the fixed character width the emitter recorded, never by a
 * regex. A regex (`^\s*\d+\| `) collides with the markdown table rows the doc
 * evidence class delivers verbatim (`| 12 | value |`), silently mutilating a
 * quoted cell before it is matched. A line shorter than the prefix carries no
 * prefix and is left alone.
 */
export function stripEmittedLinePrefix(text: string, prefixWidth: number): string {
  if (prefixWidth <= 0) return text;
  return text
    .split("\n")
    .map((line) => (line.length >= prefixWidth ? line.slice(prefixWidth) : line))
    .join("\n");
}

/** One contiguous run of TRUE 1-based source lines. */
export interface DeliveredLineRun {
  start: number;
  end: number;
}

/**
 * One excerpt as it was actually delivered to the author: which file it came
 * from, which contiguous line runs of that file it contained, and how wide the
 * emitted per-line prefix was. A first-to-last SPAN would be a lie for a
 * deliberately non-contiguous excerpt (extracted comment blocks, declaration
 * lines) — the runs are what was delivered, so the runs are what is checked.
 */
export interface DeliveredExcerpt {
  source_path: string;
  line_runs: readonly DeliveredLineRun[];
  prefix_width: number;
}

export type CitationVerdict =
  | "ok"
  | "unparseable"
  | "unknown_path"
  | "inverted_range"
  | "line_out_of_range"
  | "outside_delivered_evidence"
  | "quote_not_found";

export interface CitationCheck {
  owner_id: string;
  /** The submitted reference, byte-identical — reported, never rewritten. */
  ref: string;
  verdict: CitationVerdict;
  resolved_path?: string;
  file_lines?: number;
  detail?: string;
}

export interface CitationInput {
  /** Whatever the caller uses to attribute the citation (a charter id, a lane). */
  owner_id: string;
  ref: string;
  quote?: string;
}

export interface CheckCitationsParams {
  root: string;
  /** Tracked repo paths, case-preserving — for bare-basename resolution. */
  corpus: ReadonlySet<string>;
  citations: readonly CitationInput[];
  readSource?: SyncSourceReader;
  /**
   * What the author was actually handed. When supplied, a citation whose lines
   * lie in no delivered run is `outside_delivered_evidence`. When ABSENT the
   * check is skipped entirely and {@link CitationCheckResult.delivered_evidence_checked}
   * says so — an unavailable manifest must read as "not checked", never as a pass.
   */
  delivered?: readonly DeliveredExcerpt[];
}

export interface CitationCheckResult {
  /** Citations that parsed into a path and were checked. */
  checked_count: number;
  /** Every citation's verdict, sorted by (owner_id, ref). */
  checks: CitationCheck[];
  /** Whether the delivered-evidence leg ran (a `delivered` index was supplied). */
  delivered_evidence_checked: boolean;
}

interface ResolvedCitedPath {
  absolutePath: string;
  repoRelativePath: string;
}

/**
 * Resolve a cited path to an existing absolute path plus the repo-relative form
 * it resolved through. A full/dotfile path resolves by the `root` join; a bare
 * basename that is not a top-level file resolves against the tracked-path corpus
 * (INV-B3-3) so a nested `advance.ts` is not false-negatived.
 */
function resolveCitedPath(
  root: string,
  citedPath: string,
  corpus: ReadonlySet<string>,
): ResolvedCitedPath | undefined {
  const trimmed = citedPath.trim();
  const direct = isAbsolute(trimmed) ? trimmed : join(root, trimmed);
  if (existsSync(direct)) {
    return { absolutePath: direct, repoRelativePath: trimmed.replace(/\\/g, "/") };
  }
  if (isBareBasename(trimmed)) {
    const tracked = resolveBasenameToTrackedPath(trimmed, corpus);
    if (tracked) {
      const resolved = isAbsolute(tracked) ? tracked : join(root, tracked);
      if (existsSync(resolved)) {
        return { absolutePath: resolved, repoRelativePath: tracked };
      }
    }
  }
  return undefined;
}

function runContains(
  runs: readonly DeliveredLineRun[],
  start: number,
  end: number,
): boolean {
  return runs.some((run) => start >= run.start && end <= run.end);
}

/**
 * Check every citation and return a verdict for each. Deterministic and
 * order-stable: the result array is sorted by `(owner_id, ref)`, so a re-run over
 * the same inputs produces a byte-identical array and cannot churn the content
 * hash of an artifact that carries it.
 */
export function checkCitations(
  params: CheckCitationsParams,
): CitationCheckResult {
  const readSource = params.readSource ?? createMemoizedSyncSourceReader();
  const deliveredByPath = new Map<string, DeliveredExcerpt[]>();
  for (const excerpt of params.delivered ?? []) {
    const existing = deliveredByPath.get(excerpt.source_path);
    if (existing) existing.push(excerpt);
    else deliveredByPath.set(excerpt.source_path, [excerpt]);
  }
  const deliveredChecked = params.delivered !== undefined;

  const checks: CitationCheck[] = [];
  let checkedCount = 0;

  for (const citation of params.citations) {
    const parsed = parseCitationRef(citation.ref);
    if (!parsed) {
      checks.push({
        owner_id: citation.owner_id,
        ref: citation.ref,
        verdict: "unparseable",
        detail: "no path could be read from the reference",
      });
      continue;
    }
    checkedCount += 1;

    const resolved = resolveCitedPath(params.root, parsed.path, params.corpus);
    if (!resolved) {
      checks.push({
        owner_id: citation.owner_id,
        ref: citation.ref,
        verdict: "unknown_path",
        detail: `'${parsed.path}' does not resolve in the repository`,
      });
      continue;
    }

    const excerpts = deliveredByPath.get(resolved.repoRelativePath) ?? [];
    let fileLines: number | undefined;
    if (parsed.start_line !== undefined) {
      const end = parsed.end_line ?? parsed.start_line;
      if (parsed.start_line > end) {
        checks.push({
          owner_id: citation.owner_id,
          ref: citation.ref,
          verdict: "inverted_range",
          resolved_path: resolved.repoRelativePath,
          detail: `start line ${parsed.start_line} is after end line ${end}`,
        });
        continue;
      }
      let isFile = false;
      try {
        isFile = statSync(resolved.absolutePath).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) {
        checks.push({
          owner_id: citation.owner_id,
          ref: citation.ref,
          verdict: "unknown_path",
          resolved_path: resolved.repoRelativePath,
          detail: "cited lines in something that is not a readable file",
        });
        continue;
      }
      let content: string;
      try {
        content = readSource(resolved.absolutePath);
      } catch {
        checks.push({
          owner_id: citation.owner_id,
          ref: citation.ref,
          verdict: "unknown_path",
          resolved_path: resolved.repoRelativePath,
          detail: "file could not be read on disk",
        });
        continue;
      }
      fileLines = countSourceLines(content);
      if (parsed.start_line < 1 || end > fileLines) {
        checks.push({
          owner_id: citation.owner_id,
          ref: citation.ref,
          verdict: "line_out_of_range",
          resolved_path: resolved.repoRelativePath,
          file_lines: fileLines,
          detail: `cited lines ${parsed.start_line}-${end} in a ${fileLines}-line file`,
        });
        continue;
      }
      if (deliveredChecked) {
        const inside = excerpts.some((excerpt) =>
          runContains(excerpt.line_runs, parsed.start_line!, end),
        );
        if (!inside) {
          checks.push({
            owner_id: citation.owner_id,
            ref: citation.ref,
            verdict: "outside_delivered_evidence",
            resolved_path: resolved.repoRelativePath,
            file_lines: fileLines,
            detail:
              excerpts.length === 0
                ? "no excerpt of this file was delivered to the author"
                : `lines ${parsed.start_line}-${end} lie in no delivered run of this file`,
          });
          continue;
        }
      }
    }
    // A PATH-ONLY citation makes no line claim, so it is not checked against the
    // delivered runs. Some channels legitimately name a file they delivered no
    // excerpt of — the structural packet lists every member in its file tree
    // while a member with no top-level declarations yields no excerpt — and
    // refusing those would be a false red, not a caught defect.

    const quote = citation.quote?.trim() ?? "";
    if (quote.length > 0) {
      let content: string;
      try {
        content = readSource(resolved.absolutePath);
      } catch {
        checks.push({
          owner_id: citation.owner_id,
          ref: citation.ref,
          verdict: "unknown_path",
          resolved_path: resolved.repoRelativePath,
          detail: "file could not be read on disk",
        });
        continue;
      }
      // The RAW quote first — a correctly de-prefixed quote must never be
      // mutilated by a strip it did not need. Only when that fails is the
      // positional strip tried, using the width the emitter recorded.
      const widths = new Set(excerpts.map((excerpt) => excerpt.prefix_width));
      const matched =
        quoteMatches(content, citation.quote!) ||
        [...widths].some((width) =>
          quoteMatches(content, stripEmittedLinePrefix(citation.quote!, width)),
        );
      if (!matched) {
        checks.push({
          owner_id: citation.owner_id,
          ref: citation.ref,
          verdict: "quote_not_found",
          resolved_path: resolved.repoRelativePath,
          file_lines: fileLines,
          detail: "the quoted span does not appear in the cited file",
        });
        continue;
      }
    }

    checks.push({
      owner_id: citation.owner_id,
      ref: citation.ref,
      verdict: "ok",
      resolved_path: resolved.repoRelativePath,
      ...(fileLines === undefined ? {} : { file_lines: fileLines }),
    });
  }

  checks.sort(
    (a, b) =>
      compareCodeUnits(a.owner_id, b.owner_id) || compareCodeUnits(a.ref, b.ref),
  );
  return {
    checked_count: checkedCount,
    checks,
    delivered_evidence_checked: deliveredChecked,
  };
}
