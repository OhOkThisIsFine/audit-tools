import { describe, expect, it } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import { buildReviewQuestionPlan } from "../../src/audit/orchestrator/questionPlanning.js";
import {
  acceptQuestionReview, type AuditQuestionBinding,
} from "../../src/audit/cli/dispatch/questionReviewAcceptance.js";
import { buildQuestionAuditFindingsReport } from "../../src/audit/reporting/questionReport.js";
import { QuestionAuditFindingsReportSchema } from "../../src/shared/types/questionReviewReport.js";
import {
  REVIEW_QUESTION_CONTRACT_VERSION as version, type ReviewAcceptedAnswer, type ReviewSubmission,
} from "../../src/shared/types/reviewQuestion.js";

const path = "src/handler.ts";
const sourceRef = { path, start_line: 1 };

function planned(fingerprint = "first", selective = false) {
  const bundle: ArtifactBundle = {
    repo_manifest: { repository: { name: "fixture" }, generated_at: "x", files: [
      { path, hash: fingerprint, size_bytes: 10, language: "typescript" },
      { path: "src/generated.ts", hash: "generated", size_bytes: 10, language: "typescript" },
    ] },
    file_disposition: { files: [
      { path, status: "included" },
      { path: "src/generated.ts", status: "generated", reason: "Generated registration" },
    ] },
    surface_manifest: { surfaces: [
      { id: "handler", kind: "interface", entrypoint: path, exposure: "network" },
      { id: "generated", kind: "interface", entrypoint: "src/generated.ts" },
    ] },
    intent_checkpoint: { schema_version: "intent-checkpoint/v1", confirmed_at: "x",
      confirmed_by: "host", scope_summary: "fixture", intent_summary: "review",
      ...(selective ? { lens_selection: { include: ["behavior"] } } : {}),
    },
  };
  const plan = buildReviewQuestionPlan(bundle, { snapshotId: "snapshot-" + fingerprint });
  const question = plan.questions.find(q => q.lens === "behavior");
  expect(question).toBeDefined();
  const identity = { schema_version: version, question_id: question!.question_id,
    revision_id: question!.revision_id, snapshot_id: question!.snapshot_id } as const;
  const binding: AuditQuestionBinding = {
    question: question!,
    assignment: { ...identity, assignment_id: "job-" + fingerprint, authorized_scope: { include: ["src"], exclude: [] },
      suggested_sources: [sourceRef], available_evidence_ids: [] },
    dependencies: question!.source_dependencies,
    sourceFiles: [{ path, line_count: 2, fingerprint }],
    evidence: [],
  };
  const submission: ReviewSubmission = {
    ...identity, submission_id: "answer-" + fingerprint, assignment_id: binding.assignment.assignment_id,
    inspected_sources: [sourceRef], evidence_ids: [], limitations: [],
    answer: { outcome: "clean", findings: [],
      parts: question!.requested_parts.map(({ part_id }, i) => ({
        part_id, outcome: "clean", observation_ids: ["seen-" + i],
      })),
      observations: question!.requested_parts.map(({ part_id }, i) => ({
        ...identity, observation_id: "seen-" + i, part_id, kind: "source_confirmed",
        statement: "The scoped source supports the question.", source_refs: [sourceRef], evidence_refs: [],
      })),
    },
  };
  const report = (accepted: ReviewAcceptedAnswer[]) => QuestionAuditFindingsReportSchema.parse(
    buildQuestionAuditFindingsReport({
      plan, accepted, evidence: [], auditRead: null,
      dependenciesByQuestion: new Map(plan.questions.map(q => [q.question_id, q.source_dependencies])),
    }),
  ).question_review;
  return { plan, question: question!, binding, submission, report };
}

describe("real question-led report scope", () => {
  it("credits a bound behavior answer without treating other applicable or excluded work as clean", () => {
    const fixture = planned();
    const record = acceptQuestionReview([], fixture.binding, fixture.submission, "2026-11-21T00:00:00Z").record;
    const report = fixture.report([record]);
    expect(report.completion).toBe("incomplete");
    expect(report.questions.find(row => row.question_id === fixture.question.question_id)?.state).toBe("clean");
    const unresolved = report.questions.filter(row => row.question_id !== fixture.question.question_id);
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every(row => row.state === "unreviewed")).toBe(true);
    expect(report.omissions).toContainEqual(expect.objectContaining({
      surface_id: "generated", reason: "Generated registration",
    }));
  });

  it("keeps selectively excluded lenses and an empty or unbound submission out of clean coverage", () => {
    const fixture = planned("first", true);
    expect(fixture.plan.lens_decisions).toContainEqual(expect.objectContaining({ lens: "security", decision: "excluded" }));
    expect(() => acceptQuestionReview([], fixture.binding, {
      ...fixture.submission, assignment_id: "another-job",
    }, "2026-11-21T00:00:00Z")).toThrow(/current issued assignment/);
    const empty = { ...fixture.submission, inspected_sources: [],
      answer: { ...fixture.submission.answer, observations: [], parts: [] } };
    const unanswered = acceptQuestionReview([], fixture.binding, empty, "2026-11-21T00:00:00Z").record;
    const report = fixture.report([unanswered]);
    expect(report.questions.every(row => row.state === "unreviewed")).toBe(true);
    expect(report.completion).toBe("incomplete");
  });

  it("does not reuse a clean answer when the actual source revision changes", () => {
    const before = planned();
    const prior = acceptQuestionReview([], before.binding, before.submission, "2026-11-21T00:00:00Z").record;
    const after = planned("second");
    expect(after.question.question_id).toBe(before.question.question_id);
    expect(after.question.revision_id).not.toBe(before.question.revision_id);
    const report = after.report([prior]);
    expect(report.questions.find(row => row.question_id === after.question.question_id)?.state).toBe("stale");
    expect(report.completion).toBe("incomplete");
  });
});
