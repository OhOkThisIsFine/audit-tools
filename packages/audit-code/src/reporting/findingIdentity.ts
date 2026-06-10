import { createHash } from "node:crypto";
import type { Finding } from "../types.js";

// Stable lens -> id prefix. The lens is the canonical addressing axis, so the
// prefix always matches it (no convention drift) and the content hash that
// follows guarantees global uniqueness.
const LENS_ID_PREFIX: Record<string, string> = {
  correctness: "COR",
  architecture: "ARC",
  maintainability: "MNT",
  security: "SEC",
  reliability: "REL",
  performance: "PRF",
  data_integrity: "DAT",
  tests: "TST",
  operability: "OPR",
  config_deployment: "CFG",
  observability: "OBS",
};

/**
 * The stable semantic fields a finding's identity may be derived from.
 *
 * Volatile, content-derived values — unit ids, line numbers, pass
 * ordinals/pass_id, timestamps — are deliberately absent from this shape so
 * they can never reach the hash input at any ladder tier. The raw title is
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
function normalizeAnchorPath(path: string | undefined): string {
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
function normalizeTitle(title: string | undefined): string {
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
 *    symbol/scope. The unit/scope is part of the hashed identity, so two
 *    findings at the same path but different scopes get distinct ids.
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
 * mergeFindings() unions additional re-emitted files into it across passes
 * and runs.
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

/** Extract only the stable identity-bearing fields from a finding. */
function identityFields(finding: Finding): FindingIdentityFields {
  const anchor = finding.affected_files[0];
  return {
    anchor_path: anchor?.path,
    anchor_symbol: anchor?.symbol,
    category: finding.category,
    lens: finding.lens,
    title: finding.title,
  };
}

/**
 * Re-key finalized findings with globally-unique, content-addressed ids at the
 * synthesis boundary.
 *
 * Worker packets assign locally-scoped ids (e.g. `MNT-001`) that collide across
 * packets once merged, which breaks `audit-findings.json` as a machine contract:
 * `buildWorkBlocks` keys its union-find on `id` (so colliding ids fuse unrelated
 * findings into one block), and `work_blocks.finding_ids` / theme `finding_ids` /
 * the remediator's per-finding addressing can no longer resolve a single finding.
 *
 * The id is `<LENS_PREFIX>-<sha256(signature)[:8]>`, where the signature comes
 * from the deterministic fallback ladder in {@link findingIdentitySignature} —
 * stable semantic fields only, so the same semantic finding keeps the same id
 * across passes and re-syntheses even when volatile fields (line numbers, pass
 * ordinals, unit ids, timestamps, title phrasing) drift. By the time findings
 * reach this function, mergeFindings() has already collapsed every re-emission
 * of one file-independent identity (exact normalized lens|category|title) into
 * a single multi-file finding, and the hash never covers the merged file list,
 * so the id also stays stable as a finding's merged file set grows. Distinct
 * findings that share a signature (e.g. two issues anchored at the same
 * path + scope) are disambiguated deterministically with a numeric suffix
 * (findings arrive in mergeFindings()' stable order).
 *
 * `related_findings`, when present, referenced the old colliding ids and cannot
 * be remapped unambiguously, so it is dropped rather than left dangling. (It is
 * unpopulated by every current extractor.)
 */
export function assignStableFindingIds(findings: Finding[]): Finding[] {
  const used = new Set<string>();
  return findings.map((finding) => {
    const prefix = LENS_ID_PREFIX[finding.lens.trim().toLowerCase()] ?? "FND";
    const hash = createHash("sha256")
      .update(findingIdentitySignature(identityFields(finding)))
      .digest("hex")
      .slice(0, 8);
    let id = `${prefix}-${hash}`;
    for (let n = 2; used.has(id); n++) {
      id = `${prefix}-${hash}-${n}`;
    }
    used.add(id);
    const reKeyed: Finding = { ...finding, id };
    delete reKeyed.related_findings;
    return reKeyed;
  });
}
