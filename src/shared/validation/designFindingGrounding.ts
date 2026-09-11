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
 *
 * Single source for both orchestrators (lives in shared next to the quote-and-
 * verify primitives) so neither orchestrator forks the design-grounding logic and
 * there is no remediate→audit cross-area import.
 */
import type { Finding, FindingGrounding } from "../types/finding.js";
// Repo-relative path normalizer + bare-basename resolver are single-sourced in
// shared (drift-plan P7 / INV-B3-2).
import {
  normalizeRepoPath,
  resolveBasenameToTrackedPath,
} from "./findingGrounding.js";

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
  // A cited path grounds by exact membership (full repo-relative or dotfile-dir
  // path — INV-B3-1) OR, for a bare basename, by uniquely resolving to one
  // tracked full path (INV-B3-2). An ambiguous (>1-match) basename does not
  // ground — the resolver returns undefined there.
  const real = cited.filter(
    (p) =>
      knownPaths.has(p) ||
      resolveBasenameToTrackedPath(p, knownPaths) !== undefined,
  );
  if (real.length === 0) {
    return {
      status: "ungrounded",
      reason: `cited component(s) not found in the repository: ${cited.slice(0, 3).join(", ")}`,
    };
  }
  // construction-site: FindingGrounding
  return { status: "grounded" };
}

/**
 * Annotate each design finding with its lane and its grounding verdict, and
 * remove the one tool-owned verdict a submission can forge.
 *
 * The LANE stamp is unconditional and comes first: every finding reaching this
 * function arrived on a design-review lane (that is what the call sites are —
 * the contract, conceptual and legacy design-review ingests), and downstream
 * synthesis reads it to decide whether the finding was ever ASKED for an
 * `evidence` array before applying a bar that tests one. Folding the stamp in
 * here rather than exposing a second function is deliberate — the lane is
 * provenance the ingest owns, and a separate call is a call a future ingest site
 * can forget.
 *
 * The `lead_lineage` STRIP is unconditional for the same reason, and it is the
 * same "a separate call is a call someone forgets" argument: these lanes ingest
 * host-authored findings, and the array door (`consumeArraySubmission`) checks
 * only that the value IS an array — it does not parse through a schema that
 * omits the tool-owned verdicts the way the per-file worker contract does. So
 * without a strip here, a submission carrying `{producer: "host-forged", …}`
 * lands verbatim in `contract_findings` / `conceptual_findings` and thereafter
 * reads as a generation-bound deterministic lead: a claim wearing provenance it
 * never had. Dropping the field leaves the row what it actually is — an
 * unlineaged host finding, which the review prompt already calls out by count.
 *
 * A host that legitimately re-emits a lead is unaffected in substance: the
 * provenance it could not have verified is exactly the part the tool refuses to
 * take on its word, and its own `evidence` and `affected_files` ride through
 * unchanged.
 *
 * The GROUNDING verdict is conditional. When no repo manifest is available the
 * findings cannot be grounded against a known file set, so they are returned
 * lane-stamped but ungrounded — better than false-quarantining everything on a
 * missing input, and better than losing the provenance that does not depend on
 * it.
 */
export function groundDesignFindings(
  findings: Finding[],
  repoManifest: { files?: Array<{ path: string }> } | undefined,
): Finding[] {
  const marked = findings.map(({ lead_lineage: _forged, ...finding }) => ({
    ...finding,
    evidence_lane: "design-review-lane" as const,
  }));
  const files = repoManifest?.files ?? [];
  if (files.length === 0) return marked;
  const known = new Set(files.map((f) => normalizeRepoPath(f.path)));
  return marked.map((finding) => ({
    ...finding,
    grounding: groundDesignFinding(finding, known),
  }));
}
