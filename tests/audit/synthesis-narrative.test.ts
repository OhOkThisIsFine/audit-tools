import { test, expect } from "vitest";
import { AuditFindingsReportSchema } from "audit-tools/shared";
import type { AuditFindingsReport, SynthesisNarrative } from "audit-tools/shared";
import { buildSampleAuditBundle, SAMPLE_REPORT_FINDING } from "../../src/audit/cli/sampleRunCommand.js";
import { QuestionAuditFindingsReportSchema } from "../../src/shared/types/questionReviewReport.js";
import type { AuditResult } from "../../src/audit/types.js";

function assertMatchesJsonSchema(_schema: unknown, value: unknown, label: string): void {
  const result = AuditFindingsReportSchema.safeParse(value);
  expect(result.success, `${label} should satisfy AuditFindingsReportSchema: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`).toBeTruthy();
}

const {
  buildAuditReportModel: buildAuditReportModelRaw,
  buildAuditFindingsReport,
  applyNarrative,
  renderAuditReportMarkdown,
} = await import("../../src/audit/reporting/synthesis.js");
const { advanceAudit } = await import("../../src/audit/orchestrator/advance.js");

const buildAuditReportModel = (
  params: Parameters<typeof buildAuditReportModelRaw>[0],
) => buildAuditReportModelRaw(params);


function syntheticResults(): AuditResult[] {
  return [
    {
      task_id: "u1:security",
      unit_id: "u1",
      pass_id: "pass:security",
      lens: "security",
      file_coverage: [{ path: "src/a.ts", total_lines: 10 }],
      findings: [
        {
          id: "F-1",
          title: "Token check is weak",
          category: "auth",
          severity: "high",
          confidence: "high",
          lens: "security",
          summary: "Weak token validation in the auth path.",
          affected_files: [{ path: "src/a.ts", line_start: 1, line_end: 3 }],
          evidence: ["src/a.ts:1 - token boundary"],
        },
        {
          id: "F-2",
          title: "Missing error handling",
          category: "errors",
          severity: "medium",
          confidence: "medium",
          lens: "correctness",
          summary: "Parse failure is swallowed without handling.",
          affected_files: [{ path: "src/b.ts", line_start: 5 }],
          evidence: ["src/b.ts:5 - unhandled parse"],
        },
      ],
    },
  ];
}

// Findings are re-keyed to content-derived ids at synthesis, so a realistic
// narrative references the *synthesized* ids (looked up by title), as the
// narrative LLM would after reading the report — not the worker-packet ids.
function idOf(report: AuditFindingsReport, title: string): string {
  const found = report.findings.find((f) => f.title === title);
  expect(found, `no synthesized finding titled ${title}`).toBeTruthy();
  return found!.id;
}

function syntheticNarrative(report: AuditFindingsReport): SynthesisNarrative {
  return {
    themes: [
      {
        theme_id: "T-1",
        title: "Inputs trusted without validation",
        root_cause: "Boundaries accept input without validating it first.",
        finding_ids: [
          idOf(report, "Token check is weak"),
          idOf(report, "Missing error handling"),
        ],
        suggested_fix_pattern: "Validate and normalize at every trust boundary.",
      },
    ],
    executive_summary: "Two related input-trust weaknesses were found.",
    top_risks: ["Auth bypass via weak token", "Crash on malformed input"],
  };
}

function baseReport(): AuditFindingsReport {
  const model = buildAuditReportModel({ results: syntheticResults() });
  return buildAuditFindingsReport(model, null);
}

test("buildAuditFindingsReport wraps the model in the canonical contract", () => {
  const report = baseReport();
  expect(typeof report.contract_version).toBe("string");
  expect(report.contract_version.length > 0).toBeTruthy();
  expect(report.summary.finding_count).toBe(2);
  expect(report.findings.length).toBe(2);
  expect(report.work_blocks.length >= 1).toBeTruthy();
  // No narrative fields before the synthesis-narrative pass.
  expect(report.themes).toBe(undefined);
  expect(report.executive_summary).toBe(undefined);
  expect(report.top_risks).toBe(undefined);
  // Deterministic findings carry no theme tag yet.
  expect(report.findings.every((f) => f.theme_id === undefined)).toBeTruthy();
  assertMatchesJsonSchema(null, report, "auditFindings");
});

test("deterministic report renders without narrative sections", () => {
  const markdown = renderAuditReportMarkdown(baseReport());
  expect(markdown).toMatch(/# Audit Report/);
  expect(markdown).not.toMatch(/## Executive Summary/);
  expect(markdown).not.toMatch(/## Top Risks/);
  expect(markdown).not.toMatch(/## Themes/);
  expect(markdown).not.toMatch(/- Theme:/);
});

test("applyNarrative refuses a narrative naming an unknown finding id (uniform id-join contract)", () => {
  const report = baseReport();
  const narrative = syntheticNarrative(report);
  narrative.themes![0].finding_ids.push("F-DOES-NOT-EXIST");
  // Silent-drop retired: an off-enum id refuses the WHOLE narrative, naming it.
  expect(() => applyNarrative(report, narrative)).toThrow(/F-DOES-NOT-EXIST/);
});

test("applyNarrative tags findings and round-trips theme_id", () => {
  const report = baseReport();
  const enriched = applyNarrative(report, syntheticNarrative(report));

  const tokenId = idOf(report, "Token check is weak");
  const parseId = idOf(report, "Missing error handling");

  expect(enriched.themes!.length).toBe(1);
  expect(enriched.themes![0].finding_ids).toEqual([tokenId, parseId]);
  expect(enriched.executive_summary).toBe("Two related input-trust weaknesses were found.");
  expect(enriched.top_risks).toEqual([
    "Auth bypass via weak token",
    "Crash on malformed input",
  ]);

  const byId = Object.fromEntries(enriched.findings.map((f) => [f.id, f]));
  expect(byId[tokenId].theme_id).toBe("T-1");
  expect(byId[parseId].theme_id).toBe("T-1");

  // The enriched canonical contract still validates.
  assertMatchesJsonSchema(null, enriched, "auditFindingsEnriched");
});

test("narrative-enriched report renders themes, summary, top risks (JSON↔markdown parity)", () => {
  const report = baseReport();
  const enriched = applyNarrative(report, syntheticNarrative(report));
  const markdown = renderAuditReportMarkdown(enriched);

  expect(markdown).toMatch(/## Executive Summary/);
  expect(markdown).toMatch(/Two related input-trust weaknesses were found\./);
  expect(markdown).toMatch(/## Top Risks/);
  expect(markdown).toMatch(/- Auth bypass via weak token/);
  expect(markdown).toMatch(/## Themes/);
  expect(markdown).toMatch(/### T-1 — Inputs trusted without validation/);
  expect(markdown).toMatch(/- Suggested fix pattern: Validate and normalize/);
  // Note 2: the theme→finding mapping lives in the ## Themes section (the
  // per-finding block no longer repeats a `- Theme:` line).
  expect(markdown).toMatch(/- Findings: SEC-[0-9a-f]+, COR-[0-9a-f]+/);
});

test("forced narrative refuses an archival result without a current question cycle", async () => {
  const auditFindings = baseReport();
  await expect(advanceAudit({ audit_findings: auditFindings }, {
    preferredExecutor: "synthesis_narrative_executor",
    narrativeResults: syntheticNarrative(auditFindings),
  })).rejects.toThrow("Question review must reach report-ready state before synthesis");
});

test("advanceAudit omits or applies a narrative without altering current question evidence", async () => {
  const { plan, auditFindings } = buildSampleAuditBundle([SAMPLE_REPORT_FINDING]);
  const review = auditFindings.question_review;
  const dependenciesByQuestion = new Map(review.accepted.map(answer => [
    answer.submission.question_id, answer.dependency_bindings,
  ]));
  const before = structuredClone(auditFindings);
  const findingId = auditFindings.findings[0]!.id;
  const bundle = {
    review_plan: plan, audit_findings: auditFindings,
    question_cycle: { pending: [], evidence: review.evidence,
      dependenciesByQuestion, answers: review.accepted, adjudications: review.adjudications,
      consolidations: review.consolidations },
  };
  const omitted = await advanceAudit(bundle, { preferredExecutor: "synthesis_narrative_executor" });
  expect(omitted.updated_bundle.synthesis_narrative?.status).toBe("omitted");
  expect(omitted.updated_bundle.audit_findings).toEqual(before);

  const advanced = await advanceAudit(bundle, {
    preferredExecutor: "synthesis_narrative_executor",
    narrativeResults: {
      themes: [{ theme_id: "T-1", title: "Queue counting", root_cause: "Only ready entries are counted.",
        finding_ids: [findingId], suggested_fix_pattern: "Count each state once." }],
      executive_summary: "The queue count is incomplete.",
    },
  });
  expect(advanced.selected_executor).toBe("synthesis_narrative_executor");
  expect(advanced.updated_bundle.synthesis_narrative?.status).toBe("applied");
  const updated = QuestionAuditFindingsReportSchema.parse(advanced.updated_bundle.audit_findings);
  expect(updated.themes?.[0]?.finding_ids).toEqual([findingId]);
  expect(updated.findings).toEqual(before.findings);
  expect(updated.question_review).toEqual(before.question_review);
  expect(auditFindings).toEqual(before);
});
