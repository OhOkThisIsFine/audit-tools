// sites-pinned: tests/audit/question-report.test.ts, tests/remediate/intake-mixed-audit-provenance.test.ts
import { z } from "zod";
import { AuditFindingsReportSchema, type Finding } from "./finding.js";
import { confidenceRank, severityRank } from "./lens.js";
import { hashContent } from "../hash.js";
import { uniqueSorted } from "../compareCodeUnits.js";
import { stableStringify } from "../stableStringify.js";
import {
  REVIEW_QUESTION_CONTRACT_VERSION,
  ReviewAcceptedAnswerSchema,
  type ReviewAcceptedAnswer,
  type ReviewEvidence,
  ReviewAdjudicationSchema,
  ReviewEvidenceSchema,
  ReviewFindingClaimSchema,
  ReviewLensSchema,
  ReviewPlanObjectSchema,
  ReviewQuestionPlanStatusSchema,
  ReviewReopenEventSchema,
} from "./reviewQuestion.js";

export const QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION = "audit-tools/audit-findings/v2";
const id = z.string().min(1);
const partState = z.enum(["unreviewed", "stale", "inconclusive", "clean", "findings", "conflicted"]);
const questionState = z.enum([
  "unreviewed", "deferred", "blocked", "stale", "inconclusive", "clean", "findings", "conflicted",
]);
export const ReviewFindingConsolidationSchema = z.strictObject({
  decision_id: id,
  decided_by: z.string().min(1),
  reason: z.string().min(1),
  sources: z.array(z.strictObject({ answer_id: id, finding_id: id })).min(2),
});
export type ReviewFindingConsolidation = z.infer<typeof ReviewFindingConsolidationSchema>;

export const QuestionReviewReportSchema = z.strictObject({
  schema_version: z.literal(REVIEW_QUESTION_CONTRACT_VERSION),
  snapshot_id: id,
  completion: z.enum(["complete", "incomplete"]),
  analyzer_coverage_gaps: z.array(z.string().min(1)).optional(),
  inventory: ReviewPlanObjectSchema.shape.inventory,
  omissions: ReviewPlanObjectSchema.shape.omissions,
  lens_decisions: ReviewPlanObjectSchema.shape.lens_decisions,
  signal_dispositions: ReviewPlanObjectSchema.shape.signal_dispositions,
  questions: z.array(z.strictObject({
    question_id: id,
    revision_id: id,
    lens: ReviewLensSchema,
    inventory_item_ids: z.array(id).min(1),
    expected_outcome: z.string().min(1),
    plan_status: ReviewQuestionPlanStatusSchema,
    plan_reason: z.string().min(1).optional(),
    state: questionState,
    parts: z.array(z.strictObject({
      part_id: id,
      expectation: z.string().min(1),
      state: partState,
      accepted_answer_ids: z.array(id),
      observation_ids: z.array(id),
      reasons: z.array(z.string()),
    })),
    accepted_answer_ids: z.array(id),
    conflicts: z.array(z.strictObject({ part_id: id, answer_ids: z.array(id).min(2) })),
    finding_ids: z.array(id),
  })),
  findings: z.array(z.strictObject({
    canonical_finding_id: id,
    kind: z.enum(["confirmed_defect", "design_opportunity", "lead"]),
    question_ids: z.array(id).min(1),
    sources: z.array(ReviewFindingClaimSchema).min(1),
    actionable: z.boolean(),
  })),
  consolidations: z.array(ReviewFindingConsolidationSchema),
  accepted: z.array(ReviewAcceptedAnswerSchema),
  adjudications: z.array(ReviewAdjudicationSchema),
  reopens: z.array(ReviewReopenEventSchema).optional(),
  evidence: z.array(ReviewEvidenceSchema),
});
export type QuestionReviewReport = z.infer<typeof QuestionReviewReportSchema>;
export type ReviewQuestionReport = QuestionReviewReport;

// sites-pinned: tests/audit/question-report.test.ts, tests/remediate/intake-finding-selection.test.ts
type FindingRow = QuestionReviewReport["findings"][number];
type Submission = ReviewAcceptedAnswer["submission"];
type Answer = Submission["answer"];

export const questionClaimKey = (answerId: string, findingId: string): string =>
  JSON.stringify([answerId, findingId]);

export const canonicalQuestionFindingId = (keys: readonly string[]): string =>
  `question-finding-${hashContent(JSON.stringify(uniqueSorted(keys)))}`;

export function questionPartHasSupport(
  answer: Answer,
  part: Answer["parts"][number],
  evidence: ReadonlyMap<string, ReviewEvidence>,
  claimLinks?: readonly string[],
): boolean {
  return part.observation_ids.some(id => (claimLinks === undefined || claimLinks.includes(id)) && answer.observations.some(observation => {
    if (observation.observation_id !== id || observation.part_id !== part.part_id) return false;
    if (observation.kind === "source_confirmed" && observation.source_refs.length > 0) return true;
    return observation.kind !== "unverified" && observation.evidence_refs.some(ref => {
      const record = evidence.get(ref.evidence_id);
      return record?.status === "observed" &&
        (observation.kind !== "runtime_observed" || record.execution?.executed === true) &&
        (ref.observation_id === undefined
          ? observation.kind === "source_confirmed" && record.kind === "source"
          : record.observations?.some(item => item.observation_id === ref.observation_id));
    });
  }));
}

/** The only canonical actionable projection. Narrative prose never edits it. */
export function projectCanonicalQuestionFinding(
  row: FindingRow, lens: string, submissions: readonly Submission[],
): Finding {
  const source = [...row.sources].sort((a, b) =>
    severityRank(b.severity) - severityRank(a.severity) || confidenceRank(b.confidence) - confidenceRank(a.confidence),
  )[0]!;
  const locations = new Map(row.sources.flatMap(claim => claim.source_refs.map(ref => [
    stableStringify(ref),
    { path: ref.path, line_start: ref.start_line, line_end: ref.end_line },
  ] as const)));
  const analyzer = row.sources.flatMap(claim => claim.verification).find(item => item.kind === "analyzer");
  const evidence = uniqueSorted(row.sources.flatMap((claim, index) => {
    const answer = submissions[index]!.answer;
    const citations = answer.observations.flatMap(observation => {
      if (observation.kind !== "source_confirmed" || !claim.observation_ids?.includes(observation.observation_id) ||
          !answer.parts.some(part => part.part_id === observation.part_id && part.outcome === "findings" &&
            part.observation_ids.includes(observation.observation_id))) return [];
      return observation.source_refs.map(({ path, start_line, end_line }) => {
        const range = start_line === undefined ? "" : `:${start_line}${end_line === undefined ? "" : `-${end_line}`}`;
        return `${path}${range}: ${observation.statement}`;
      });
    });
    return [...claim.evidence_ids, ...citations];
  }));
  const downgrade = source.severity === "critical" && !evidence.some(id => id.trim().length > 0);
  return {
    id: row.canonical_finding_id, title: source.claim, category: "confirmed_defect",
    lens, severity: downgrade ? "high" : source.severity, confidence: source.confidence,
    ...(downgrade ? { severity_downgraded_from: "critical" as const } : {}),
    summary: source.consequence, affected_files: [...locations.values()],
    evidence, question_review_sources: row.sources,
    ...(analyzer ? { analyzer_provenance: analyzer.provenance } : {}),
  };
}


export const QuestionAuditFindingsReportSchema = z.intersection(
  AuditFindingsReportSchema,
  z.object({
    contract_version: z.literal(QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION),
    question_review: QuestionReviewReportSchema,
  }),
).superRefine((report, ctx) => {
  const { findings } = report.question_review;
  const byId = new Map(findings.map((finding) => [finding.canonical_finding_id, finding]));
  const actionable = findings.filter((finding) => finding.actionable);
  const { accepted, questions, consolidations } = report.question_review;
  const evidence = new Map(report.question_review.evidence.map(item => [item.evidence_id, item]));
  const questionsById = new Map(questions.map(question => [question.question_id, question]));
  const acceptedClaims = new Set(accepted.flatMap(({ submission }) =>
    submission.answer.findings.map(claim => stableStringify(claim)),
  ));
  const supportedClaims = new Map(accepted.flatMap(({ submission, dependency_bindings }) => {
    const question = questionsById.get(submission.question_id);
    if (!question || question.revision_id !== submission.revision_id || !dependency_bindings.length ||
        question.plan_status === "blocked" || question.plan_status === "deferred" || question.state === "conflicted" ||
        question.conflicts.length || !question.accepted_answer_ids.includes(submission.submission_id)) return [];
    return submission.answer.findings.flatMap(claim =>
      claim.kind === "confirmed_defect" && claim.question_id === submission.question_id &&
      claim.revision_id === submission.revision_id && claim.source_refs.length > 0 &&
      submission.answer.findings.filter(other => other.finding_id === claim.finding_id).length === 1 &&
      submission.answer.parts.some(part => part.outcome === "findings" &&
        question.parts.some(row => row.part_id === part.part_id && row.accepted_answer_ids.includes(submission.submission_id)) &&
        questionPartHasSupport(submission.answer, part, evidence, claim.observation_ids ?? []))
        ? [[questionClaimKey(submission.submission_id, claim.finding_id), { claim, submission }] as const] : [],
    );
  }));
  type Supported = { claim: FindingRow["sources"][number]; submission: Submission };
  const actionableGroups = new Map<string, { keys: string[]; rows: Supported[] }>([...supportedClaims].map(([key, row]) =>
    [canonicalQuestionFindingId([key]), { keys: [key], rows: [row] }],
  ));
  for (const decision of consolidations) {
    const keys = uniqueSorted(decision.sources.map(({ answer_id, finding_id }) => questionClaimKey(answer_id, finding_id)));
    const rows = keys.flatMap(key => supportedClaims.get(key) ?? []);
    if (rows.length === keys.length && keys.length === decision.sources.length) {
      actionableGroups.set(canonicalQuestionFindingId(keys), { keys, rows });
    }
  }
  // The projection can nominate executable work, but never grant permission:
  // remediation still binds each unchanged Finding to its owner-approved plan.
  const issue = (message: string) => ctx.addIssue({
    code: z.ZodIssueCode.custom, path: ["question_review", "findings"], message,
  });
  const dispositions = report.question_review.signal_dispositions;
  if (dispositions && (new Set(dispositions.map(row => row.signal_id)).size !== dispositions.length ||
      dispositions.some(row => row.question_id !== undefined && !questionsById.has(row.question_id)))) {
    ctx.addIssue({ code: "custom", path: ["question_review", "signal_dispositions"],
      message: "signal IDs must be unique and linked questions must be present" });
  }
  if (byId.size !== findings.length) issue("canonical finding IDs must be unique");
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length ||
    actionable.length !== report.findings.length) {
    issue("actionable question findings must exactly match the canonical findings rows");
  }
  if (actionable.some((row) =>
    row.kind !== "confirmed_defect" || row.sources.some((source) => source.kind !== "confirmed_defect"))) {
    issue("leads or design opportunities cannot become actionable findings");
  }
  if (findings.some((row) => row.sources.some((claim) => !acceptedClaims.has(stableStringify(claim))))) {
    issue("canonical findings must reference accepted source claims");
  }
  const usedClaims = new Set<string>();
  for (const row of report.findings) {
    const projected = byId.get(row.id);
    if (!projected?.actionable || stableStringify(row.question_review_sources) !== stableStringify(projected.sources)) {
      issue("an actionable row is missing its exact accepted source claims");
      continue;
    }
    const supported = actionableGroups.get(row.id);
    const claims = supported?.rows.map(({ claim }) => claim) ?? [];
    const lens = questionsById.get(projected.sources[0]!.question_id)?.lens;
    if (!supported || !lens || stableStringify(claims) !== stableStringify(projected.sources) ||
        stableStringify(projected.question_ids) !== stableStringify(uniqueSorted(claims.map(claim => claim.question_id)))) {
      issue("an actionable row has no supported source assignment or recorded consolidation");
      continue;
    }
    if (supported.keys.some(key => usedClaims.has(key))) issue("an accepted claim cannot nominate two actionable findings");
    for (const key of supported.keys) usedClaims.add(key);
    if (stableStringify(row) !== stableStringify(projectCanonicalQuestionFinding(projected, lens, supported.rows.map(({ submission }) => submission)))) {
      issue("an actionable row disagrees with its canonical accepted-claim projection");
    }
  }
});
export type QuestionAuditFindingsReport = z.infer<typeof QuestionAuditFindingsReportSchema>;
