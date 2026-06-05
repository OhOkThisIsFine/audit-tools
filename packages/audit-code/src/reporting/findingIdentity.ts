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
 * A stable signature of a finding's identity-bearing content. The same logical
 * finding yields the same signature across runs (so its id is reproducible),
 * while two distinct findings — which only coexist after surviving merge and
 * dedup with different content — yield different signatures.
 */
function contentSignature(finding: Finding): string {
  const files = finding.affected_files
    .map(
      (file) =>
        `${file.path}:${file.line_start ?? ""}:${file.line_end ?? ""}:${file.symbol ?? ""}`,
    )
    .sort()
    .join(",");
  return [
    finding.lens.trim().toLowerCase(),
    finding.category.trim().toLowerCase(),
    finding.title.trim().toLowerCase(),
    files,
  ].join("|");
}

/**
 * Re-key finalized findings with globally-unique, content-derived ids at the
 * synthesis boundary.
 *
 * Worker packets assign locally-scoped ids (e.g. `MNT-001`) that collide across
 * packets once merged, which breaks `audit-findings.json` as a machine contract:
 * `buildWorkBlocks` keys its union-find on `id` (so colliding ids fuse unrelated
 * findings into one block), and `work_blocks.finding_ids` / theme `finding_ids` /
 * the remediator's per-finding addressing can no longer resolve a single finding.
 *
 * The id is `<LENS_PREFIX>-<sha256(content)[:8]>`, deterministic and stable so a
 * re-synthesis of the same findings produces the same ids. A vanishingly rare
 * hash collision between two *distinct* findings is broken deterministically with
 * a numeric suffix (findings arrive in mergeFindings()' stable order).
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
      .update(contentSignature(finding))
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
