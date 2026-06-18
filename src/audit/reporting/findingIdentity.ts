import {
  hashContent,
  mintUniqueId,
  findingIdentityKey,
  findingIdentitySignature,
} from "audit-tools/shared";
import type { FindingIdentityFields } from "audit-tools/shared";
import type { Finding } from "../types.js";

// The finding-identity-signature authority now lives in audit-tools/shared
// (drift-plan R2 — one rule for "is this the same finding?" across the auditor,
// the remediator's dedup, and the coverage ledger). This module keeps only the
// audit-specific concern: turning that signature into the stable, lens-prefixed,
// content-addressed id written to `audit-findings.json`. The signature itself
// (and `FindingIdentityFields`) is re-exported so existing importers and tests
// keep their import site, but there is exactly one implementation.
export { findingIdentitySignature };
export type { FindingIdentityFields };

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
 * from the shared deterministic fallback ladder in `findingIdentitySignature` —
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
    const hash = hashContent(findingIdentityKey(finding), { length: 8 });
    const id = mintUniqueId(used, `${prefix}-${hash}`);
    const reKeyed: Finding = { ...finding, id };
    delete reKeyed.related_findings;
    return reKeyed;
  });
}
