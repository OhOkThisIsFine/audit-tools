// sites-pinned: tests/remediate/phase-plan.test.ts, tests/remediate/unit-source-outcomes.test.ts
import type { Finding, ExecutionUnit, CoverageLedger, CoverageLedgerEntry } from "../state/types.js";
import { claimsAuditFindingsContract, compareCodeUnits, type AuditFindingsReport } from "audit-tools/shared";

export function isAuditFindingsReport(value: unknown): value is AuditFindingsReport {
  return claimsAuditFindingsContract(value);
}

export function buildCoverageLedger(params: {
  planId: string;
  sourceFindings: Finding[];
  droppedNoEvidence: string[];
  droppedByCheckpoint: string[];
  /** Findings dropped by the grounding pass, with the phantom paths they cited. */
  droppedPhantomPaths?: Map<string, string[]>;
  /** Phantom paths stripped from findings that survived grounding. */
  phantomPathsRemoved?: Map<string, string[]>;
  /**
   * Findings the user declined at the review-approval gate, with the recorded
   * reason. These are IN `sourceFindings` (an approved/declined finding is a
   * filter-pass survivor — folded/dropped findings never reach the gate), so they
   * produce an in-source `declined_by_review` disposition exactly like
   * `droppedByCheckpoint`, and they ARE part of the source reconciliation.
   */
  declinedByReview?: Array<{ finding_id: string; reason: string }>;
  mergeMap: Map<string, string>;
  units: ExecutionUnit[];
}): CoverageLedger {
  const dropped = new Set(params.droppedNoEvidence);
  const byCheckpoint = new Set(params.droppedByCheckpoint);
  const declinedReasons = new Map(
    (params.declinedByReview ?? []).map((d) => [d.finding_id, d.reason] as const),
  );
  const groundingAnnotations = (f: Finding): Partial<CoverageLedgerEntry> => {
    const phantoms = params.phantomPathsRemoved?.get(f.id);
    return {
      ...(phantoms && phantoms.length > 0
        ? { phantom_paths_removed: phantoms }
        : {}),
      ...(f.evidence_grounded !== undefined
        ? { evidence_grounded: f.evidence_grounded }
        : {}),
    };
  };
  const entries: CoverageLedgerEntry[] = [...params.sourceFindings]
    .sort((left, right) => compareCodeUnits(left.id, right.id))
    .map((f): CoverageLedgerEntry => {
      const phantomPaths = params.droppedPhantomPaths?.get(f.id);
      if (phantomPaths) {
        return {
          finding_id: f.id,
          title: f.title,
          disposition: "dropped_phantom_paths",
          rationale:
            "Every cited affected_files path was phantom (does not exist in the repository) and one bounded repair attempt did not produce a real path.",
          phantom_paths_removed: phantomPaths,
        };
      }
      if (dropped.has(f.id)) {
        return {
          finding_id: f.id,
          title: f.title,
          disposition: "dropped_no_evidence",
          rationale: "Finding carried no evidence and was excluded from the plan.",
        };
      }
      const survivor = params.mergeMap.get(f.id);
      if (survivor) {
        return {
          finding_id: f.id,
          title: f.title,
          disposition: "folded_into",
          folded_into: survivor,
          ...groundingAnnotations(f),
        };
      }
      if (byCheckpoint.has(f.id)) {
        return {
          finding_id: f.id,
          title: f.title,
          disposition: "dropped_by_checkpoint",
          rationale:
            "Finding excluded by the intent checkpoint (filter or excluded scope).",
        };
      }
      if (declinedReasons.has(f.id)) {
        return {
          finding_id: f.id,
          title: f.title,
          disposition: "declined_by_review",
          rationale:
            declinedReasons.get(f.id) ??
            "Disapproved by the user at the review-approval gate.",
        };
      }
      return {
        finding_id: f.id,
        title: f.title,
        disposition: "planned",
        unit_ids: params.units.filter(unit => unit.source_finding_ids.includes(f.id)).map(unit => unit.id),
        ...groundingAnnotations(f),
      };
    }).map(entry => ({ ...entry, finding: params.sourceFindings.find(finding => finding.id === entry.finding_id)! }));
  const count = (d: CoverageLedgerEntry["disposition"]): number =>
    entries.filter((e) => e.disposition === d).length;
  return {
    contract_version: "remediate-code-coverage/v1alpha1",
    plan_id: params.planId,
    source_finding_count: params.sourceFindings.length,
    planned_count: count("planned"),
    folded_count: count("folded_into"),
    dropped_count: count("dropped_no_evidence"),
    checkpoint_dropped_count: count("dropped_by_checkpoint"),
    phantom_dropped_count: count("dropped_phantom_paths"),
    declined_review_count: count("declined_by_review"),
    entries,
  };
}
