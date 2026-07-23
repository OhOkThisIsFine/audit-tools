/**
 * Regression tests for audit-reporting module invariants:
 *   INV-audit-reporting-01 — render-equals-contract (JSON↔markdown parity)
 *   INV-audit-reporting-04 — applyNarrative sanitizes duplicate finding_ids across themes
 *   INV-audit-reporting-06 — normalizeExistingFindingsReport recomputes counts from findings+work_blocks
 *   INV-audit-reporting-07 — language-neutral render (no per-ecosystem special-casing)
 *   INV-audit-reporting-08 — truncation diagnostic uses process.stderr, not console.warn
 *   OBL-INV-APR-09 — buildAuditFindingsReport contract_version === shared constant; deferred prompt has no Command argv
 */
import { test, expect } from "vitest";

const {
  buildAuditReportModel,
  buildAuditFindingsReport,
  applyNarrative,
  renderAuditReportMarkdown,
  normalizeExistingFindingsReport,
  AUDIT_FINDINGS_CONTRACT_VERSION,
} = await import("../../src/audit/reporting/synthesis.ts");

const { renderSynthesisNarrativePrompt } = await import("../../src/audit/reporting/synthesisNarrativePrompt.ts");

// ── helpers ───────────────────────────────────────────────────────────────────
// makeFinding / wrapResult are single-sourced in tests/audit/fixtures/reporting.mjs
// (TST-1bfd0034 / MNT-1bfd0034: never drift-test two copies).

import { makeFinding, wrapResult } from "./fixtures/reporting.mjs";

function baseReport() {
  const model = buildAuditReportModel({
    results: [
      wrapResult([
        makeFinding({
          id: "F-1",
          title: "Input not validated",
          lens: "security",
          severity: "high",
          confidence: "high",
          affected_files: [{ path: "src/auth.ts", line_start: 1 }],
        }),
        makeFinding({
          id: "F-2",
          title: "Error swallowed silently",
          lens: "correctness",
          severity: "medium",
          confidence: "medium",
          affected_files: [{ path: "src/parser.ts", line_start: 5 }],
        }),
        makeFinding({
          id: "F-3",
          title: "Missing test for edge case",
          lens: "tests",
          severity: "low",
          confidence: "low",
          affected_files: [{ path: "src/util.ts", line_start: 20 }],
        }),
      ]),
    ],
  });
  return buildAuditFindingsReport(model);
}

// ── INV-audit-reporting-01: render-equals-contract ───────────────────────────

test("INV-01: render finding count matches JSON contract finding_count", () => {
  const report = baseReport();
  const markdown = renderAuditReportMarkdown(report);

  // The markdown summary line must reflect the same count as the JSON contract.
  expect(markdown, "markdown summary finding count must equal JSON contract finding_count").toMatch(new RegExp(`- Findings: ${report.summary.finding_count}`));
});

test("INV-01: render work block count matches JSON contract work_block_count", () => {
  const report = baseReport();
  const markdown = renderAuditReportMarkdown(report);

  expect(markdown, "markdown summary work block count must equal JSON contract work_block_count").toMatch(new RegExp(`- Work blocks: ${report.summary.work_block_count}`));
});

test("INV-01: every finding id in JSON contract appears in the markdown render", () => {
  const report = baseReport();
  const markdown = renderAuditReportMarkdown(report);

  for (const finding of report.findings) {
    expect(markdown.includes(finding.id), `finding id ${finding.id} must appear in the markdown render`).toBeTruthy();
  }
});

test("INV-01: every work block id in JSON contract appears in the markdown render", () => {
  const report = baseReport();
  const markdown = renderAuditReportMarkdown(report);

  for (const block of report.work_blocks) {
    expect(markdown.includes(block.id), `work block id ${block.id} must appear in the markdown render`).toBeTruthy();
  }
});

test("INV-01: narrative-enriched render finding ids still match the JSON contract", () => {
  const report = baseReport();
  const firstFindingId = report.findings[0].id;
  const narrative = {
    themes: [
      {
        theme_id: "T-1",
        title: "Input trust violations",
        root_cause: "Inputs are not validated at trust boundaries.",
        finding_ids: [firstFindingId],
        suggested_fix_pattern: "Validate and sanitize at every entry point.",
      },
    ],
    executive_summary: "One theme identified.",
    top_risks: ["Auth bypass"],
  };
  const enriched = applyNarrative(report, narrative);
  const markdown = renderAuditReportMarkdown(enriched);

  // All finding ids from the JSON contract must appear in the enriched render.
  for (const finding of enriched.findings) {
    expect(markdown.includes(finding.id), `enriched finding id ${finding.id} must appear in the markdown render`).toBeTruthy();
  }
  // The finding count must still match.
  expect(markdown, "enriched markdown summary finding count must match JSON contract").toMatch(new RegExp(`- Findings: ${enriched.summary.finding_count}`));
});

// ── INV-audit-reporting-04: applyNarrative sanitizes duplicate finding_ids ───

test("INV-04: a finding_id claimed by the first theme is not re-assigned by a later theme", () => {
  const report = baseReport();
  const [first, second] = report.findings;

  // Second theme tries to claim the first finding's id (already claimed by T-1).
  const narrative = {
    themes: [
      {
        theme_id: "T-1",
        title: "First theme",
        root_cause: "Root cause A.",
        finding_ids: [first.id],
        suggested_fix_pattern: "Fix A.",
      },
      {
        theme_id: "T-2",
        title: "Second theme",
        root_cause: "Root cause B.",
        finding_ids: [first.id, second.id],  // first.id is a duplicate across themes
        suggested_fix_pattern: "Fix B.",
      },
    ],
    executive_summary: "Two themes.",
    top_risks: [],
  };

  const enriched = applyNarrative(report, narrative);

  // Both themes are preserved.
  expect(enriched.themes.length).toBe(2);

  const t1 = enriched.themes.find((t) => t.theme_id === "T-1");
  const t2 = enriched.themes.find((t) => t.theme_id === "T-2");
  expect(t1).toBeTruthy();
  expect(t2).toBeTruthy();

  // T-1 keeps first.id as first-claimer.
  expect(t1.finding_ids.includes(first.id), "T-1 must retain the first-claimed id").toBeTruthy();

  // T-2 must NOT contain first.id (already claimed by T-1).
  expect(!t2.finding_ids.includes(first.id), "T-2 must not contain a finding_id already claimed by T-1").toBeTruthy();

  // T-2 keeps second.id which was not previously claimed.
  expect(t2.finding_ids.includes(second.id), "T-2 must keep its unclaimed finding_id").toBeTruthy();
});

test("INV-04: duplicate finding_ids within one theme's list are deduplicated", () => {
  const report = baseReport();
  const [first] = report.findings;

  const narrative = {
    themes: [
      {
        theme_id: "T-1",
        title: "Single theme with dup ids",
        root_cause: "Root cause.",
        finding_ids: [first.id, first.id, first.id],  // triply-repeated
        suggested_fix_pattern: "Fix.",
      },
    ],
    executive_summary: "Test.",
    top_risks: [],
  };

  const enriched = applyNarrative(report, narrative);

  expect(enriched.themes.length).toBe(1);
  const t1 = enriched.themes[0];
  expect(t1.finding_ids.length, "duplicate finding_ids within one theme must be deduplicated to one entry").toBe(1);
  expect(t1.finding_ids[0]).toBe(first.id);
});

test("INV-04: applyNarrative never drops or re-severities findings — the finding set is unchanged", () => {
  const report = baseReport();
  const originalFindings = report.findings.map((f) => ({ id: f.id, severity: f.severity }));

  const narrative = {
    themes: [
      {
        theme_id: "T-1",
        title: "A theme",
        root_cause: "Root.",
        finding_ids: [report.findings[0].id, "UNKNOWN-ID-XYZ"],
        suggested_fix_pattern: "Fix.",
      },
    ],
    executive_summary: "Test.",
    top_risks: [],
  };

  const enriched = applyNarrative(report, narrative);

  // Finding set is unchanged in count, ids, and severities.
  expect(enriched.findings.length, "applyNarrative must not drop or add findings").toBe(originalFindings.length);
  for (const orig of originalFindings) {
    const enrichedFinding = enriched.findings.find((f) => f.id === orig.id);
    expect(enrichedFinding, `finding ${orig.id} must still be present after applyNarrative`).toBeTruthy();
    expect(enrichedFinding.severity, `applyNarrative must not change severity of finding ${orig.id}`).toBe(orig.severity);
  }
});

// ── INV-audit-reporting-06: normalizeExistingFindingsReport recomputes counts ─

test("INV-06: normalizeExistingFindingsReport recomputes finding_count and work_block_count from the findings and work_blocks arrays", () => {
  const report = baseReport();

  // Corrupt the summary counts to simulate a drifted/stale promoted file.
  const stale = {
    ...report,
    summary: {
      ...report.summary,
      finding_count: 999,
      work_block_count: 42,
      severity_breakdown: { critical: 100 },
      lens_breakdown: { fake: 99 },
    },
  };

  const normalized = normalizeExistingFindingsReport(stale);

  expect(normalized.summary.finding_count, "finding_count must be recomputed from findings.length").toBe(report.findings.length);
  expect(normalized.summary.work_block_count, "work_block_count must be recomputed from work_blocks.length").toBe(report.work_blocks.length);
});

test("INV-06: normalizeExistingFindingsReport recomputes severity_breakdown from findings", () => {
  const report = baseReport();

  const stale = {
    ...report,
    summary: { ...report.summary, severity_breakdown: { critical: 100 } },
  };

  const normalized = normalizeExistingFindingsReport(stale);

  // The real breakdown must match what we can compute from the findings.
  const expected = {};
  for (const f of report.findings) {
    expected[f.severity] = (expected[f.severity] ?? 0) + 1;
  }
  expect(normalized.summary.severity_breakdown, "severity_breakdown must be recomputed from findings").toEqual(expected);
});

test("INV-06: normalizeExistingFindingsReport preserves upstream-derived fields (audited/excluded counts, runtime breakdown)", () => {
  const report = baseReport();

  // Upstream-derived fields that cannot be reconstructed without the bundle intermediates.
  const stale = {
    ...report,
    summary: {
      ...report.summary,
      audited_file_count: 17,
      excluded_file_count: 3,
      runtime_validation_status_breakdown: { confirmed: 5, pending: 2 },
    },
  };

  const normalized = normalizeExistingFindingsReport(stale);

  expect(normalized.summary.audited_file_count, "audited_file_count must be preserved (not recomputable without bundle intermediates)").toBe(17);
  expect(normalized.summary.excluded_file_count, "excluded_file_count must be preserved").toBe(3);
  expect(normalized.summary.runtime_validation_status_breakdown, "runtime_validation_status_breakdown must be preserved").toEqual({ confirmed: 5, pending: 2 });
});

// ── INV-audit-reporting-07: language-neutral render ───────────────────────────

test("INV-07: renderAuditReportMarkdown renders findings from mixed-language results without language-specific branching", () => {
  // Findings from TypeScript, Python, Go, and Rust files in one report.
  const model = buildAuditReportModel({
    results: [
      {
        task_id: "t-ts",
        unit_id: "u-ts",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/main.ts", total_lines: 100 }],
        findings: [
          makeFinding({
            id: "F-TS",
            title: "TypeScript issue",
            lens: "correctness",
            affected_files: [{ path: "src/main.ts" }],
          }),
        ],
      },
      {
        task_id: "t-py",
        unit_id: "u-py",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "lib/helper.py", total_lines: 50 }],
        findings: [
          makeFinding({
            id: "F-PY",
            title: "Python issue",
            lens: "security",
            affected_files: [{ path: "lib/helper.py" }],
          }),
        ],
      },
      {
        task_id: "t-go",
        unit_id: "u-go",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "cmd/server.go", total_lines: 80 }],
        findings: [
          makeFinding({
            id: "F-GO",
            title: "Go issue",
            lens: "reliability",
            affected_files: [{ path: "cmd/server.go" }],
          }),
        ],
      },
      {
        task_id: "t-rs",
        unit_id: "u-rs",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: [{ path: "src/lib.rs", total_lines: 60 }],
        findings: [
          makeFinding({
            id: "F-RS",
            title: "Rust issue",
            lens: "maintainability",
            affected_files: [{ path: "src/lib.rs" }],
          }),
        ],
      },
    ],
  });

  const report = buildAuditFindingsReport(model);
  const markdown = renderAuditReportMarkdown(report);

  // All four findings appear in the render, regardless of language.
  expect(report.summary.finding_count, "all 4 mixed-language findings must be present").toBe(4);
  for (const finding of report.findings) {
    expect(markdown.includes(finding.id), `finding ${finding.id} from ${finding.affected_files[0].path} must appear in the render`).toBeTruthy();
    expect(markdown.includes(finding.affected_files[0].path), `file path ${finding.affected_files[0].path} must appear in the render`).toBeTruthy();
  }
});

test("INV-07: the report shape is identical whether findings reference .ts, .py, .go, or .rs files", () => {
  // Same finding structure but for different language file paths → same report structure.
  const makeReport = (path) =>
    buildAuditFindingsReport(
      buildAuditReportModel({
        results: [
          {
            task_id: "t-1",
            unit_id: "u-1",
            pass_id: "pass:correctness",
            lens: "correctness",
            file_coverage: [{ path, total_lines: 10 }],
            findings: [
              makeFinding({
                id: "F-1",
                title: "Missing validation",
                lens: "security",
                affected_files: [{ path }],
              }),
            ],
          },
        ],
      }),
    );

  const tsReport = makeReport("src/auth.ts");
  const pyReport = makeReport("auth/views.py");
  const goReport = makeReport("pkg/auth/auth.go");

  // All three have exactly one finding and one work block — shape is language-neutral.
  expect(tsReport.summary.finding_count).toBe(1);
  expect(pyReport.summary.finding_count).toBe(1);
  expect(goReport.summary.finding_count).toBe(1);

  expect(tsReport.summary.work_block_count).toBe(pyReport.summary.work_block_count);
  expect(pyReport.summary.work_block_count).toBe(goReport.summary.work_block_count);

  // The markdown render structure is the same across languages.
  const tsMd = renderAuditReportMarkdown(tsReport);
  const pyMd = renderAuditReportMarkdown(pyReport);
  const goMd = renderAuditReportMarkdown(goReport);

  for (const md of [tsMd, pyMd, goMd]) {
    expect(md).toMatch(/## Findings/);
    expect(md).toMatch(/- Severity: medium/);
  }
});

// ── INV-audit-reporting-08: structured stderr, not console.warn ───────────────

test("INV-08: renderSynthesisNarrativePrompt writes truncation notice to process.stderr (not console.warn) when findings exceed cap", () => {
  // Build a report with more than 120 findings (the render cap in synthesisNarrativePrompt.ts).
  const manyFindings = Array.from({ length: 130 }, (_, i) =>
    makeFinding({
      id: `F-${i}`,
      title: `Unique finding title for issue number ${i}`,
      lens: "correctness",
      severity: "medium",
      affected_files: [{ path: `src/module${i}.ts` }],
    }),
  );

  const model = buildAuditReportModel({
    results: [
      {
        task_id: "t-1",
        unit_id: "u-1",
        pass_id: "pass:correctness",
        lens: "correctness",
        file_coverage: manyFindings.map((f) => ({
          path: f.affected_files[0].path,
          total_lines: 10,
        })),
        findings: manyFindings,
      },
    ],
  });
  const report = buildAuditFindingsReport(model);

  // Replace process.stderr.write temporarily to capture output.
  const capturedStderr = [];
  const capturedConsoleWarn = [];

  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origConsoleWarn = console.warn;

  process.stderr.write = (chunk, ...args) => {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  console.warn = (...args) => {
    capturedConsoleWarn.push(args.join(" "));
  };

  try {
    renderSynthesisNarrativePrompt(report);
  } finally {
    process.stderr.write = origStderrWrite;
    console.warn = origConsoleWarn;
  }

  // The truncation notice must go to stderr, not console.warn.
  expect(capturedConsoleWarn.length, "truncation notice must NOT use console.warn (INV-audit-reporting-08 / OBS-ad223196)").toBe(0);
  expect(capturedStderr.some((msg) => msg.includes("truncated findings list")), "truncation notice must be written to process.stderr").toBeTruthy();
});

test("INV-08: renderSynthesisNarrativePrompt does NOT write to stderr when findings are within the render cap", () => {
  const report = baseReport(); // only 3 findings, well below the 120 cap

  const capturedStderr = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    capturedStderr.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };

  try {
    renderSynthesisNarrativePrompt(report);
  } finally {
    process.stderr.write = origStderrWrite;
  }

  const truncationMessages = capturedStderr.filter((msg) =>
    msg.includes("truncated findings list"),
  );
  expect(truncationMessages.length, "no truncation notice must be emitted when findings are within the render cap").toBe(0);
});

// ── OBL-INV-APR-09: contract_version single-source + deferred prompt has no Command argv ──

const { AUDIT_FINDINGS_CONTRACT_VERSION: sharedVersion } = await import("audit-tools/shared");

test("OBL-INV-APR-09: buildAuditFindingsReport stamps contract_version identical to shared AUDIT_FINDINGS_CONTRACT_VERSION", () => {
  const report = baseReport();

  // The re-export in synthesis.ts must equal the shared canonical constant.
  expect(AUDIT_FINDINGS_CONTRACT_VERSION, "synthesis.ts AUDIT_FINDINGS_CONTRACT_VERSION must re-export the shared constant, not define a local copy").toBe(sharedVersion);

  // buildAuditFindingsReport must stamp the canonical version.
  expect(report.contract_version, "buildAuditFindingsReport must produce contract_version === shared AUDIT_FINDINGS_CONTRACT_VERSION").toBe(sharedVersion);

  // The version string must be non-trivial so a blank re-export cannot pass.
  expect(typeof sharedVersion === "string" && sharedVersion.length > 0, "shared AUDIT_FINDINGS_CONTRACT_VERSION must be a non-empty string").toBeTruthy();
});
