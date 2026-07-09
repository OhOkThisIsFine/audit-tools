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

function wordSet(text: string): Set<string> {
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
  const sa = wordSet(a);
  const sb = wordSet(b);
  let intersection = 0;
  for (const w of sa) {
    if (sb.has(w)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Jaccard overlap (0..1) of two findings' affected-file path sets. */
export function filePathOverlap(a: Finding, b: Finding): number {
  const setA = new Set(a.affected_files.map((f) => f.path));
  const setB = new Set(b.affected_files.map((f) => f.path));
  let intersection = 0;
  for (const path of setA) {
    if (setB.has(path)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** A finding's primary (first-listed) affected-file path, or "" when none. */
export function primaryPath(finding: Finding): string {
  return finding.affected_files[0]?.path ?? "";
}
