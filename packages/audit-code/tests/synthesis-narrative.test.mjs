import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertMatchesJsonSchema } from "./helpers/jsonSchemaAssert.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const {
  buildAuditReportModel,
  buildAuditFindingsReport,
  applyNarrative,
  renderAuditReportMarkdown,
} = await import("../dist/reporting/synthesis.js");
const {
  runSynthesisExecutor,
  runSynthesisNarrativeExecutor,
} = await import("../dist/orchestrator/synthesisExecutors.js");
const { advanceAudit } = await import("../dist/orchestrator/advance.js");

const auditFindingsSchema = JSON.parse(
  await readFile(join(repoRoot, "schemas", "audit_findings.schema.json"), "utf8"),
);

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

function syntheticNarrative() {
  return {
    themes: [
      {
        theme_id: "T-1",
        title: "Inputs trusted without validation",
        root_cause: "Boundaries accept input without validating it first.",
        finding_ids: ["F-1", "F-2", "F-DOES-NOT-EXIST"],
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
  assert.equal(typeof report.contract_version, "string");
  assert.ok(report.contract_version.length > 0);
  assert.equal(report.summary.finding_count, 2);
  assert.equal(report.findings.length, 2);
  assert.ok(report.work_blocks.length >= 1);
  // No narrative fields before the synthesis-narrative pass.
  assert.equal(report.themes, undefined);
  assert.equal(report.executive_summary, undefined);
  assert.equal(report.top_risks, undefined);
  // Deterministic findings carry no theme tag yet.
  assert.ok(report.findings.every((f) => f.theme_id === undefined));
  assertMatchesJsonSchema(auditFindingsSchema, report, "auditFindings");
});

test("deterministic report renders without narrative sections", () => {
  const markdown = renderAuditReportMarkdown(baseReport());
  assert.match(markdown, /# Audit Report/);
  assert.doesNotMatch(markdown, /## Executive Summary/);
  assert.doesNotMatch(markdown, /## Top Risks/);
  assert.doesNotMatch(markdown, /## Themes/);
  assert.doesNotMatch(markdown, /- Theme:/);
});

test("applyNarrative tags findings, drops unknown ids, and round-trips theme_id", () => {
  const enriched = applyNarrative(baseReport(), syntheticNarrative());

  assert.equal(enriched.themes.length, 1);
  // Unknown finding id is dropped; real ones are retained.
  assert.deepEqual(enriched.themes[0].finding_ids, ["F-1", "F-2"]);
  assert.equal(enriched.executive_summary, "Two related input-trust weaknesses were found.");
  assert.deepEqual(enriched.top_risks, [
    "Auth bypass via weak token",
    "Crash on malformed input",
  ]);

  const byId = Object.fromEntries(enriched.findings.map((f) => [f.id, f]));
  assert.equal(byId["F-1"].theme_id, "T-1");
  assert.equal(byId["F-2"].theme_id, "T-1");

  // The enriched canonical contract still validates.
  assertMatchesJsonSchema(auditFindingsSchema, enriched, "auditFindingsEnriched");
});

test("narrative-enriched report renders themes, summary, top risks (JSON↔markdown parity)", () => {
  const enriched = applyNarrative(baseReport(), syntheticNarrative());
  const markdown = renderAuditReportMarkdown(enriched);

  assert.match(markdown, /## Executive Summary/);
  assert.match(markdown, /Two related input-trust weaknesses were found\./);
  assert.match(markdown, /## Top Risks/);
  assert.match(markdown, /- Auth bypass via weak token/);
  assert.match(markdown, /## Themes/);
  assert.match(markdown, /### T-1 — Inputs trusted without validation/);
  assert.match(markdown, /- Suggested fix pattern: Validate and normalize/);
  // Each theme finding surfaces its theme tag.
  assert.match(markdown, /- Theme: T-1/);
});

test("runSynthesisExecutor emits canonical findings and renders the report", () => {
  const results = syntheticResults();
  const run = runSynthesisExecutor({ audit_results: results }, results);

  assert.ok(run.artifacts_written.includes("audit-findings.json"));
  assert.ok(run.artifacts_written.includes("audit-report.md"));
  assert.ok(run.updated.audit_findings);
  assert.equal(run.updated.audit_findings.summary.finding_count, 2);
  assert.equal(run.updated.audit_findings.themes, undefined);
  assert.match(run.updated.audit_report, /# Audit Report/);
  assert.doesNotMatch(run.updated.audit_report, /## Themes/);
  assertMatchesJsonSchema(auditFindingsSchema, run.updated.audit_findings, "executorFindings");
});

test("runSynthesisNarrativeExecutor omits cleanly without a narrative", () => {
  const results = syntheticResults();
  const synth = runSynthesisExecutor({ audit_results: results }, results).updated;

  const run = runSynthesisNarrativeExecutor(synth, undefined);
  assert.deepEqual(run.artifacts_written, ["synthesis-narrative.json"]);
  assert.equal(run.updated.synthesis_narrative.status, "omitted");
  assert.equal(run.updated.synthesis_narrative.theme_count, 0);
  // Deterministic report is unchanged.
  assert.doesNotMatch(run.updated.audit_report, /## Themes/);
  assert.equal(run.updated.audit_findings.themes, undefined);
});

test("runSynthesisNarrativeExecutor applies a provider narrative", () => {
  const results = syntheticResults();
  const synth = runSynthesisExecutor({ audit_results: results }, results).updated;

  const run = runSynthesisNarrativeExecutor(synth, syntheticNarrative());
  assert.ok(run.artifacts_written.includes("audit-findings.json"));
  assert.ok(run.artifacts_written.includes("audit-report.md"));
  assert.ok(run.artifacts_written.includes("synthesis-narrative.json"));
  assert.equal(run.updated.synthesis_narrative.status, "applied");
  assert.equal(run.updated.synthesis_narrative.theme_count, 1);
  assert.equal(run.updated.synthesis_narrative.top_risk_count, 2);
  assert.equal(run.updated.audit_findings.themes.length, 1);
  assert.match(run.updated.audit_report, /## Themes/);
  assertMatchesJsonSchema(auditFindingsSchema, run.updated.audit_findings, "appliedFindings");
});

test("advanceAudit forced synthesis_narrative_executor applies and records the narrative", async () => {
  const results = syntheticResults();
  const synth = runSynthesisExecutor({ audit_results: results }, results).updated;

  const advanced = await advanceAudit(synth, {
    preferredExecutor: "synthesis_narrative_executor",
    narrativeResults: syntheticNarrative(),
  });

  assert.equal(advanced.selected_executor, "synthesis_narrative_executor");
  assert.equal(advanced.updated_bundle.synthesis_narrative.status, "applied");
  assert.equal(advanced.updated_bundle.audit_findings.themes.length, 1);
  const f1 = advanced.updated_bundle.audit_findings.findings.find((f) => f.id === "F-1");
  assert.equal(f1.theme_id, "T-1");
});
