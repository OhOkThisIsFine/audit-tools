import { buildQuestionAuditFindingsReport } from "../../../src/audit/reporting/questionReport.js";
import type { AuditRead, Finding } from "../../../src/shared/types/finding.js";
import {
  REVIEW_QUESTION_CONTRACT_VERSION, ReviewLensSchema, type ReviewAcceptedAnswer, type ReviewDependency,
  type ReviewPlan, type ReviewSourceRef,
} from "../../../src/shared/types/reviewQuestion.js";
import { QuestionAuditFindingsReportSchema } from "../../../src/shared/types/questionReviewReport.js";

/** Use only for synthetic current Path-A fixtures, never archived report tests. */
export function buildQuestionAuditReportFixture(findings: readonly Finding[], auditRead: AuditRead | null = null) {
  const base = { schema_version: REVIEW_QUESTION_CONTRACT_VERSION, snapshot_id: "synthetic-path-a" } as const;
  const plan: ReviewPlan = { ...base, inventory: [], questions: [], lens_decisions: [], omissions: [] };
  const accepted: ReviewAcceptedAnswer[] = [];
  const dependenciesByQuestion = new Map<string, ReviewDependency[]>();

  for (const finding of findings) {
    const refs: ReviewSourceRef[] = finding.affected_files.map(file => ({
      path: file.path, start_line: file.line_start, end_line: file.line_end,
    }));
    if (!refs.length) throw new Error(`Synthetic confirmed finding requires a source path: ${finding.id}`);
    const identity = { ...base, question_id: `question-${finding.id}`, revision_id: "fixture-revision" };
    const lens = ReviewLensSchema.parse(finding.lens);
    const item = `inventory-${finding.id}`;
    const dependencies: ReviewDependency[] = [...new Set(refs.map(ref => ref.path))].map(key => ({
      kind: "source", key, fingerprint: `fixture-source:${key}`,
    }));
    dependenciesByQuestion.set(identity.question_id, dependencies);
    if (!plan.lens_decisions.some(decision => decision.lens === lens)) {
      plan.lens_decisions.push({ lens, decision: "selected", reason: "Synthetic Path-A fixture" });
    }
    plan.inventory.push({ inventory_item_id: item, kind: "operation", title: finding.title,
      scope: "in_scope", contract_refs: [], source_refs: refs });
    plan.questions.push({ ...identity, lens, inventory_item_ids: [item], expected_outcome: finding.summary,
      requested_parts: [{ part_id: "fixture-part", expectation: finding.summary }], plan_status: "active",
      source_dependencies: dependencies, evidence_dependencies: [] });
    accepted.push({
      schema_version: base.schema_version, accepted_at: "2026-01-01T00:00:00.000Z", dependency_bindings: dependencies,
      submission: {
        ...identity, assignment_id: `assignment-${finding.id}`, submission_id: `answer-${finding.id}`,
        inspected_sources: refs, evidence_ids: [], limitations: [],
        answer: {
          outcome: "findings",
          parts: [{ part_id: "fixture-part", outcome: "findings", observation_ids: ["fixture-observation"] }],
          observations: [{ ...identity, observation_id: "fixture-observation", part_id: "fixture-part",
            kind: "source_confirmed", statement: finding.evidence?.join("; ") || finding.summary, source_refs: refs, evidence_refs: [] }],
          findings: [{
            schema_version: base.schema_version, question_id: identity.question_id, revision_id: identity.revision_id,
            finding_id: finding.id, kind: "confirmed_defect", severity: finding.severity, confidence: finding.confidence,
            claim: finding.title, consequence: finding.summary, next_step: "Address the synthetic defect.",
            source_refs: refs, evidence_ids: [], observation_ids: ["fixture-observation"], verification: [],
          }],
        },
      },
    });
  }
  const report = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    plan, accepted, dependenciesByQuestion, evidence: [], auditRead,
  }));
  const ids = new Map(report.question_review.findings.map(row => [row.sources[0]!.finding_id, row.canonical_finding_id]));
  return { report, ids };
}
