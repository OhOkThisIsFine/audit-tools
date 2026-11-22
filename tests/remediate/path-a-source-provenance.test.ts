import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Finding } from "../../src/shared/index.js";
import { RemediationOutcomesReportSchema } from "../../src/shared/types/remediationOutcome.js";
import { readPlanSource } from "../../src/remediate/contractPipeline/executionPlan.js";
import { buildRemediationOutcomesReport } from "../../src/remediate/phases/close.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { buildQuestionAuditReportFixture } from "./helpers/questionAuditReportFixture.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-path-a-source-provenance");
beforeEach(async () => { await harness.resetTestRepo(); });
afterEach(async () => { await harness.cleanupTestRepo(); });

describe("original source provenance through Path-A filtering and reviewed execution", () => {
test.each(["singleton", "two-canonical", "partial-phantom"])("real Path-A filtering preserves original findings through reviewed source and outcome roundtrip (%s)", async mode => {
  const twoCanonical = mode === "two-canonical";
  const original: Finding = {
    id: "COR-original", title: "Reject invalid input", category: "correctness", severity: "high", confidence: "high",
    lens: "behavior", summary: "The local input boundary accepts an invalid value.",
    affected_files: [{ path: "src/input.ts" }], evidence: ["src/input.ts:1 accepts the input"],
  };
  if (mode === "partial-phantom") original.affected_files.push({ path: "src/missing.ts" });
  const inputPath = join(harness.REPO_DIR, "original-audit.json");
  const originals: Finding[] = twoCanonical ? [original, { ...original, id: "COR-secondary", lens: "tests", severity: "medium",
    evidence: ["src/input.ts:1 independently confirmed by the tests lens"] }] : [original];
  const fixture = buildQuestionAuditReportFixture(originals);
  const wire = JSON.stringify(fixture.report);
  const expected = (JSON.parse(wire) as { findings: Finding[] }).findings;
  const originalFinding = expected.find(finding => finding.id === fixture.ids.get(original.id))!;
  expect(originalFinding?.affected_files.map(file => file.path).sort())
    .toEqual(original.affected_files.map(file => file.path).sort());
  await writeFile(inputPath, wire);
  await harness.writeReadyStructuredAuditIntake(inputPath);
  if (mode === "partial-phantom") await rm(join(harness.REPO_DIR, "src/missing.ts"));
  const originalInput = await readFile(inputPath, "utf8");

  expect((await decideNextStep({ root: harness.REPO_DIR })).step_kind).toBe("collect_review_approval");
  await harness.approveReviewGate();
  expect((await decideNextStep({ root: harness.REPO_DIR })).step_kind).toBe("contract_pipeline");

  // The real pre-review filter grounds evidence on cloned survivors. That
  // annotation must not become a replacement for the original source payload.
  const source = (await readPlanSource(harness.ARTIFACTS_DIR))!;
  expect(source.findings).toEqual(expect.arrayContaining(expected));
  expect(source.findings).toHaveLength(expected.length);
  expect(source.findings.every(finding => !("evidence_grounded" in finding))).toBe(true);
  expect(await readFile(inputPath, "utf8")).toBe(originalInput);

  await harness.writeApprovedExecutionPlan();
  expect((await decideNextStep({ root: harness.REPO_DIR, planOnly: true, finalGateRunner: harness.finalGateRunner })).step_kind)
    .toBe("operator_paused");
  const state = (await new StateStore(harness.ARTIFACTS_DIR).loadState())!;
  expect(state.plan?.findings).toEqual(expect.arrayContaining(expected));
  expect(state.plan?.findings).toHaveLength(expected.length);
  for (const finding of expected) {
    expect(state.plan_coverage?.entries.find(entry => entry.finding?.id === finding.id)?.finding).toEqual(finding);
  }
  if (mode === "partial-phantom") {
    expect(state.plan_coverage?.entries.find(entry => entry.finding?.id === originalFinding.id)?.phantom_paths_removed)
      .toEqual(["src/missing.ts"]);
  }
  for (const item of Object.values(state.items ?? {})) item.status = "resolved";
  const report = buildRemediationOutcomesReport(state, {
    contract_version: "remediate-code-closing-result/v1alpha1", action: "none", status: "skipped", commands: [],
  });
  const roundtrip = RemediationOutcomesReportSchema.parse(JSON.parse(JSON.stringify(report)));
  expect(roundtrip.outcomes).toHaveLength(expected.length);
  for (const finding of expected) {
    expect(roundtrip.outcomes.find(outcome => outcome.finding_id === finding.id))
      .toMatchObject({ finding_id: finding.id, outcome: "resolved", finding });
  }
});
});
