import type { AuditResult, Finding } from "../types.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import type { CharterRegister } from "../types/charterRegister.js";
import type { SystemicChallengeRegister } from "../types/systemicChallenge.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import { severityRank, confidenceRank } from "./findingRanks.js";
import {
  wordJaccard,
  filePathOverlap,
  primaryPath,
  crossLensDedupe,
  absorbFinding,
  mergeGrounding,
  mergeAffectedFiles,
} from "audit-tools/shared";

function normalizeText(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
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
        absorbFinding(survivor, absorbed, { mergeGrounding: true, sortAffectedFiles: true });
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

  mergeAffectedFiles(existing, finding, true);
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
  structureDecomposition?: StructureDecomposition,
  charterRegister?: CharterRegister,
  systemicChallenge?: SystemicChallengeRegister,
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
    // Phase B deterministic non-co-localization leads (structure layer).
    ...(structureDecomposition?.findings ?? []),
    // Phase C routed charter-delta leads (charter layer).
    ...(charterRegister?.findings ?? []),
    // Phase E second-order-adversary improvement leads (systemic layer). These carry
    // their TRUE lens (tests/performance/operability/…), NOT a hardcoded architecture
    // tag — upsertFinding keys on the finding's own lens, so a systemic improvement is
    // routed to its real lens rather than collapsed into an architecture bucket.
    ...(systemicChallenge?.findings ?? []),
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
  // Audit's DRAW of the shared cross-lens core: read-only report policy — mutate
  // survivors in place, grounding-precedence merge, sort files, and a SOFT category
  // gate (merge cross-category at a higher title threshold). No exact-identity
  // short-circuit / no break; the mergeMap is unused (a human reads the report).
  return crossLensDedupe(dedupedSameLens, {
    categoryGate: "soft",
    exactIdentityShortCircuit: false,
    survivorMutation: "mutate",
    mergeGrounding: true,
    sortAffectedFiles: true,
    breakOnAbsorbedSurvivor: false,
  }).findings.sort((a, b) => {
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
