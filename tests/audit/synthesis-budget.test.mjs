import test from "node:test";
import assert from "node:assert/strict";

const { buildAuditReportModel, renderAuditReportMarkdown } = await import("../../src/audit/reporting/synthesis.ts");

function coverageFile(path, status) {
  return {
    path,
    unit_ids: [],
    classification_status: status === "excluded" ? "excluded" : "classified",
    audit_status: status,
    required_lenses: [],
    completed_lenses: [],
  };
}

// ── FINDING-013: budget_deferred_task_count is distinct from excluded ────────

await test("FINDING-013: budget_deferred_task_count counts budget_deferred files and is NOT folded into excluded", () => {
  const report = buildAuditReportModel({
    results: [],
    coverageMatrix: {
      files: [
        coverageFile("src/a.ts", "complete"),
        coverageFile("src/b.ts", "complete"),
        coverageFile("docs/notes.md", "excluded"),
        coverageFile("src/c.ts", "budget_deferred"),
        coverageFile("src/d.ts", "budget_deferred"),
      ],
    },
  });
  assert.equal(report.summary.audited_file_count, 2);
  assert.equal(report.summary.excluded_file_count, 1, "excluded excludes budget_deferred");
  assert.equal(report.summary.budget_deferred_task_count, 2);
});

await test("FINDING-013: budget_deferred_task_count is 0 when no files are budget_deferred", () => {
  const report = buildAuditReportModel({
    results: [],
    coverageMatrix: {
      files: [
        coverageFile("src/a.ts", "complete"),
        coverageFile("docs/x.md", "excluded"),
      ],
    },
  });
  assert.equal(report.summary.budget_deferred_task_count, 0);
});

// ── FINDING-013: report markdown summary line ───────────────────────────────

await test("FINDING-013: renderAuditReportMarkdown adds a 'Not audited (budget)' line when > 0", () => {
  const report = buildAuditReportModel({
    results: [],
    coverageMatrix: {
      files: [
        coverageFile("src/a.ts", "complete"),
        coverageFile("src/c.ts", "budget_deferred"),
      ],
    },
  });
  const md = renderAuditReportMarkdown(report);
  assert.match(md, /Not audited \(budget\): 1 task\(s\) skipped by packet budget cap/);
});

await test("FINDING-013: the 'Not audited (budget)' line is omitted when budget_deferred_task_count === 0", () => {
  const report = buildAuditReportModel({
    results: [],
    coverageMatrix: { files: [coverageFile("src/a.ts", "complete")] },
  });
  const md = renderAuditReportMarkdown(report);
  assert.doesNotMatch(md, /Not audited \(budget\)/);
});

// ── FINDING-013: scope-and-coverage budget notice ───────────────────────────

await test("FINDING-013: '## Scope and Coverage' renders the budget-mode notice", () => {
  const report = buildAuditReportModel({
    results: [],
    coverageMatrix: { files: [coverageFile("src/a.ts", "complete")] },
  });
  const md = renderAuditReportMarkdown(report, {
    scope: {
      mode: "budget",
      since: null,
      seed_files: [],
      expanded_files: [],
      budget: { max_files: 2 },
      deferred_packet_count: 3,
      deferred_task_ids: ["t-1", "t-2", "t-3", "t-4"],
    },
  });
  assert.match(md, /Partial audit \(budget cap\)\./);
  assert.match(md, /3 packet\(s\) covering 4 task\(s\) were deferred/);
  assert.match(md, /A full audit is advised before release\./);
  // Distinct from the delta-mode notice.
  assert.doesNotMatch(md, /Delta audit since/);
});

await test("FINDING-013: budget-mode notice is distinct from the default full-scope notice", () => {
  const report = buildAuditReportModel({
    results: [],
    coverageMatrix: { files: [coverageFile("src/a.ts", "complete")] },
  });
  const full = renderAuditReportMarkdown(report); // no scope → default branch
  assert.doesNotMatch(full, /Partial audit \(budget cap\)/);
  assert.match(full, /deterministic output from the completed audit/);
});
