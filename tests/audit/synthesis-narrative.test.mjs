import { test, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuditFindingsReportSchema } from "audit-tools/shared";

function assertMatchesJsonSchema(_schema, value, label) {
  const result = AuditFindingsReportSchema.safeParse(value);
  expect(result.success, `${label} should satisfy AuditFindingsReportSchema: ${
      result.success ? "" : JSON.stringify(result.error.issues)
    }`).toBeTruthy();
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const {
  buildAuditReportModel,
  buildAuditFindingsReport,
  applyNarrative,
  renderAuditReportMarkdown,
} = await import("../../src/audit/reporting/synthesis.ts");
const {
  runSynthesisExecutor,
  runSynthesisNarrativeExecutor,
} = await import("../../src/audit/orchestrator/synthesisExecutors.ts");
const { advanceAudit } = await import("../../src/audit/orchestrator/advance.ts");


function syntheticResults() {
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
function idOf(report, title) {
  const found = report.findings.find((f) => f.title === title);
  expect(found, `no synthesized finding titled ${title}`).toBeTruthy();
  return found.id;
}

function syntheticNarrative(report) {
  return {
    themes: [
      {
        theme_id: "T-1",
        title: "Inputs trusted without validation",
        root_cause: "Boundaries accept input without validating it first.",
        finding_ids: [
          idOf(report, "Token check is weak"),
          idOf(report, "Missing error handling"),
          "F-DOES-NOT-EXIST",
        ],
        suggested_fix_pattern: "Validate and normalize at every trust boundary.",
      },
    ],
    executive_summary: "Two related input-trust weaknesses were found.",
    top_risks: ["Auth bypass via weak token", "Crash on malformed input"],
  };
}

function baseReport() {
  const model = buildAuditReportModel({ results: syntheticResults() });
  return buildAuditFindingsReport(model);
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

test("applyNarrative tags findings, drops unknown ids, and round-trips theme_id", () => {
  const report = baseReport();
  const enriched = applyNarrative(report, syntheticNarrative(report));

  const tokenId = idOf(report, "Token check is weak");
  const parseId = idOf(report, "Missing error handling");

  expect(enriched.themes.length).toBe(1);
  // Unknown finding id is dropped; real ones are retained.
  expect(enriched.themes[0].finding_ids).toEqual([tokenId, parseId]);
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

test("runSynthesisExecutor emits canonical findings and renders the report", () => {
  const results = syntheticResults();
  const run = runSynthesisExecutor({ audit_results: results }, results);

  expect(run.artifacts_written.includes("audit-findings.json")).toBeTruthy();
  expect(run.artifacts_written.includes("audit-report.md")).toBeTruthy();
  expect(run.updated.audit_findings).toBeTruthy();
  expect(run.updated.audit_findings.summary.finding_count).toBe(2);
  expect(run.updated.audit_findings.themes).toBe(undefined);
  expect(run.updated.audit_report).toMatch(/# Audit Report/);
  expect(run.updated.audit_report).not.toMatch(/## Themes/);
  assertMatchesJsonSchema(null, run.updated.audit_findings, "executorFindings");
});

test("runSynthesisNarrativeExecutor omits cleanly without a narrative", () => {
  const results = syntheticResults();
  const synth = runSynthesisExecutor({ audit_results: results }, results).updated;

  const run = runSynthesisNarrativeExecutor(synth, undefined);
  expect(run.artifacts_written).toEqual(["synthesis-narrative.json"]);
  expect(run.updated.synthesis_narrative.status).toBe("omitted");
  expect(run.updated.synthesis_narrative.theme_count).toBe(0);
  // Deterministic report is unchanged.
  expect(run.updated.audit_report).not.toMatch(/## Themes/);
  expect(run.updated.audit_findings.themes).toBe(undefined);
});

test("runSynthesisNarrativeExecutor omits narrative and writes base findings when audit_findings is absent (needsBaseWrite=true)", () => {
  const results = syntheticResults();
  // Bundle has audit_results but NO audit_findings → needsBaseWrite is true
  const bundle = { audit_results: results };

  const run = runSynthesisNarrativeExecutor(bundle, undefined);

  // Both artifacts must be written because needsBaseWrite is true
  expect(run.artifacts_written).toEqual(["audit-findings.json", "synthesis-narrative.json"]);
  // Findings are built from scratch
  expect(run.updated.audit_findings).toBeTruthy();
  expect(run.updated.audit_findings.summary.finding_count).toBe(2);
  // No narrative was applied — themes should be absent
  expect(run.updated.audit_findings.themes).toBe(undefined);
  // Narrative record reflects omitted status
  expect(run.updated.synthesis_narrative.status).toBe("omitted");
});

test("runSynthesisNarrativeExecutor applies a provider narrative", () => {
  const results = syntheticResults();
  const synth = runSynthesisExecutor({ audit_results: results }, results).updated;

  const run = runSynthesisNarrativeExecutor(synth, syntheticNarrative(synth.audit_findings));
  expect(run.artifacts_written.includes("audit-findings.json")).toBeTruthy();
  expect(run.artifacts_written.includes("audit-report.md")).toBeTruthy();
  expect(run.artifacts_written.includes("synthesis-narrative.json")).toBeTruthy();
  expect(run.updated.synthesis_narrative.status).toBe("applied");
  expect(run.updated.synthesis_narrative.theme_count).toBe(1);
  expect(run.updated.synthesis_narrative.top_risk_count).toBe(2);
  expect(run.updated.audit_findings.themes.length).toBe(1);
  expect(run.updated.audit_report).toMatch(/## Themes/);
  assertMatchesJsonSchema(null, run.updated.audit_findings, "appliedFindings");
});

test("advanceAudit forced synthesis_narrative_executor applies and records the narrative", async () => {
  const results = syntheticResults();
  const synth = runSynthesisExecutor({ audit_results: results }, results).updated;

  const advanced = await advanceAudit(synth, {
    preferredExecutor: "synthesis_narrative_executor",
    narrativeResults: syntheticNarrative(synth.audit_findings),
  });

  expect(advanced.selected_executor).toBe("synthesis_narrative_executor");
  expect(advanced.updated_bundle.synthesis_narrative.status).toBe("applied");
  expect(advanced.updated_bundle.audit_findings.themes.length).toBe(1);
  const tokenId = idOf(synth.audit_findings, "Token check is weak");
  const f1 = advanced.updated_bundle.audit_findings.findings.find((f) => f.id === tokenId);
  expect(f1.theme_id).toBe("T-1");
});
