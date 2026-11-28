import assert from "node:assert/strict";
import test from "node:test";
import { reprojectLensCoverage } from "../dist/shared/reporting/lensCoverage.js";
import { AUDIT_FINDINGS_CONTRACT_VERSION, projectAuditFindingsReportSubset } from "../dist/shared/validation/findingsReport.js";

test("coverage projection recounts findings without forgetting prior exercise or selection", () => {
  const parent = [
    { lens: "removed", selected: false, findings_count: 1, outcome: "findings" },
    { lens: "retained", selected: true, findings_count: 3, outcome: "findings" },
    { lens: "clean", selected: true, findings_count: 0, outcome: "clean" },
  ];
  const projected = reprojectLensCoverage(parent, [{ lens: "retained" }, { lens: "retained" }]);
  assert.deepEqual(projected, [
    { lens: "removed", selected: false, findings_count: 0, outcome: "clean" },
    { lens: "retained", selected: true, findings_count: 2, outcome: "findings" },
    parent[2],
  ]);
});

test("the validated report subset preserves incomplete and inapplicable zero-count coverage", () => {
  const coverage = [
    { lens: "architecture", selected: true, findings_count: 0, outcome: "degraded", source_sample: "planned_not_run" },
    { lens: "not-applicable", selected: false, findings_count: 0, outcome: "not_applicable" },
    { lens: "not-run", selected: true, findings_count: 0, outcome: "not_run" },
  ];
  const report = {
    contract_version: AUDIT_FINDINGS_CONTRACT_VERSION,
    audit_read: null,
    findings: [],
    coherence_trace: { normalized_items: [], components: [] },
    work_blocks: [],
    work_block_seams: [],
    summary: {
      finding_count: 0,
      work_block_count: 0,
      severity_breakdown: {},
      audited_file_count: 0,
      excluded_file_count: 0,
      runtime_validation_status_breakdown: {},
      lens_breakdown: {},
      lens_coverage: coverage,
    },
  };
  const projected = projectAuditFindingsReportSubset(report, []);
  assert.deepEqual(projected.summary.lens_coverage, coverage);
});
