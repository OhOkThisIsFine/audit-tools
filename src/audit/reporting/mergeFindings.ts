import type { AuditResult, Finding } from "../types.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import type { CharterRegister } from "../types/charterRegister.js";
import type { SystemicChallengeRegister } from "../types/systemicChallenge.js";
import type { ExternalAnalyzerResults } from "../types/externalAnalyzer.js";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import { severityRank, confidenceRank } from "./findingRanks.js";
import {
  crossLensDedupe,
  sameLensDedupe,
  upsertFindingByIdentity,
} from "audit-tools/shared";

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
    // tag — upsertFindingByIdentity keys on the finding's own lens, so a systemic improvement is
    // routed to its real lens rather than collapsed into an architecture bucket.
    ...(systemicChallenge?.findings ?? []),
  ];
  for (const finding of allDesignFindings) {
    upsertFindingByIdentity(merged, finding);
  }

  // Callers pass the supersession-resolved ledger (`selectCurrentResults`) so a
  // re-dispatched result's fresh findings have already replaced the stale base
  // record they superseded (O3). mergeFindings stays a pure merge over whatever
  // result set it is given.
  for (const result of results) {
    for (const finding of result.findings) {
      upsertFindingByIdentity(merged, finding);
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

  const dedupedSameLens = sameLensDedupe([...merged.values()]);
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
