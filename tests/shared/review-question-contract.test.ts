import { expect, test } from "vitest";
import {
  BUILT_IN_REVIEW_LENSES,
  REVIEW_QUESTION_CONTRACT_VERSION,
  ReviewAcceptedAnswerSchema,
  ReviewAdjudicationSchema,
  ReviewAssignmentSchema,
  ReviewEvidenceSchema,
  ReviewLensSchema,
  ReviewPlanSchema,
  ReviewSubmissionSchema,
  type ReviewFindingClaim,
  type ReviewSubmission,
} from "../../src/shared/types/reviewQuestion.js";
import {
  QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION,
  QuestionAuditFindingsReportSchema,
  QuestionReviewReportSchema,
} from "../../src/shared/types/questionReviewReport.js";
import {
  FINDINGS_DRAW_COHERENCE_POLICY,
  buildContentCoherenceTrace,
} from "../../src/shared/decompose/contentCoherence.js";

const schema_version = REVIEW_QUESTION_CONTRACT_VERSION;
const binding = { schema_version, question_id: "resume", revision_id: "resume-v1", snapshot_id: "abc" } as const;
const src = { path: "src/resume.ts", symbol: "resume", start_line: 4 };
const scope = { include: ["src/**"], exclude: ["src/private/**"] };
const assignment = {
  ...binding,
  assignment_id: "assignment-1",
  authorized_scope: scope,
  suggested_sources: [src],
  available_evidence_ids: ["e-readback"],
};
const deps = [{ kind: "membership", key: "registered-calls", fingerprint: "abc:manual,scheduled" }] as const;
const observation = {
  ...binding,
  observation_id: "obs-manual",
  part_id: "manual",
  kind: "runtime_observed" as const,
  statement: "Manual resume retained the saved marker.",
  source_refs: [src],
  evidence_refs: [{ evidence_id: "e-readback", observation_id: "manual-readback" }],
};
const incomplete: ReviewSubmission = {
  ...binding,
  assignment_id: assignment.assignment_id,
  submission_id: "submission-1",
  inspected_sources: [src],
  evidence_ids: ["e-readback"],
  limitations: ["Scheduled resume was not exercised."],
  answer: {
    outcome: "inconclusive",
    observations: [observation],
    parts: [
      { part_id: "manual", outcome: "clean", observation_ids: ["obs-manual"] },
      { part_id: "scheduled", outcome: "inconclusive", observation_ids: [], reason: "No fixture" },
    ],
    findings: [],
  },
};
const expectedReview = {
  audit_read: null,
  summary: {
    finding_count: 0, work_block_count: 0, severity_breakdown: {}, audited_file_count: 1,
    excluded_file_count: 0, runtime_validation_status_breakdown: {},
  },
  findings: [],
  coherence_trace: buildContentCoherenceTrace({ items: [] }, FINDINGS_DRAW_COHERENCE_POLICY),
  work_blocks: [],
  work_block_seams: [],
};
const claim = {
  schema_version,
  finding_id: "f-1",
  question_id: binding.question_id,
  revision_id: binding.revision_id,
  kind: "confirmed_defect",
  severity: "medium",
  confidence: "high",
  claim: "Manual resume can lose the marker.",
  consequence: "The next run repeats work.",
  next_step: "Read the saved marker before retrying.",
  source_refs: [src],
  evidence_ids: [],
  verification: [{ kind: "assertion", obligation_id: "assert-marker", expected: "Retain marker", source_refs: [src] }],
} satisfies ReviewFindingClaim;
const findingAnswer: ReviewSubmission = {
  ...incomplete,
  assignment_id: "assignment-2",
  submission_id: "submission-2",
  answer: {
    ...incomplete.answer,
    outcome: "findings",
    observations: [
      { ...observation, kind: "source_confirmed", statement: "The failure branch skips marker read-back." },
    ],
    parts: [
      { part_id: "manual", outcome: "findings", observation_ids: ["obs-manual"] },
      incomplete.answer.parts[1]!,
    ],
    findings: [claim],
  },
};
const persist = (s: ReviewSubmission) => ReviewAcceptedAnswerSchema.parse({
  schema_version,
  accepted_at: "2026-11-21T00:00:00Z",
  submission: ReviewSubmissionSchema.parse(JSON.parse(JSON.stringify(s))),
  dependency_bindings: deps,
});

test("stable revision and independent assignment IDs survive actual submission and accepted answer validators", () => {
  expect(ReviewAssignmentSchema.parse(assignment).authorized_scope).toEqual(scope);
  const first = persist(incomplete);
  const retry = persist(incomplete);
  const second = persist(findingAnswer);
  expect(retry).toEqual(first);
  expect(second.submission.revision_id).toBe(first.submission.revision_id);
  expect(second.submission.assignment_id).not.toBe(first.submission.assignment_id);
  expect(second.submission.submission_id).not.toBe(first.submission.submission_id);
  expect(first.submission.answer.parts[1]).toMatchObject({ outcome: "inconclusive", reason: "No fixture" });
  expect(ReviewAdjudicationSchema.parse({
    ...binding,
    adjudication_id: "comparison-1",
    submission_ids: [first.submission.submission_id, second.submission.submission_id],
    reviewer: "independent-judge",
    decision: "disputed",
    rationale: "One reviewer exercised only the happy path.",
    selected_submission_ids: [],
  }).decision).toBe("disputed");
});

test("accepts seven built-ins and explicit custom questions, not old names or unversioned results", () => {
  expect(BUILT_IN_REVIEW_LENSES).toHaveLength(7);
  expect(ReviewLensSchema.parse("custom:provider-admission")).toBe("custom:provider-admission");
  expect(ReviewLensSchema.safeParse("reliability").success).toBe(false);
  expect(ReviewSubmissionSchema.safeParse({ ...incomplete, schema_version: "audit-results/v1" }).success).toBe(false);
  expect(ReviewPlanSchema.safeParse({
    schema_version, snapshot_id: binding.snapshot_id, inventory: [], questions: [],
    omissions: [{ surface_id: "unmapped", source_refs: [src], reason: "Unresolved contract" }],
    lens_decisions: [{ lens: "tests", decision: "not_applicable", reason: "No suite" }],
  }).success).toBe(true);
});

test("one command may contain separate named observations; a bare command cannot support runtime claims", () => {
  const shared = ReviewEvidenceSchema.parse({
    schema_version, evidence_id: "e-readback", snapshot_id: "abc", kind: "command", source_refs: [src],
    dependencies: deps, status: "observed", description: "One bounded local fixture run",
    observations: [
      { observation_id: "manual-readback", statement: "Manual marker retained" },
      { observation_id: "scheduled-readback", statement: "Scheduled marker retained" },
    ],
  });
  expect(shared.observations?.map((o) => o.observation_id)).toEqual(["manual-readback", "scheduled-readback"]);
  expect(ReviewSubmissionSchema.safeParse({
    ...incomplete,
    answer: { ...incomplete.answer, observations: [{ ...observation, evidence_refs: [{ evidence_id: "e-readback" }] }] },
  }).success).toBe(false);
});

test("shared repair keeps both original obligations and is not itself an authorization", () => {
  const second = { ...claim, finding_id: "f-2", verification: [{
    kind: "assertion" as const, obligation_id: "assert-no-duplicate", expected: "Do not repeat work", source_refs: [src],
  }] };
  const third = { ...findingAnswer, assignment_id: "assignment-3", submission_id: "submission-3",
    answer: { ...findingAnswer.answer, findings: [second] } };
  const projection = QuestionReviewReportSchema.parse({
    schema_version, snapshot_id: binding.snapshot_id, completion: "incomplete",
    inventory: [], omissions: [], lens_decisions: [], questions: [],
    findings: [{ canonical_finding_id: "repair-1", kind: "confirmed_defect", question_ids: [binding.question_id],
      sources: [claim, second], actionable: false }],
    consolidations: [{ decision_id: "combine-1", decided_by: "judge", reason: "Same absent read-back",
      sources: [{ answer_id: "submission-2", finding_id: claim.finding_id }, { answer_id: "submission-3", finding_id: second.finding_id }] }],
    accepted: [persist(findingAnswer), persist(third)], adjudications: [], evidence: [],
  });
  expect(projection.findings[0]?.sources.flatMap((source) => source.verification.map((v) => v.obligation_id)))
    .toEqual(["assert-marker", "assert-no-duplicate"]);
  expect(QuestionAuditFindingsReportSchema.safeParse({
    ...expectedReview, contract_version: QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION, question_review: projection,
  }).success).toBe(true);
  expect(QuestionAuditFindingsReportSchema.safeParse({
    ...expectedReview, contract_version: "audit-tools/audit-findings/v1alpha2", question_review: projection,
  }).success).toBe(false);
});
