/**
 * Deterministic grounding for LLM-extracted findings (free-form input only).
 *
 * Extracted findings cite `affected_files[].path`s and evidence the model wrote
 * from prose; nothing else checks them against the repository before a worker
 * is dispatched. This module partitions cited paths into real vs. phantom
 * (WS1) and classifies evidence as grounded/ungrounded by parsing `path[:line]`
 * citations (WS2). It must run BEFORE any LLM repair/critique pass and must
 * never touch the structured audit-findings.json fast path — auditor findings
 * are already grounded, and dropping a since-deleted path there is the
 * integrity check's replan concern, not a grounding concern.
 */
import { existsSync } from "node:fs";
import {
  checkCitations,
  enumerateTrackedFilePaths,
  extractCitationRefs,
  isBareBasename,
  resolveBasenameToTrackedPath,
} from "audit-tools/shared";
import type { Finding } from "../state/types.js";
import { resolveAffectedPath } from "../utils/fileIntegrity.js";

// ── Affected-file grounding (WS1) ─────────────────────────────────────────────

export interface AffectedFileGrounding {
  /** Phantom (non-existent) paths stripped from findings, keyed by finding id. */
  phantomPathsByFinding: Map<string, string[]>;
  /**
   * IDs of findings that cited at least one path and were left with zero real
   * paths after stripping. Candidates for one bounded repair attempt, then drop.
   * Findings that never cited a path are NOT here — empty `affected_files` is a
   * legitimate "discover during documentation" state for extracted findings.
   */
  zeroRealPathFindingIds: string[];
}

/**
 * A cited path is real (grounded) when it resolves on disk relative to `root`
 * (a full repo-relative or dotfile-dir path — the join resolves it directly), OR
 * when it is a bare basename that uniquely resolves to one tracked path in
 * `corpus`. The basename branch (INV-B3-3) fixes the false-negative where a bare
 * `advance.ts` for a NESTED tracked file (`src/audit/orchestrator/advance.ts`)
 * failed `existsSync(root/advance.ts)` and was wrongly stripped as phantom. This
 * only ADDS true-positives; a genuinely absent path / non-unique basename still
 * fails (INV-B3-6, monotonic widening).
 */
function citedPathIsReal(
  root: string,
  path: string,
  corpus: ReadonlySet<string>,
): boolean {
  if (existsSync(resolveAffectedPath(root, path))) return true;
  if (isBareBasename(path)) {
    return resolveBasenameToTrackedPath(path, corpus) !== undefined;
  }
  return false;
}

/**
 * Strip phantom `affected_files` paths from extracted findings in place.
 * A path is real when it resolves (relative to `root`) to an existing file or
 * directory, or when a bare basename uniquely resolves to one tracked path.
 * Returns what was stripped so the caller can repair, drop, and record — nothing
 * is silently lost.
 */
export function groundAffectedFiles(
  root: string,
  findings: Finding[],
  corpus: ReadonlySet<string>,
): AffectedFileGrounding {
  const phantomPathsByFinding = new Map<string, string[]>();
  const zeroRealPathFindingIds: string[] = [];

  for (const finding of findings) {
    const cited = finding.affected_files ?? [];
    if (cited.length === 0) continue;
    const phantoms = cited
      .map((af) => af.path)
      .filter((path) => !citedPathIsReal(root, path, corpus));
    if (phantoms.length === 0) continue;

    phantomPathsByFinding.set(finding.id, phantoms);
    const phantomSet = new Set(phantoms);
    finding.affected_files = cited.filter((af) => !phantomSet.has(af.path));
    if (finding.affected_files.length === 0) {
      zeroRealPathFindingIds.push(finding.id);
    }
  }

  return { phantomPathsByFinding, zeroRealPathFindingIds };
}

// ── Evidence grounding (WS2) ──────────────────────────────────────────────────

/**
 * True when the evidence string cites at least one real repo path; a cited
 * line number must also exist in the file (a `path:9999` citation into a
 * 40-line file is not grounded), and a cited RANGE must exist at BOTH ends (a
 * `path:2-9999` citation into a 3-line file is not grounded either — the start
 * being real never certifies the end). A bare basename resolves against the
 * tracked corpus (INV-B3-3); `corpus` is REQUIRED — the enumeration is async
 * (INV-SSF), so a caller enumerates once per pass with
 * `enumerateTrackedFilePaths` and threads the set through this sync predicate.
 *
 * ONE CORE, TWO DRAWS: this is the existential DRAW over the shared citation
 * core (`audit-tools/shared` → `checkCitations`) — the same core the audit draw
 * uses per-citation over a charter register's provenance. The grammar, the path
 * resolution and the line counting live there in one copy, so the two draws
 * cannot disagree about what a citation is or how long a file is.
 */
export function evidenceCitesRealPath(
  root: string,
  evidence: string,
  corpus: ReadonlySet<string>,
): boolean {
  const refs = extractCitationRefs(evidence);
  if (refs.length === 0) return false;
  const { checks } = checkCitations({
    root,
    corpus,
    citations: refs.map((ref) => ({ owner_id: "evidence", ref })),
  });
  return checks.some((check) => check.verdict === "ok");
}

export interface EvidenceGrounding {
  /** IDs of findings with no evidence entry citing a real repo path. */
  ungroundedFindingIds: string[];
}

/**
 * Mark each extracted finding `evidence_grounded` and downgrade ungrounded
 * findings to low confidence in place. Ungrounded findings are flagged for the
 * downstream judge/risk review — never dropped purely for being ungrounded,
 * since prose findings can be legitimately high-level.
 */
export function groundEvidence(
  root: string,
  findings: Finding[],
  corpus: ReadonlySet<string>,
): EvidenceGrounding {
  const ungroundedFindingIds: string[] = [];
  for (const finding of findings) {
    const grounded = (finding.evidence ?? []).some((entry) =>
      evidenceCitesRealPath(root, entry, corpus),
    );
    finding.evidence_grounded = grounded;
    if (!grounded) {
      ungroundedFindingIds.push(finding.id);
      finding.confidence = "low";
    }
  }
  return { ungroundedFindingIds };
}

// ── Combined pass ─────────────────────────────────────────────────────────────

export interface ExtractedFindingGrounding {
  /** Findings kept after grounding (phantom paths stripped, evidence marked). */
  findings: Finding[];
  /** Findings dropped because every cited path was phantom (post-repair). */
  dropped: { finding: Finding; phantomPaths: string[] }[];
  /** Phantom paths stripped from kept findings, keyed by finding id. */
  phantomPathsByFinding: Map<string, string[]>;
  /** IDs of kept findings whose evidence has no real-path citation. */
  ungroundedFindingIds: string[];
}

export interface GroundExtractedFindingsOptions {
  root: string;
  /**
   * One bounded repair attempt for findings whose cited paths were all
   * phantom: given the findings and their phantom paths, return corrected
   * repo-relative paths per finding id (omit a finding to withdraw it).
   * Mirrors the triage-phase retry-cap discipline — exactly one attempt.
   */
  repairZeroPathFindings?: (
    requests: { finding: Finding; phantomPaths: string[] }[],
  ) => Promise<Map<string, string[]>>;
  /**
   * Set false for findings grounded by construction rather than by path
   * citation — contract-pipeline-promoted findings carry obligation-reference
   * evidence and must not be blanket-downgraded for lacking `path:line`.
   * Path grounding still runs. Defaults to true.
   */
  evidenceGrounding?: boolean;
}

/**
 * Full deterministic grounding pass for LLM-extracted findings: strip phantom
 * paths, give all-phantom findings one bounded repair attempt, drop the
 * unrepaired, and classify evidence. Mutates kept findings in place and
 * returns the records the coverage ledger needs.
 */
export async function groundExtractedFindings(
  findings: Finding[],
  options: GroundExtractedFindingsOptions,
): Promise<ExtractedFindingGrounding> {
  const { root } = options;
  // ONE async enumeration per pass (INV-SSF); every predicate below is a sync
  // draw over this corpus.
  const corpus = await enumerateTrackedFilePaths(root);
  const { phantomPathsByFinding, zeroRealPathFindingIds } = groundAffectedFiles(
    root,
    findings,
    corpus,
  );

  const dropped: { finding: Finding; phantomPaths: string[] }[] = [];
  if (zeroRealPathFindingIds.length > 0) {
    const zeroPathSet = new Set(zeroRealPathFindingIds);
    const requests = findings
      .filter((finding) => zeroPathSet.has(finding.id))
      .map((finding) => ({
        finding,
        phantomPaths: phantomPathsByFinding.get(finding.id) ?? [],
      }));

    let repaired = new Map<string, string[]>();
    if (options.repairZeroPathFindings) {
      try {
        repaired = await options.repairZeroPathFindings(requests);
      } catch (error) {
        console.warn(
          `Grounding: bounded path-repair attempt failed (${error instanceof Error ? error.message : String(error)}); dropping unrepaired findings.`,
        );
      }
    }

    for (const request of requests) {
      // Repair output is itself untrusted LLM output — re-ground it.
      const candidatePaths = repaired.get(request.finding.id) ?? [];
      const realPaths = [...new Set(candidatePaths)].filter((path) =>
        existsSync(resolveAffectedPath(root, path)),
      );
      if (realPaths.length > 0) {
        request.finding.affected_files = realPaths.map((path) => ({ path }));
      } else {
        dropped.push(request);
      }
    }
  }

  const droppedIds = new Set(dropped.map((entry) => entry.finding.id));
  const kept = findings.filter((finding) => !droppedIds.has(finding.id));
  const { ungroundedFindingIds } =
    options.evidenceGrounding === false
      ? { ungroundedFindingIds: [] }
      : groundEvidence(root, kept, corpus);

  return {
    findings: kept,
    dropped,
    phantomPathsByFinding,
    ungroundedFindingIds,
  };
}
