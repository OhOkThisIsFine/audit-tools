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
import { existsSync, readFileSync, statSync } from "node:fs";
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
 * Strip phantom `affected_files` paths from extracted findings in place.
 * A path is real when it resolves (relative to `root`) to an existing file or
 * directory. Returns what was stripped so the caller can repair, drop, and
 * record — nothing is silently lost.
 */
export function groundAffectedFiles(
  root: string,
  findings: Finding[],
): AffectedFileGrounding {
  const phantomPathsByFinding = new Map<string, string[]>();
  const zeroRealPathFindingIds: string[] = [];

  for (const finding of findings) {
    const cited = finding.affected_files ?? [];
    if (cited.length === 0) continue;
    const phantoms = cited
      .map((af) => af.path)
      .filter((path) => !existsSync(resolveAffectedPath(root, path)));
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
 * Candidate `path[:line]` citations inside an evidence string. A token must
 * look like a path (contains a separator or a dot-extension) to be considered;
 * bare prose words never match.
 */
const EVIDENCE_PATH_TOKEN_RE =
  /(?<path>[A-Za-z0-9_@.-]*[/\\][A-Za-z0-9_@./\\-]+|[A-Za-z0-9_@-]+\.[A-Za-z0-9_-]+)(?::(?<line>\d+))?/g;

function fileLineCount(absolutePath: string): number {
  const content = readFileSync(absolutePath, "utf8");
  if (content.length === 0) return 0;
  return content.split("\n").length;
}

/**
 * True when the evidence string cites at least one real repo path; a cited
 * line number must also exist in the file (a `path:9999` citation into a
 * 40-line file is not grounded).
 */
export function evidenceCitesRealPath(root: string, evidence: string): boolean {
  for (const match of evidence.matchAll(EVIDENCE_PATH_TOKEN_RE)) {
    const citedPath = match.groups?.path;
    if (!citedPath) continue;
    const absolute = resolveAffectedPath(root, citedPath.trim());
    if (!existsSync(absolute)) continue;

    const line = match.groups?.line;
    if (line === undefined) return true;
    try {
      if (!statSync(absolute).isFile()) continue;
      if (Number(line) >= 1 && Number(line) <= fileLineCount(absolute)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
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
): EvidenceGrounding {
  const ungroundedFindingIds: string[] = [];
  for (const finding of findings) {
    const grounded = (finding.evidence ?? []).some((entry) =>
      evidenceCitesRealPath(root, entry),
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
  const { phantomPathsByFinding, zeroRealPathFindingIds } = groundAffectedFiles(
    root,
    findings,
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
      : groundEvidence(root, kept);

  return {
    findings: kept,
    dropped,
    phantomPathsByFinding,
    ungroundedFindingIds,
  };
}
