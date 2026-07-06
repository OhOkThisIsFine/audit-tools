import type { AuditResult, Finding } from "../types.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import { severityRank, confidenceRank } from "./findingRanks.js";

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function wordJaccard(a: string, b: string): number {
  const sa = wordSet(a);
  const sb = wordSet(b);
  let intersection = 0;
  for (const w of sa) {
    if (sb.has(w)) intersection++;
  }
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function filePathOverlap(a: Finding, b: Finding): number {
  const setA = new Set(a.affected_files.map((f) => f.path));
  const setB = new Set(b.affected_files.map((f) => f.path));
  let intersection = 0;
  for (const path of setA) {
    if (setB.has(path)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function primaryPath(finding: Finding): string {
  return finding.affected_files[0]?.path ?? "";
}

/**
 * File-independent finding identity. Re-emissions of the same logical finding
 * (exact normalized lens + category + title) across files, units, and passes
 * share one key, so the exact-key merge collapses them into a single finding
 * whose affected_files / evidence are the union of every re-emission.
 *
 * Cross-file merging happens ONLY on this exact equality — the fuzzy
 * (Jaccard-title) dedup passes below stay grouped by primary path, which is
 * what guarantees that distinct problems in different units never collapse
 * on mere similarity.
 */
function findingKey(finding: Finding): string {
  return [
    normalizeText(finding.lens),
    normalizeText(finding.category),
    normalizeText(finding.title),
  ].join("|");
}

function runtimeSummary(report?: RuntimeValidationReport): string[] {
  if (!report) {
    return [];
  }

  return report.results
    .filter((result) => result.status !== "pending")
    .map((result) => `${result.task_id}: ${result.status} — ${result.summary}`);
}

function mergeAffectedFiles(existing: Finding, incoming: Finding): void {
  const seen = new Set(
    existing.affected_files.map(
      (f) =>
        `${f.path}:${f.line_start ?? ""}:${f.line_end ?? ""}:${f.symbol ?? ""}`,
    ),
  );
  for (const file of incoming.affected_files) {
    const key = `${file.path}:${file.line_start ?? ""}:${file.line_end ?? ""}:${file.symbol ?? ""}`;
    if (!seen.has(key)) {
      existing.affected_files.push(file);
      seen.add(key);
    }
  }
  existing.affected_files.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || (a.line_start ?? 0) - (b.line_start ?? 0),
  );
}

/**
 * Merge two grounding verdicts by precedence: grounded > refuted > ungrounded >
 * absent (S7). Grounded-wins (a verified span/anchor on ANY pass upgrades the
 * survivor — an ungrounded or absent verdict never downgrades it). A refutation
 * (anchor DISPROOF) outranks ungrounded/absent, so a finding refuted on any pass
 * is quarantined UNLESS another pass grounded it (grounded still wins over
 * refuted — B4: "refuted only excludes when nothing grounded it"). Without the
 * grounded-wins rule, merging a same-identity re-emission that carried no matching
 * quote into a verified survivor would falsely quarantine a finding that DID
 * re-verify on another pass.
 */
function mergeGrounding(
  existing: Finding["grounding"],
  incoming: Finding["grounding"],
): Finding["grounding"] {
  const rank = (g: Finding["grounding"]): number =>
    g?.status === "grounded" ? 3 : g?.status === "refuted" ? 2 : g?.status === "ungrounded" ? 1 : 0;
  const winner = rank(incoming) > rank(existing) ? incoming : existing;
  // Normalize a grounded winner to the bare verdict (grounded carries no reason),
  // preserving the prior contract; refuted/ungrounded keep their reason.
  return winner?.status === "grounded" ? { status: "grounded" } : winner;
}

function absorbFinding(survivor: Finding, absorbed: Finding): void {
  mergeAffectedFiles(survivor, absorbed);
  survivor.evidence = [
    ...new Set([
      ...(survivor.evidence ?? []),
      ...(absorbed.evidence ?? []),
    ]),
  ];
  survivor.systemic = Boolean(survivor.systemic || absorbed.systemic);
  survivor.grounding = mergeGrounding(survivor.grounding, absorbed.grounding);
  if (absorbed.summary.length > survivor.summary.length) {
    survivor.summary = absorbed.summary;
  }
}

function lineRangeOverlaps(a: Finding, b: Finding): boolean {
  const aFile = a.affected_files[0];
  const bFile = b.affected_files[0];
  if (!aFile || !bFile) return false;
  if (aFile.path !== bFile.path) return false;
  const aStart = aFile.line_start ?? 0;
  const aEnd = aFile.line_end ?? aStart;
  const bStart = bFile.line_start ?? 0;
  const bEnd = bFile.line_end ?? bStart;
  if (aEnd === 0 && bEnd === 0) return true;
  return aStart <= bEnd && bStart <= aEnd;
}

function deduplicateSameLens(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = `${normalizeText(finding.lens)}:${primaryPath(finding)}`;
    const group = groups.get(key);
    if (group) {
      group.push(finding);
    } else {
      groups.set(key, [finding]);
    }
  }

  const removed = new Set<Finding>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (removed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (removed.has(group[j])) continue;
        const a = group[i];
        const b = group[j];

        const titleSim = wordJaccard(a.title, b.title);
        const catMatch =
          normalizeText(a.category) === normalizeText(b.category);
        const threshold = catMatch ? 0.35 : 0.45;
        if (titleSim < threshold) continue;
        if (!lineRangeOverlaps(a, b) && filePathOverlap(a, b) < 0.5) continue;

        const aSev = severityRank(a.severity);
        const bSev = severityRank(b.severity);
        const aConf = confidenceRank(a.confidence);
        const bConf = confidenceRank(b.confidence);
        const keepA = aSev > bSev || (aSev === bSev && aConf >= bConf);
        const [survivor, absorbed] = keepA ? [a, b] : [b, a];
        absorbFinding(survivor, absorbed);
        removed.add(absorbed);
      }
    }
  }

  return findings.filter((f) => !removed.has(f));
}

function deduplicateCrossLens(findings: Finding[]): Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = primaryPath(finding);
    const group = groups.get(key);
    if (group) {
      group.push(finding);
    } else {
      groups.set(key, [finding]);
    }
  }

  const removed = new Set<Finding>();

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (removed.has(group[i])) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (removed.has(group[j])) continue;
        const a = group[i];
        const b = group[j];
        if (normalizeText(a.lens) === normalizeText(b.lens)) continue;

        const titleSim = wordJaccard(a.title, b.title);
        const catMatch =
          normalizeText(a.category) === normalizeText(b.category);
        const threshold = catMatch ? 0.4 : 0.5;
        if (titleSim < threshold) continue;
        if (filePathOverlap(a, b) < 0.5) continue;

        const aSev = severityRank(a.severity);
        const bSev = severityRank(b.severity);
        const aConf = confidenceRank(a.confidence);
        const bConf = confidenceRank(b.confidence);
        const keepA =
          aSev > bSev || (aSev === bSev && aConf >= bConf);
        const [survivor, absorbed] = keepA ? [a, b] : [b, a];
        absorbFinding(survivor, absorbed);
        removed.add(absorbed);
      }
    }
  }

  return findings.filter((f) => !removed.has(f));
}

function relevantRuntimeEvidence(
  finding: Finding,
  report?: RuntimeValidationReport,
): string[] {
  if (!report) return [];
  const findingPaths = new Set(finding.affected_files.map((f) => f.path));
  return report.results
    .filter((result) => result.status !== "pending")
    .filter((result) => {
      const taskPaths = result.notes
        ?.flatMap((note) => {
          const match = note.match(/Target paths:\s*(.+)/);
          return match ? match[1].split(",").map((p) => p.trim()) : [];
        }) ?? [];
      if (taskPaths.length === 0) return true;
      return taskPaths.some((p) => findingPaths.has(p));
    })
    .map((result) => `${result.task_id}: ${result.status} — ${result.summary}`);
}

function relevantExternalEvidence(
  finding: Finding,
  results?: ExternalAnalyzerResults[],
): string[] {
  if (!results || results.length === 0) return [];
  const findingPaths = new Set(finding.affected_files.map((f) => f.path));
  return results.flatMap((tool) =>
    tool.results
      .filter((item) => findingPaths.has(item.path))
      .map((item) => `external:${tool.tool}:${item.path}:${item.summary}`),
  );
}

/**
 * Insert a finding into the identity-keyed map, or absorb it into the existing
 * finding with the same identity: affected_files and evidence are unioned,
 * severity / confidence escalate to the maximum rank seen, `systemic` ORs,
 * impact / likelihood backfill, and the longest summary wins.
 */
function upsertFinding(merged: Map<string, Finding>, finding: Finding): void {
  const key = findingKey(finding);
  const existing = merged.get(key);
  if (!existing) {
    merged.set(key, {
      ...finding,
      affected_files: [...finding.affected_files],
      evidence: [...(finding.evidence ?? [])],
    });
    return;
  }

  if (severityRank(finding.severity) > severityRank(existing.severity)) {
    existing.severity = finding.severity;
  }
  if (
    confidenceRank(finding.confidence) > confidenceRank(existing.confidence)
  ) {
    existing.confidence = finding.confidence;
  }
  existing.systemic = Boolean(existing.systemic || finding.systemic);
  existing.grounding = mergeGrounding(existing.grounding, finding.grounding);
  existing.impact = existing.impact ?? finding.impact;
  existing.likelihood = existing.likelihood ?? finding.likelihood;
  existing.summary =
    existing.summary.length >= finding.summary.length
      ? existing.summary
      : finding.summary;

  mergeAffectedFiles(existing, finding);
  existing.evidence = [
    ...new Set([
      ...(existing.evidence ?? []),
      ...(finding.evidence ?? []),
    ]),
  ];
}

export function mergeFindings(
  results: AuditResult[],
  runtimeReport?: RuntimeValidationReport,
  externalAnalyzerResults?: ExternalAnalyzerResults[],
  designAssessment?: DesignAssessment,
): Finding[] {
  const merged = new Map<string, Finding>();

  const allDesignFindings = [
    ...(designAssessment?.findings ?? []),
    // New parallel-pass findings
    ...(designAssessment?.contract_findings ?? []),
    ...(designAssessment?.conceptual_findings ?? []),
    // Backward-compat: legacy single-pass findings
    ...((designAssessment?.contract_findings === undefined && designAssessment?.conceptual_findings === undefined)
      ? (designAssessment?.review_findings ?? [])
      : []),
  ];
  for (const finding of allDesignFindings) {
    upsertFinding(merged, finding);
  }

  // Callers pass the supersession-resolved ledger (`selectCurrentResults`) so a
  // re-dispatched result's fresh findings have already replaced the stale base
  // record they superseded (O3). mergeFindings stays a pure merge over whatever
  // result set it is given.
  for (const result of results) {
    for (const finding of result.findings) {
      upsertFinding(merged, finding);
    }
  }

  for (const finding of merged.values()) {
    const runtimeEv = relevantRuntimeEvidence(finding, runtimeReport);
    const externalEv = relevantExternalEvidence(finding, externalAnalyzerResults);
    if (runtimeEv.length > 0 || externalEv.length > 0) {
      finding.evidence = [
        ...new Set([
          ...(finding.evidence ?? []),
          ...runtimeEv,
          ...externalEv,
        ]),
      ];
    }
  }

  const dedupedSameLens = deduplicateSameLens([...merged.values()]);
  return deduplicateCrossLens(dedupedSameLens).sort((a, b) => {
    const severityDelta = severityRank(b.severity) - severityRank(a.severity);
    if (severityDelta !== 0) return severityDelta;
    const confidenceDelta =
      confidenceRank(b.confidence) - confidenceRank(a.confidence);
    if (confidenceDelta !== 0) return confidenceDelta;
    // Blast radius is priority (conceptual design-review spine): among equal
    // severity+confidence, a higher-blast finding (its fix ripples further up the
    // goal graph) ranks first. Absent blast_radius is treated as 0.
    const blastDelta = (b.blast_radius ?? 0) - (a.blast_radius ?? 0);
    if (blastDelta !== 0) return blastDelta;
    return a.title.localeCompare(b.title);
  });
}
