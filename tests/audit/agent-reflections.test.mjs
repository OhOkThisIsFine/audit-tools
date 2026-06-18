import test from "node:test";
import assert from "node:assert/strict";

// Parse/aggregate/render unit coverage lives with the module in
// audit-tools/shared (tests/agent-reflections.test.mjs there); this file keeps
// the audit-code integration surface: the report renderer's reflections option.
const { renderAuditReportMarkdown } = await import("../../src/audit/reporting/synthesis.ts");

test("renderAuditReportMarkdown includes a Process Feedback section only when reflections are supplied", () => {
  const base = {
    summary: {
      finding_count: 0,
      work_block_count: 0,
      severity_breakdown: {},
      audited_file_count: 0,
      excluded_file_count: 0,
    },
    findings: [],
    work_blocks: [],
  };

  const withReflections = renderAuditReportMarkdown(base, {
    reflections: [
      { task_id: "A", instruction_clarity: "clear", severity: "info", tool_friction: ["minor"] },
    ],
  });
  assert.match(withReflections, /## Process Feedback/);

  const without = renderAuditReportMarkdown(base, {});
  assert.doesNotMatch(without, /## Process Feedback/);
});
