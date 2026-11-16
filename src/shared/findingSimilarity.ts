// sites-pinned: tests/shared/finding-similarity.test.ts
/**
 * Text/file-similarity primitives for the fuzzy ("similar enough to merge")
 * dedup tier. Byte-identical copies of these four helpers lived in both
 * halves of the pipeline — the auditor's same-lens/cross-lens merge passes
 * (src/audit/reporting/mergeFindings.ts) and the remediator's cross-lens
 * dedup (src/remediate/dedup/crossLensDedup.ts) — sitting right alongside
 * the severityRank/confidenceRank/findingIdentityKey imports both already
 * pulled from `audit-tools/shared`. Single-sourced here so the two fuzzy
 * layers can never silently drift on what "similar enough" means.
 *
 * Deliberately separate from findingIdentitySignature.ts: that module owns
 * the deterministic EXACT-match identity ladder; this one is the fuzzy layer
 * consulted only when the exact-match signature does not already collapse
 * two findings.
 */

import type { Finding } from "./types/finding.js";

/**
 * The content words of a text: whitespace-tokenized, case-folded,
 * punctuation-stripped. Exported as well as used by {@link wordJaccard} because
 * a caller comparing two wordings needs the SET, not only the overlap ratio —
 * `findingRestatesBanked` requires two findings whose titles differ in ANY
 * content word to also agree on a named anchor, which no ratio can express.
 */
export function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

/**
 * Jaccard similarity (0..1) of the whitespace-tokenized, case-folded,
 * punctuation-stripped word sets of `a` and `b`.
 */
export function wordJaccard(a: string, b: string): number {
  return jaccard(contentWords(a), contentWords(b));
}

/** Jaccard overlap (0..1) of two sets; 0 when both are empty. */
function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Jaccard overlap (0..1) of two findings' affected-file path sets. */
export function filePathOverlap(a: Finding, b: Finding): number {
  return jaccard(
    new Set(a.affected_files.map((f) => f.path)),
    new Set(b.affected_files.map((f) => f.path)),
  );
}

/** A finding's primary (first-listed) affected-file path, or "" when none. */
export function primaryPath(finding: Finding): string {
  return finding.affected_files[0]?.path ?? "";
}
