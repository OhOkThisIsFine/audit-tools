/**
 * Grounding for design-review findings (S8 = S7 applied to the reviewer).
 *
 * Conceptual/contract findings are architectural — they rarely cite a single
 * quotable line, so quote-and-verify (tier-1) does not fit. But they must still
 * point at something real: every finding has to cite at least one **component**
 * (an `affected_files` path that exists in the repository). A finding that cites
 * no component, or only paths not in the repo, is `ungrounded` — it points at
 * nothing checkable — and is surfaced/quarantined like any other ungrounded
 * finding (the same tier-3 machinery), never silently admitted as confirmed.
 *
 * Before this, design findings were ingested on `Array.isArray()` alone, with no
 * evidence requirement — unlike the schema-gated AuditResult path.
 */
import type { Finding, FindingGrounding } from "audit-tools/shared";
// Repo-relative path normalizer is single-sourced in shared (drift-plan P7).
import { normalizeRepoPath } from "audit-tools/shared";

/**
 * Ground a single design finding against the set of real repository paths. The
 * verdict is the tool's check, never the model's word: a finding survives as
 * `grounded` only if at least one cited `affected_files` path exists in the repo.
 */
export function groundDesignFinding(
  finding: Finding,
  knownPaths: ReadonlySet<string>,
): FindingGrounding {
  const cited = (finding.affected_files ?? [])
    .map((f) => normalizeRepoPath(f?.path ?? ""))
    .filter((p) => p.length > 0);
  if (cited.length === 0) {
    return {
      status: "ungrounded",
      reason: "cites no component (affected_files is empty)",
    };
  }
  const real = cited.filter((p) => knownPaths.has(p));
  if (real.length === 0) {
    return {
      status: "ungrounded",
      reason: `cited component(s) not found in the repository: ${cited.slice(0, 3).join(", ")}`,
    };
  }
  return { status: "grounded" };
}

/**
 * Annotate each design finding with its grounding verdict. When no repo manifest
 * is available the findings cannot be grounded against a known file set, so they
 * are returned unchanged — better than false-quarantining everything on a missing
 * input.
 */
export function groundDesignFindings(
  findings: Finding[],
  repoManifest: { files?: Array<{ path: string }> } | undefined,
): Finding[] {
  const files = repoManifest?.files ?? [];
  if (files.length === 0) return findings;
  const known = new Set(files.map((f) => normalizeRepoPath(f.path)));
  return findings.map((finding) => ({
    ...finding,
    grounding: groundDesignFinding(finding, known),
  }));
}
