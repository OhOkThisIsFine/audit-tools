// sites-pinned: tests/audit/merge-findings-dedup.test.ts
import type { AuditResult, Finding } from "../types.js";
import type { DesignAssessment } from "../types/designAssessment.js";
import type { StructureDecomposition } from "../types/structureDecomposition.js";
import type { CharterRegister } from "../types/charterRegister.js";
import type { SystemicChallengeRegister } from "../types/systemicChallenge.js";
import type { ExternalAnalyzerResults } from "audit-tools/shared";
import type { RuntimeValidationReport } from "../types/runtimeValidation.js";
import { severityRank, confidenceRank } from "audit-tools/shared";
import {
  crossLensDedupe,
  sameLensDedupe,
  upsertFindingByIdentity,
  compareCodeUnits,
  findingReEmissionKey,
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
  const allDesignFindings = [
    ...(designAssessment?.findings ?? []),
    // The two review passes, each carrying its own findings. A pre-split
    // artifact's combined `review_findings` is deliberately NOT folded in: it
    // records a pass the current vocabulary does not have, and the invalidation
    // at load (`orchestrator/state.ts`) re-asks for both real passes — so the
    // merged report can never carry a verdict whose current-pass review never
    // ran.
    ...(designAssessment?.contract_findings ?? []),
    ...(designAssessment?.conceptual_findings ?? []),
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

  // Callers pass the supersession-resolved ledger (`selectCurrentResults`) so a
  // re-dispatched result's fresh findings have already replaced the stale base
  // record they superseded (O3). mergeFindings stays a pure merge over whatever
  // result set it is given.
  const resultFindings = results.flatMap((result) => result.findings);

  // A deterministic producer is the ONLY thing that may stamp `lead_lineage`, and
  // every host-authored door strips or refuses the field by name — so presence of
  // the stamp is the boundary between a generation-bound LEAD and a semantic
  // finding, not whichever array a row happened to arrive in.
  const leads: Finding[] = [];
  const semantic: Finding[] = [];
  for (const finding of [...allDesignFindings, ...resultFindings]) {
    (finding.lead_lineage ? leads : semantic).push(finding);
  }

  // A lead is promoted to the final report only when a semantic finding re-raises
  // its canonical identity (the file-independent re-emission key: normalized
  // lens|category|title). An unconfirmed lead stays in its analysis artifact
  // (`design_assessment.json` / `structure_decomposition.json`) — it is never
  // deleted, only not admitted here.
  const confirmedKeys = new Set(
    semantic.map((finding) => findingReEmissionKey(finding)),
  );
  const admittedLeads = leads.filter((lead) =>
    confirmedKeys.has(findingReEmissionKey(lead)),
  );

  const merged = new Map<string, Finding>();
  // Leads upsert FIRST so a confirmed lead is the survivor of its identity key
  // and keeps its `lead_lineage`; the confirming semantic finding then unions its
  // evidence and affected_files into it (`upsertFindingByIdentity` never touches
  // `lead_lineage`, so the tool stamp survives the merge rather than being
  // replaced by the host-authored row).
  for (const lead of admittedLeads) {
    upsertFindingByIdentity(merged, lead);
  }
  for (const finding of semantic) {
    upsertFindingByIdentity(merged, finding);
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
  // short-circuit; the mergeMap is unused (a human reads the report).
  return crossLensDedupe(dedupedSameLens, {
    categoryGate: "soft",
    exactIdentityShortCircuit: false,
    survivorMutation: "mutate",
    mergeGrounding: true,
    sortAffectedFiles: true,
    // Packet-scoped ids collide across units by construction here; global ids
    // are minted downstream at assignStableFindingIds.
    idDiscipline: "local",
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
    return compareCodeUnits(a.title, b.title);
  });
}
