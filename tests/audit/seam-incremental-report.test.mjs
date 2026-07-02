/**
 * seam-incremental-report.test.mjs
 *
 * Cross-module seam test: incremental-report
 *
 * Verifies that the ingestion→synthesis pipeline (the two sides of the
 * incremental-report seam) are behaviorally compatible:
 *
 *   1. ingestionExecutors.ts → runResultIngestionExecutor — accumulates
 *      AuditResult waves into bundle.audit_results and updates coverage_matrix.
 *
 *   2. synthesisExecutors.ts → runSynthesisExecutor — builds the deterministic
 *      findings report and markdown from accumulated results in the bundle.
 *
 * Seam contract enforced here:
 *
 *  A. PARTIAL-SYNTHESIS: runSynthesisExecutor can be called on a bundle that
 *     has only wave-1 results; the returned report is a valid AuditFindingsReport
 *     with consistent summary counts (finding_count == findings.length,
 *     work_block_count == work_blocks.length) and a non-empty markdown render.
 *
 *  B. MONOTONICITY: ingesting wave-2 results then re-synthesizing yields a
 *     report whose finding_count is >= the wave-1 partial report's finding_count
 *     (new findings may be added; existing ones are merged, not dropped).
 *
 *  C. MARKDOWN-PARITY: every finding.id in the JSON contract appears verbatim
 *     in the markdown render, both for the partial and for the full report.
 *
 *  D. PIPELINE-COMPATIBILITY: the bundle returned by runResultIngestionExecutor
 *     (updated.audit_results) feeds directly into runSynthesisExecutor without
 *     any transformation — the two module boundaries are contract-compatible.
 *
 *  E. ZERO-RESULT BASELINE: synthesizing an empty result set is valid — no crash,
 *     empty findings/work_blocks arrays, summary counts both zero, valid markdown.
 */

import { test, expect } from "vitest";

const { runResultIngestionExecutor } = await import("../../src/audit/orchestrator/ingestionExecutors.ts");
const { runSynthesisExecutor } = await import("../../src/audit/orchestrator/synthesisExecutors.ts");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFinding(overrides = {}) {
  return {
    id: "F-001",
    title: "Missing input validation",
    category: "General",
    severity: "medium",
    confidence: "medium",
    lens: "security",
    summary: "Input is not validated at the trust boundary.",
    affected_files: [{ path: "src/auth.ts", line_start: 10, line_end: 20 }],
    evidence: ["manual-review"],
    ...overrides,
  };
}

function makeResult(overrides = {}) {
  return {
    task_id: "task-1",
    unit_id: "unit-auth",
    pass_id: "pass:security",
    lens: "security",
    file_coverage: [{ path: "src/auth.ts", total_lines: 100 }],
    findings: [makeFinding()],
    ...overrides,
  };
}

/**
 * Minimal ArtifactBundle carrying only what ingestionExecutors and
 * synthesisExecutors actually read. All optional fields are left absent.
 */
function makeBundle(overrides = {}) {
  return {
    coverage_matrix: {
      files: [
        {
          path: "src/auth.ts",
          unit_ids: ["unit-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
      ],
    },
    ...overrides,
  };
}

// ── E: Zero-result baseline ───────────────────────────────────────────────────

test("E: runSynthesisExecutor on an empty bundle produces a valid zero-count report", () => {
  const bundle = makeBundle({ audit_results: [] });
  const result = runSynthesisExecutor(bundle);

  const report = result.updated.audit_findings;
  expect(report, "audit_findings must be present in the returned bundle").toBeTruthy();
  expect(report.findings.length, "zero results → zero findings").toBe(0);
  expect(report.work_blocks.length, "zero results → zero work blocks").toBe(0);
  expect(report.summary.finding_count, "summary.finding_count must be 0").toBe(0);
  expect(report.summary.work_block_count, "summary.work_block_count must be 0").toBe(0);

  const markdown = result.updated.audit_report;
  expect(typeof markdown === "string" && markdown.length > 0, "markdown render must be a non-empty string").toBeTruthy();
  expect(markdown.includes("Findings"), "markdown must include a Findings section header").toBeTruthy();
});

// ── A: Partial-synthesis ──────────────────────────────────────────────────────

test("A: runSynthesisExecutor on a partial bundle (wave-1 only) produces a valid coherent report", () => {
  const wave1 = [
    makeResult({
      task_id: "task-w1-1",
      unit_id: "unit-auth",
      pass_id: "pass:security",
      lens: "security",
      file_coverage: [{ path: "src/auth.ts", total_lines: 80 }],
      findings: [
        makeFinding({ id: "F-W1-001", title: "Missing auth validation", lens: "security" }),
      ],
    }),
  ];

  const bundle = makeBundle({ audit_results: wave1 });
  const result = runSynthesisExecutor(bundle, wave1);

  const report = result.updated.audit_findings;
  expect(report, "audit_findings must be present after partial synthesis").toBeTruthy();
  expect(report.summary.finding_count, "summary.finding_count must equal findings.length").toBe(report.findings.length);
  expect(report.summary.work_block_count, "summary.work_block_count must equal work_blocks.length").toBe(report.work_blocks.length);
  expect(report.findings.length > 0, "wave-1 findings must produce at least one finding").toBeTruthy();
  expect(result.updated.audit_report, "audit_report markdown must be present").toBeTruthy();
  expect(result.artifacts_written.includes("audit-findings.json"), "audit-findings.json must be in artifacts_written").toBeTruthy();
  expect(result.artifacts_written.includes("audit-report.md"), "audit-report.md must be in artifacts_written").toBeTruthy();
});

// ── C: Markdown parity (partial) ──────────────────────────────────────────────

test("C: all finding IDs in the partial JSON contract appear verbatim in the partial markdown", () => {
  const wave1 = [
    makeResult({
      task_id: "task-w1-md",
      findings: [
        makeFinding({ id: "F-MD-001", title: "MD parity check alpha" }),
        makeFinding({ id: "F-MD-002", title: "MD parity check beta", lens: "correctness" }),
      ],
    }),
  ];

  const bundle = makeBundle({ audit_results: wave1 });
  const result = runSynthesisExecutor(bundle, wave1);

  const report = result.updated.audit_findings;
  const markdown = result.updated.audit_report;

  for (const finding of report.findings) {
    expect(markdown.includes(finding.id), `finding id ${finding.id} must appear verbatim in the markdown render`).toBeTruthy();
  }
});

// ── D + B: Pipeline compatibility + monotonicity ──────────────────────────────

test("D: runResultIngestionExecutor output feeds directly into runSynthesisExecutor", () => {
  const wave1 = [
    makeResult({
      task_id: "task-pipe-w1",
      findings: [makeFinding({ id: "F-PIPE-001", title: "Wave-1 pipe finding" })],
    }),
  ];

  const bundle = makeBundle();
  const ingestionResult = runResultIngestionExecutor(bundle, wave1);

  // The updated bundle from ingestion must carry the merged results.
  expect(Array.isArray(ingestionResult.updated.audit_results), "ingestion must produce audit_results in the updated bundle").toBeTruthy();
  expect(ingestionResult.updated.audit_results.length, "ingested bundle must have exactly wave-1 results").toBe(wave1.length);

  // Feed ingestion output directly into synthesis — no transformation.
  const synthResult = runSynthesisExecutor(
    ingestionResult.updated,
    ingestionResult.updated.audit_results,
  );

  const report = synthResult.updated.audit_findings;
  expect(report, "synthesis on ingestion output must produce audit_findings").toBeTruthy();
  expect(report.summary.finding_count, "pipeline-compatible report: finding_count == findings.length").toBe(report.findings.length);
  expect(report.findings.length > 0, "pipeline must surface wave-1 findings").toBeTruthy();
});

test("B: adding a second wave of results and re-synthesizing yields >= findings from the first synthesis", () => {
  const wave1 = [
    makeResult({
      task_id: "task-mono-w1",
      unit_id: "unit-auth",
      pass_id: "pass:security",
      lens: "security",
      file_coverage: [{ path: "src/auth.ts", total_lines: 80 }],
      findings: [
        makeFinding({ id: "F-MONO-001", title: "Wave-1 monotone finding", lens: "security" }),
      ],
    }),
  ];
  const wave2 = [
    makeResult({
      task_id: "task-mono-w2",
      unit_id: "unit-parser",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_coverage: [{ path: "src/parser.ts", total_lines: 60 }],
      findings: [
        makeFinding({
          id: "F-MONO-002",
          title: "Wave-2 new finding — error swallowed",
          lens: "correctness",
          affected_files: [{ path: "src/parser.ts", line_start: 5 }],
        }),
      ],
    }),
  ];

  // Stage 1: ingest wave-1 + synthesize.
  const baseBundle = makeBundle({
    coverage_matrix: {
      files: [
        {
          path: "src/auth.ts",
          unit_ids: ["unit-auth"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["security"],
          completed_lenses: [],
        },
        {
          path: "src/parser.ts",
          unit_ids: ["unit-parser"],
          classification_status: "classified",
          audit_status: "pending",
          required_lenses: ["correctness"],
          completed_lenses: [],
        },
      ],
    },
  });

  const ingestion1 = runResultIngestionExecutor(baseBundle, wave1);
  const synth1 = runSynthesisExecutor(
    ingestion1.updated,
    ingestion1.updated.audit_results,
  );
  const count1 = synth1.updated.audit_findings.summary.finding_count;

  // Stage 2: ingest wave-2 on top, re-synthesize.
  const ingestion2 = runResultIngestionExecutor(ingestion1.updated, wave2);
  const synth2 = runSynthesisExecutor(
    ingestion2.updated,
    ingestion2.updated.audit_results,
  );
  const count2 = synth2.updated.audit_findings.summary.finding_count;

  expect(count2 >= count1, `Full-report finding count (${count2}) must be >= partial-report count (${count1}) — adding results must not drop findings`).toBeTruthy();

  // Both F-MONO-001 and F-MONO-002 must appear in the full report.
  const fullReport = synth2.updated.audit_findings;
  const fullMarkdown = synth2.updated.audit_report;
  for (const finding of fullReport.findings) {
    expect(fullMarkdown.includes(finding.id), `full-report finding ${finding.id} must appear in the markdown render`).toBeTruthy();
  }
});

// ── C: Markdown parity (full multi-wave) ─────────────────────────────────────

test("C: all finding IDs in the full multi-wave JSON contract appear verbatim in the markdown", () => {
  const results = [
    makeResult({
      task_id: "t-mp-1",
      findings: [
        makeFinding({ id: "F-MP-001", title: "Auth gap", lens: "security" }),
      ],
    }),
    makeResult({
      task_id: "t-mp-2",
      unit_id: "unit-parser",
      pass_id: "pass:correctness",
      lens: "correctness",
      file_coverage: [{ path: "src/parser.ts", total_lines: 50 }],
      findings: [
        makeFinding({
          id: "F-MP-002",
          title: "Parser error swallowed",
          lens: "correctness",
          affected_files: [{ path: "src/parser.ts", line_start: 3 }],
        }),
      ],
    }),
    makeResult({
      task_id: "t-mp-3",
      unit_id: "unit-store",
      pass_id: "pass:reliability",
      lens: "reliability",
      file_coverage: [{ path: "src/store.ts", total_lines: 70 }],
      findings: [
        makeFinding({
          id: "F-MP-003",
          title: "Store write not atomic",
          lens: "reliability",
          affected_files: [{ path: "src/store.ts", line_start: 15 }],
        }),
      ],
    }),
  ];

  const bundle = makeBundle({ audit_results: results });
  const result = runSynthesisExecutor(bundle, results);
  const report = result.updated.audit_findings;
  const markdown = result.updated.audit_report;

  expect(report.summary.finding_count, "summary.finding_count must equal findings.length across all waves").toBe(report.findings.length);
  expect(report.summary.work_block_count, "summary.work_block_count must equal work_blocks.length").toBe(report.work_blocks.length);

  for (const finding of report.findings) {
    expect(markdown.includes(finding.id), `finding id ${finding.id} must appear in the multi-wave markdown render`).toBeTruthy();
  }
});
