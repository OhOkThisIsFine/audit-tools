import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ArtifactBundle } from "../../src/audit/io/artifacts.js";
import type { AuditResult } from "../../src/audit/types.js";
import { runSynthesisExecutor } from "../../src/audit/orchestrator/synthesisExecutors.js";
import { buildDesignReviewSnapshot } from "../../src/audit/orchestrator/designReviewSnapshot.js";
import {
  buildAuditFindingsReport,
  buildAuditReportModel,
  renderAuditReportMarkdown,
} from "../../src/audit/reporting/synthesis.js";
import { validateAuditFindingsReport } from "../../src/shared/validation/findingsReport.js";

const fixture = new URL("../fixtures/audit-real-lens-coverage/", import.meta.url);
function read<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(name, fixture), "utf8")) as T;
}
function inputs() {
  return {
    results: readFileSync(new URL("audit_results.jsonl", fixture), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as AuditResult),
    coverageMatrix: read<ArtifactBundle["coverage_matrix"]>("coverage_matrix.json"),
    designAssessment: read<ArtifactBundle["design_assessment"]>("design_assessment.json"),
    intentCheckpoint: read<ArtifactBundle["intent_checkpoint"]>("intent_checkpoint.json"),
    unitManifest: read<ArtifactBundle["unit_manifest"]>("unit_manifest.json"),
    designReviewSnapshots: {
      contract: read<NonNullable<ArtifactBundle["design_review_snapshots"]>["contract"]>("design-review-snapshots/contract.json"),
      conceptual: read<NonNullable<ArtifactBundle["design_review_snapshots"]>["conceptual"]>("design-review-snapshots/conceptual.json"),
    },
  };
}
function synthesize(input: ReturnType<typeof inputs>) {
  return runSynthesisExecutor({
    audit_results: input.results,
    coverage_matrix: input.coverageMatrix,
    design_assessment: input.designAssessment,
    design_review_snapshots: input.designReviewSnapshots,
    unit_manifest: input.unitManifest,
    intent_checkpoint: input.intentCheckpoint,
  }, undefined, { auditRead: null }).updated.audit_findings!;
}
function outcomes(model: Pick<ReturnType<typeof buildAuditReportModel>, "summary">) {
  return Object.fromEntries(model.summary.lens_coverage!.map((entry) => [entry.lens, entry.outcome]));
}

describe("real audit report lens coverage", () => {
  it("does not turn correctness-only inspection and excluded design packets into other clean lenses", () => {
    const model = buildAuditReportModel(inputs());
    expect(outcomes(model)).toEqual({
      correctness: "findings", security: "not_run", reliability: "not_run", data_integrity: "not_run",
    });
    expect(outcomes(synthesize(inputs()))).toEqual(outcomes(model));
    expect(model.summary.finding_count).toBe(3);
    expect(model.summary.audited_file_count).toBe(0);
    const report = buildAuditFindingsReport(model, null);
    expect(validateAuditFindingsReport(report).filter((issue) => issue.severity === "error")).toEqual([]);
    const markdown = renderAuditReportMarkdown(model);
    expect(markdown).toContain("no qualifying inspection: security, reliability, data_integrity");
    expect(markdown).not.toContain("exercised, no findings: security");
  });

  it("keeps the truly inspected clean credit lens distinct from whole-file completeness", () => {
    const real = inputs();
    const credit = real.results.find((result) => result.unit_id === "src-credit-mjs")!;
    expect(credit.reviewed_clean).toBe(true);
    expect(credit.findings).toEqual([]);
    const model = buildAuditReportModel({ ...real, results: [credit], designAssessment: undefined });
    expect(outcomes(model)).toEqual({
      correctness: "clean", security: "not_run", reliability: "not_run", data_integrity: "not_run",
    });
    expect(model.summary.audited_file_count).toBe(0);
  });

  it("credits a completed, bound design review without removing read-only protection", () => {
    const real = inputs();
    const assessment = { generated_at: "2026-10-19T00:00:00Z", findings: [], conceptual_reviewed: true };
    const checkpoint = real.intentCheckpoint!;
    const snapshot = buildDesignReviewSnapshot("conceptual", [], {
      unit_manifest: real.unitManifest,
      intent_checkpoint: checkpoint,
      design_assessment: assessment,
    }, "2026-10-19T00:00:00Z");
    const model = synthesize({
      ...real, results: [], designAssessment: assessment, intentCheckpoint: checkpoint,
      designReviewSnapshots: { conceptual: snapshot, contract: undefined },
    });
    expect(outcomes(model)).toEqual({
      correctness: "clean", security: "clean", reliability: "clean", data_integrity: "clean",
    });
  });

  it.each(["excluded", "empty", "unbound"] as const)("does not credit %s design-review scope", (scope) => {
    const real = inputs();
    const snapshot = real.designReviewSnapshots.conceptual!;
    if (scope === "empty") snapshot.reviewed_inputs.unit_manifest = [];
    const model = buildAuditReportModel({
      ...real, results: [],
      designAssessment: { generated_at: "2026-10-19T00:00:00Z", findings: [], conceptual_reviewed: true },
      designReviewSnapshots: scope === "unbound" ? undefined : { conceptual: snapshot },
    });
    expect(Object.values(outcomes(model))).toEqual(["not_run", "not_run", "not_run", "not_run"]);
  });

  it("does not reuse coverage from a superseded result", () => {
    const real = inputs();
    const credit = real.results.find((result) => result.unit_id === "src-credit-mjs")!;
    const model = buildAuditReportModel({
      ...real,
      results: [credit, { ...credit, file_coverage: [], emit_source: "redispatch", attempt: 1 }],
      designAssessment: undefined,
    });
    expect(Object.values(outcomes(model))).toEqual(["not_run", "not_run", "not_run", "not_run"]);
  });

  it("does not call an empty selective inspection clean", () => {
    const real = inputs();
    const credit = real.results.find((result) => result.unit_id === "src-credit-mjs")!;
    const model = buildAuditReportModel({
      ...real, results: [{ ...credit, file_coverage: [] }], designAssessment: undefined,
    });
    expect(Object.values(outcomes(model))).toEqual(["not_run", "not_run", "not_run", "not_run"]);
  });
});
