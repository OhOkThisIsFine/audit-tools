// sites-pinned: tests/audit/question-report.test.ts, tests/audit/question-review-acceptance.test.ts
import { compareCodeUnits, stableStringify, uniqueSorted } from "audit-tools/shared";
import type { AuditRead } from "../../shared/types/finding.js";
import {
  REVIEW_QUESTION_CONTRACT_VERSION,
  type ReviewAcceptedAnswer, type ReviewAdjudication, type ReviewDependency, type ReviewEvidence,
  type ReviewFindingClaim, type ReviewPlan, type ReviewQuestion, type ReviewReopenEvent,
} from "../../shared/types/reviewQuestion.js";
import {
  QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION,
  canonicalQuestionFindingId, projectCanonicalQuestionFinding, questionClaimKey, questionPartHasSupport,
  type QuestionAuditFindingsReport, type QuestionReviewReport,
} from "../../shared/types/questionReviewReport.js";
import { buildWorkBlockPartition } from "./workBlocks.js";
import { projectQuestionReview } from "../cli/dispatch/questionReviewAcceptance.js";

type QuestionRow = QuestionReviewReport["questions"][number];
type FindingRow = QuestionReviewReport["findings"][number];
type Decisions = QuestionReviewReport["consolidations"];
type Claim = { answerId: string; source: ReviewFindingClaim; actionable: boolean };

export interface QuestionReportInput {
  plan: ReviewPlan;
  accepted: readonly ReviewAcceptedAnswer[];
  evidence: readonly ReviewEvidence[];
  dependenciesByQuestion: ReadonlyMap<string, readonly ReviewDependency[]>;
  adjudications?: readonly ReviewAdjudication[];
  consolidations?: readonly Decisions[number][];
  reopens?: readonly ReviewReopenEvent[];
  auditRead: AuditRead | null;
}

export function projectQuestionForReport(
  question: ReviewQuestion, history: readonly ReviewAcceptedAnswer[], adjudications: readonly ReviewAdjudication[],
  evidence: ReadonlyMap<string, ReviewEvidence>,
  dependencies: readonly ReviewDependency[] | undefined,
): { row: QuestionRow; claims: Claim[] } {
  const { current: live, stale } = projectQuestionReview(question, history, dependencies?.slice());
  const ids = new Set(live.map(({ submission }) => submission.submission_id));
  const decisions = adjudications.filter(decision => decision.question_id === question.question_id &&
    decision.revision_id === question.revision_id && decision.snapshot_id === question.snapshot_id &&
    decision.submission_ids.every(id => ids.has(id)));
  // Decisions apply only to the submissions actually adjudicated. A later
  // independent answer can disagree even following an earlier resolution.
  const inactive = new Set<string>();
  for (const decision of decisions) {
    if (decision.decision !== "resolved" || !decision.selected_submission_ids.length ||
        !decision.selected_submission_ids.every(id => decision.submission_ids.includes(id))) continue;
    for (const id of decision.submission_ids) {
      if (decision.selected_submission_ids.includes(id)) inactive.delete(id);
      else inactive.add(id);
    }
  }
  const effective = live.filter(({submission}) => !inactive.has(submission.submission_id));
  const conflicts: QuestionRow["conflicts"] = [];
  const parts = question.requested_parts.map(({ part_id, expectation }): QuestionRow["parts"][number] => {
    const answers = effective.flatMap(({ submission }) => submission.answer.parts.filter(part => part.part_id === part_id).map(part => {
      return { part, answerId: submission.submission_id, outcome: questionPartHasSupport(submission.answer, part, evidence) ? part.outcome : "inconclusive" as const };
    }));
    const answerIds = uniqueSorted(answers.map(answer => answer.answerId));
    const dispute = [...decisions].reverse().find(decision =>
      decision.submission_ids.filter(id => answerIds.includes(id)).length >= 2,
    )?.decision === "disputed";
    const findings = answers.some(answer => answer.outcome === "findings");
    const clean = answers.some(answer => answer.outcome === "clean");
    const gap = answers.some(answer => answer.outcome === "inconclusive");
    let state: QuestionRow["parts"][number]["state"];
    if (dispute || (findings && clean)) {
      state = "conflicted";
      conflicts.push({ part_id, answer_ids: answerIds });
    } else if (gap) state = "inconclusive";
    else if (findings) state = "findings";
    else if (clean) state = "clean";
    else if (stale.some(answer =>
      answer.submission.answer.parts.some(part => part.part_id === part_id))) state = "stale";
    else state = "unreviewed";
    return {
      part_id, expectation, state, accepted_answer_ids: answerIds,
      observation_ids: uniqueSorted(answers.flatMap(({ part }) => part.observation_ids)),
      reasons: uniqueSorted(answers.flatMap(({ part }) => part.reason ? [part.reason] : [])),
    };
  });
  const state: QuestionRow["state"] = conflicts.length ? "conflicted"
    : question.plan_status === "blocked" ? "blocked"
      : question.plan_status === "deferred" ? "deferred"
        : parts.some(part => part.state === "stale") ? "stale"
          : parts.every(part => part.state === "unreviewed") ? "unreviewed"
            : parts.some(part => part.state === "inconclusive" || part.state === "unreviewed") ? "inconclusive"
              : parts.some(part => part.state === "findings") ? "findings" : "clean";
  const active = question.plan_status !== "blocked" && question.plan_status !== "deferred" && conflicts.length === 0;
  const claims = history.flatMap(({ submission }) => {
    const counts = new Map<string, number>();
    for (const finding of submission.answer.findings) counts.set(finding.finding_id, (counts.get(finding.finding_id) ?? 0) + 1);
    // Old rejected-by-today's-rules data still belongs in the accepted history.
    // Ambiguous identities cannot name a projected claim.
    const displayed = new Set<string>();
    return submission.answer.findings.filter(source => {
      if (displayed.has(source.finding_id)) return false;
      displayed.add(source.finding_id);
      return true;
    }).map(source => ({
    answerId: submission.submission_id, source,
    actionable: counts.get(source.finding_id) === 1 && active && ids.has(submission.submission_id) && !inactive.has(submission.submission_id) &&
      source.kind === "confirmed_defect" && source.source_refs.length > 0 &&
      effective.some(answer => answer.submission.submission_id === submission.submission_id &&
        answer.submission.answer.parts.some(part => part.outcome === "findings" &&
          questionPartHasSupport(answer.submission.answer, part, evidence, source.observation_ids ?? []))),
    }));
  });
  return {
    row: {
      question_id: question.question_id, revision_id: question.revision_id, lens: question.lens,
      inventory_item_ids: question.inventory_item_ids, expected_outcome: question.expected_outcome,
      plan_status: question.plan_status, ...(question.plan_reason === undefined ? {} : { plan_reason: question.plan_reason }),
      state, parts, accepted_answer_ids: uniqueSorted([...ids]), conflicts, finding_ids: [],
    },
    claims,
  };
}

function groupClaims(
  claims: Claim[], decisions: Decisions, accepted: ReadonlyMap<string, ReviewAcceptedAnswer>,
): Array<{ row: FindingRow; answerIds: string[] }> {
  const currentClaims = new Map(claims.map(claim => [questionClaimKey(claim.answerId, claim.source.finding_id), claim]));
  const pending = new Map(currentClaims);
  if (pending.size !== claims.length) throw new Error("Duplicate finding claim within an accepted submission.");
  const groups: Claim[][] = [];
  const groupedKeys = new Set<string>();
  for (const decision of decisions) {
    const keys = uniqueSorted(decision.sources.map(source => questionClaimKey(source.answer_id, source.finding_id)));
    const historical = decision.sources.map(({ answer_id, finding_id }) =>
      accepted.get(answer_id)?.submission.answer.findings.filter(source => source.finding_id === finding_id) ?? [],
    );
    if (keys.length < 2 || keys.length !== decision.sources.length ||
        historical.some(rows => rows.length !== 1 || rows[0]!.kind !== historical[0]?.[0]?.kind)) {
      throw new Error(`Consolidation ${decision.decision_id} must name distinct available claims of one kind.`);
    }
    // Check currency independently of grouping: the claims already consumed by
    // an applicable decision can still make a later overlapping one invalid.
    const rows = keys.flatMap(key => currentClaims.get(key) ?? []);
    // Old decisions remain history without consuming surviving individual claims.
    if (rows.length !== keys.length || rows.some(row => !row.actionable)) continue;
    if (keys.some(key => groupedKeys.has(key))) {
      throw new Error(`Consolidation ${decision.decision_id} overlaps a current decision.`);
    }
    for (const key of keys) groupedKeys.add(key);
    groups.push(rows);
    for (const key of keys) pending.delete(key);
  }
  groups.push(...[...pending.entries()].sort(([a], [b]) => compareCodeUnits(a, b)).map(([, claim]) => [claim]));
  return groups.map(rows => {
    const canonical_finding_id = canonicalQuestionFindingId(rows.map(row => questionClaimKey(row.answerId, row.source.finding_id)));
    return { answerIds: rows.map(row => row.answerId), row: {
      canonical_finding_id, kind: rows[0]!.source.kind, actionable: rows.every(row => row.actionable),
      question_ids: uniqueSorted(rows.map(row => row.source.question_id)),
      sources: rows.map(row => row.source),
    }};
  }).sort((a, b) => compareCodeUnits(a.row.canonical_finding_id, b.row.canonical_finding_id));
}

/** Deterministic projection only: never update an accepted answer or infer a review from runtime output. */
export function buildQuestionAuditFindingsReport(input: QuestionReportInput): QuestionAuditFindingsReport {
  const acceptedById = new Map<string, ReviewAcceptedAnswer>();
  for (const row of input.accepted) {
    const id = row.submission.submission_id;
    const prior = acceptedById.get(id);
    if (prior && stableStringify(prior.submission) !== stableStringify(row.submission)) {
      throw new Error(`Conflicting content for accepted submission ${id}.`);
    }
    if (!prior) acceptedById.set(id, row);
  }
  const accepted = [...acceptedById.values()].sort((a, b) => compareCodeUnits(a.submission.submission_id, b.submission.submission_id));
  const adjudications = [...input.adjudications ?? []];
  const evidence = new Map(input.evidence.map(record => [record.evidence_id, record]));
  const projected = input.plan.questions.map(question => projectQuestionForReport(
    question, accepted.filter(row => row.submission.question_id === question.question_id), adjudications,
    evidence, input.dependenciesByQuestion.get(question.question_id),
  ));
  const consolidations = [...input.consolidations ?? []];
  const groups = groupClaims(projected.flatMap(item => item.claims), consolidations, acceptedById);
  const questions = projected.map(({ row }) => ({
    ...row, finding_ids: groups.filter(group => group.row.question_ids.includes(row.question_id)).map(group => group.row.canonical_finding_id),
  }));
  const findings = groups.filter(group => group.row.actionable).map(({ row, answerIds }) => projectCanonicalQuestionFinding(
    row, questions.find(question => question.question_id === row.sources[0]!.question_id)!.lens,
    answerIds.map(id => acceptedById.get(id)!.submission),
  ));
  const work = buildWorkBlockPartition({ findings });
  const counts = (key: "severity" | "lens"): Record<string, number> => Object.fromEntries(
    uniqueSorted(findings.map(finding => finding[key])).map(value => [value, findings.filter(finding => finding[key] === value).length]),
  );
  const unmapped = input.plan.inventory.some(item => item.scope === "in_scope" &&
    !input.plan.questions.some(question => question.inventory_item_ids.includes(item.inventory_item_id)));
  const completion = questions.length === 0 || unmapped || input.plan.omissions.length > 0 ||
    questions.some(row => row.state !== "clean" && row.state !== "findings") ? "incomplete" : "complete";
  const question_review: QuestionReviewReport = {
    schema_version: REVIEW_QUESTION_CONTRACT_VERSION, snapshot_id: input.plan.snapshot_id,
    completion, questions, findings: groups.map(({ row }) => row), consolidations, adjudications, accepted,
    ...(input.reopens?.length ? { reopens: [...input.reopens] } : {}),
    inventory: input.plan.inventory, omissions: input.plan.omissions, lens_decisions: input.plan.lens_decisions,
    ...(input.plan.signal_dispositions === undefined ? {} : { signal_dispositions: input.plan.signal_dispositions }),
    evidence: [...input.evidence],
  };
  const currentAnswerIds = new Set(questions.flatMap(row => row.accepted_answer_ids));
  return {
    contract_version: QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION, audit_read: input.auditRead, question_review,
    findings, coherence_trace: work.coherence_trace, work_blocks: work.blocks, work_block_seams: work.seams,
    summary: {
      finding_count: findings.length, work_block_count: work.blocks.length,
      severity_breakdown: counts("severity"), lens_breakdown: counts("lens"),
      audited_file_count: new Set(accepted.filter(answer =>
        currentAnswerIds.has(answer.submission.submission_id)).flatMap(
        answer => answer.submission.inspected_sources.map(ref => ref.path),
      )).size,
      excluded_file_count: new Set(input.plan.inventory.filter(item => item.scope === "excluded")
        .flatMap(item => item.source_refs.map(ref => ref.path))).size,
      runtime_validation_status_breakdown: {},
    },
  };
}
