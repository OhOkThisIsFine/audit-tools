import { z } from "zod";
import { hashContent } from "../hash.js";

/**
 * Content-anchored identity of one analyzer lead — the join key that lets
 * remediation's close-verify draw ask "does this exact lead still fire?"
 * mechanically (item C of `spec/mechanical-analyzer-layer-design.md`).
 *
 * Anchored on the NORMALIZED flagged snippet, never line numbers: edits shift
 * lines, but an untouched clone/violation re-hashes identically wherever it
 * moves within its file. Optional everywhere it is carried — a lead whose
 * snippet cannot be read simply carries no provenance and is exempt from
 * mechanical verification.
 */
export const AnalyzerLeadProvenanceSchema = z
  .object({
    /** Candidate id that produced the lead (e.g. "jscpd", "gitleaks"). */
    analyzer_id: z.string(),
    /** Analyzer-native rule id, when the tool reports one. */
    rule: z.string().optional(),
    /** Repo-relative path of the flagged file. */
    path: z.string(),
    /** `hashAnalyzerSnippet` digest of the normalized flagged span. */
    snippet_hash: z.string(),
  })
  .strict();
export type AnalyzerLeadProvenance = z.infer<typeof AnalyzerLeadProvenanceSchema>;

/** Truncated-digest length: 16 hex chars — ample for per-file span identity. */
const SNIPPET_HASH_LENGTH = 16;

/**
 * Normalize a flagged source span so the hash survives cosmetic movement:
 * per-line trim, internal whitespace runs collapsed to one space, empty lines
 * dropped. A whitespace-only reformat therefore re-hashes identically (the
 * lead's identity is its content, not its layout), while any real edit to the
 * flagged code changes the digest.
 */
export function normalizeAnalyzerSnippet(snippet: string): string {
  return snippet
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter((line) => line.length > 0)
    .join("\n");
}

/**
 * Hash the 1-based inclusive line span `[lineStart, lineEnd ?? lineStart]` of
 * `source` after {@link normalizeAnalyzerSnippet}. Returns undefined when the
 * span is empty after normalization or lies wholly outside the file — callers
 * then attach no provenance rather than a meaningless digest.
 */
export function hashAnalyzerSnippet(
  source: string,
  lineStart: number,
  lineEnd?: number,
): string | undefined {
  if (!Number.isInteger(lineStart) || lineStart < 1) return undefined;
  const last = lineEnd !== undefined && Number.isInteger(lineEnd) && lineEnd >= lineStart
    ? lineEnd
    : lineStart;
  const lines = source.split(/\r?\n/).slice(lineStart - 1, last);
  if (lines.length === 0) return undefined;
  const normalized = normalizeAnalyzerSnippet(lines.join("\n"));
  if (normalized.length === 0) return undefined;
  return hashContent(normalized, { length: SNIPPET_HASH_LENGTH });
}

/**
 * Stable string key of a provenance identity, for set membership at the
 * close-verify draw (`analyzer_id`+`rule`+`path`+`snippet_hash`; `rule` folds
 * in as "" when absent so the same lead keys identically on both sides).
 */
export function analyzerProvenanceKey(p: AnalyzerLeadProvenance): string {
  return [p.analyzer_id, p.rule ?? "", p.path, p.snippet_hash].join("\0");
}
