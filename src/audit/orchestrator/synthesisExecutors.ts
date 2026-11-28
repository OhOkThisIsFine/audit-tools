// sites-pinned: tests/audit/audit-read-synthesis.test.ts, tests/audit/lens-coverage-real-report.test.ts
import { AUDIT_REPORT_FILENAME } from "../io/artifacts.js";
import type { ArtifactBundle, QuestionReportCharterOptions } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import {
  applyNarrative,
  renderAuditReportMarkdown,
} from "../reporting/synthesis.js";
import type { AuditRead, SynthesisNarrative } from "audit-tools/shared";
import { buildQuestionAuditFindingsReport, type QuestionReportInput } from "../reporting/questionReport.js";
import type { ReviewPlan } from "../../shared/types/reviewQuestion.js";
import { QuestionAuditFindingsReportSchema } from "../../shared/types/questionReviewReport.js";
import { stableStringify } from "audit-tools/shared";

type QuestionBundle = ArtifactBundle & { review_plan?: ReviewPlan };
export type QuestionSynthesisOptions = {
  auditRead: AuditRead | null;
  charter?: QuestionReportCharterOptions;
  questionReview: Omit<QuestionReportInput, "plan" | "auditRead"> & { effectivePlan?: ReviewPlan };
};

function currentQuestionReport(bundle: QuestionBundle, options: QuestionSynthesisOptions) {
  if (!bundle.review_plan) throw new Error("Question synthesis requires a current review_plan.");
  return QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    ...options.questionReview,
    plan: options.questionReview.effectivePlan ?? bundle.review_plan,
    auditRead: options.auditRead,
  }));
}

export function runQuestionSynthesisExecutor(
  bundle: QuestionBundle,
  options: QuestionSynthesisOptions,
): ExecutorRunResult {
  const report = currentQuestionReport(bundle, options);
  return {
    updated: {
      ...bundle,
      audit_findings: report,
      audit_report: renderAuditReportMarkdown(report, { reflections: bundle.agent_reflections, ...options.charter }),
    },
    artifacts_written: ["audit-findings.json", AUDIT_REPORT_FILENAME],
    progress_summary: `Rendered ${report.question_review.completion} coverage for ${report.question_review.questions.length} review question(s).`,
  };
}

export function runQuestionSynthesisNarrativeExecutor(
  bundle: QuestionBundle,
  narrative: SynthesisNarrative | undefined,
  options: QuestionSynthesisOptions,
): ExecutorRunResult {
  const current = currentQuestionReport(bundle, options);
  const persisted = QuestionAuditFindingsReportSchema.parse(bundle.audit_findings);
  const { themes: _themes, executive_summary: _summary, top_risks: _risks, ...deterministic } = persisted;
  if (stableStringify(deterministic) !== stableStringify(current)) {
    throw new Error("Synthesis narrative refers to stale question evidence. Regenerate the deterministic report first.");
  }
  const hasNarrative = Boolean(narrative && (
    narrative.themes?.length || narrative.executive_summary?.trim() || narrative.top_risks?.length));
  if (!hasNarrative) {
    return {
      updated: { ...bundle, synthesis_narrative: {
        status: "omitted", theme_count: 0, executive_summary_present: false, top_risk_count: 0,
      } },
      artifacts_written: ["synthesis-narrative.json"],
      progress_summary: "Synthesis narrative omitted; deterministic question report retained.",
    };
  }
  // Reuse theme validation but do not adopt its legacy mutations to finding rows.
  const { themes, executive_summary, top_risks } = applyNarrative(current, narrative!);
  const report = QuestionAuditFindingsReportSchema.parse({
    ...current,
    ...(themes ? { themes } : {}),
    ...(executive_summary ? { executive_summary } : {}),
    ...(top_risks ? { top_risks } : {}),
  });
  return {
    updated: {
      ...bundle, audit_findings: report, audit_report: renderAuditReportMarkdown(report, { reflections: bundle.agent_reflections, ...options.charter }),
      synthesis_narrative: {
        status: "applied", theme_count: themes?.length ?? 0,
        executive_summary_present: Boolean(executive_summary?.trim()), top_risk_count: top_risks?.length ?? 0,
      },
    },
    artifacts_written: ["audit-findings.json", AUDIT_REPORT_FILENAME, "synthesis-narrative.json"],
    progress_summary: "Synthesis narrative applied without changing question coverage or findings.",
  };
}
