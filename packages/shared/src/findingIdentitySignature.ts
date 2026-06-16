/**
 * The single finding-identity-signature authority for the whole pipeline
 * (drift-plan R2). Before this module, three independent "is this the same
 * finding?" rules existed: audit's `reporting/findingIdentity.ts` (this 3-tier
 * ladder), remediate's `dedup/crossLensDedup.ts` (path + category + title
 * Jaccard + path overlap), and remediate's `coverage/findingLedger.ts` (bare id
 * string). They disagreed, so a finding could be one identity to the auditor and
 * another to the remediator. This module owns the deterministic signature; the
 * auditor re-keys findings off it, the remediator's dedup uses it as the exact
 * -match collapse (its Jaccard/overlap heuristic is a fuzzy layer on top), and a
 * finding's stable id (the coverage-ledger denominator key) is derived from it.
 *
 * It is a pure module — no IO, no hashing, no model identity — so the same
 * semantic finding always yields the same signature across passes, runs, and
 * both orchestrators.
 */

import type { Finding, FindingLocation } from "./types/finding.js";

/**
 * The stable semantic fields a finding's identity may be derived from.
 *
 * Volatile, content-derived values — unit ids, line numbers, pass
 * ordinals/pass_id, timestamps — are deliberately absent from this shape so
 * they can never reach the signature at any ladder tier. The raw title is
 * accepted but only ever influences identity after aggressive normalization
 * (tier 3), and only when no stronger tier applies.
 */
export interface FindingIdentityFields {
  /** Repo-relative primary file path of the structural anchor, if any. */
  anchor_path?: string;
  /** Symbol/scope identifier at the anchor (the anchor's unit/scope). */
  anchor_symbol?: string;
  /** Rule/category identifier. */
  category?: string;
  /** Lens — paired with category at tier 2 (the existing category convention). */
  lens?: string;
  /** Title; aggressively normalized before it can influence identity. */
  title?: string;
}

/** Separator-normalized (always `/`), case-folded, repo-relative path. */
export function normalizeAnchorPath(path: string | undefined): string {
  return (path ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

/**
 * Aggressively normalize a title so volatile content cannot influence
 * identity: case-folded; embedded file paths (with optional `:line[:col]`
 * suffixes) stripped; counts, line numbers, and all other numerals stripped;
 * punctuation collapsed; whitespace collapsed to single spaces.
 */
export function normalizeTitle(title: string | undefined): string {
  return (title ?? "")
    .toLowerCase()
    // File paths, optionally suffixed with :line or :line:col.
    .replace(/[\w.~-]*[\\/][\w.\\/~-]*(:\d+(:\d+)?)?/g, " ")
    // Counts, line numbers, and any other numerals.
    .replace(/\d+/g, " ")
    // Collapse punctuation, then whitespace.
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The single, explicit, deterministic fallback ladder for finding identity.
 * The same semantic finding always yields the same signature across passes
 * and runs; the ladder consults stable semantic fields only:
 *
 * 1. **Structural anchor** — the repo-relative primary file path
 *    (separator-normalized, case-folded) together with the anchor's
 *    symbol/scope. The unit/scope is part of the signature, so two findings at
 *    the same path but different scopes get distinct signatures.
 * 2. **Rule/category** — when no structural anchor is available, the
 *    rule/category identifier paired with the lens (the existing category
 *    convention).
 * 3. **Normalized title** — when neither anchor nor rule/category exists, an
 *    aggressively normalized title (see {@link normalizeTitle}).
 *
 * Content-derived unit ids, line numbers, pass ordinals/pass_id, timestamps,
 * and raw (unnormalized) titles are never part of the signature: they do not
 * appear in {@link FindingIdentityFields}, so no tier can hash them.
 *
 * The signature is also independent of a finding's merged affected-file
 * *list*: at most the single structural anchor (primary path + scope) can
 * contribute, never the full file set, so a finding's identity stays put as
 * additional re-emitted files are unioned into it across passes and runs.
 */
export function findingIdentitySignature(
  fields: FindingIdentityFields,
): string {
  // Tier 1: structural anchor (path + symbol/scope).
  const anchorPath = normalizeAnchorPath(fields.anchor_path);
  if (anchorPath !== "") {
    const scope = (fields.anchor_symbol ?? "").trim();
    return `anchor|${anchorPath}|${scope}`;
  }

  // Tier 2: rule/category (+ lens, the existing category convention).
  const category = (fields.category ?? "").trim().toLowerCase();
  if (category !== "") {
    const lens = (fields.lens ?? "").trim().toLowerCase();
    return `rule|${lens}|${category}`;
  }

  // Tier 3: aggressively normalized title.
  return `title|${normalizeTitle(fields.title)}`;
}

/** Extract only the stable identity-bearing fields from a {@link Finding}. */
export function findingIdentityFields(finding: Finding): FindingIdentityFields {
  const anchor: FindingLocation | undefined = finding.affected_files[0];
  return {
    anchor_path: anchor?.path,
    anchor_symbol: anchor?.symbol,
    category: finding.category,
    lens: finding.lens,
    title: finding.title,
  };
}

/**
 * The deterministic identity signature of a {@link Finding} — the exact-match
 * key consumers use to decide whether two findings are the same defect. Shared
 * by the auditor's id re-keying, the remediator's cross-lens dedup (exact-match
 * layer), and the coverage ledger.
 */
export function findingIdentityKey(finding: Finding): string {
  return findingIdentitySignature(findingIdentityFields(finding));
}
