import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildAuditFindingsDeliverable, type Finding } from "../../src/shared/index.js";
import { RemediationOutcomesReportSchema } from "../../src/shared/types/remediationOutcome.js";
import { readPlanSource } from "../../src/remediate/contractPipeline/executionPlan.js";
import { buildRemediationOutcomesReport } from "../../src/remediate/phases/close.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";

const harness = createNextStepHarness(".test-path-a-source-provenance");
beforeEach(async () => { await harness.resetTestRepo(); });
afterEach(async () => { await harness.cleanupTestRepo(); });

describe("original source provenance through Path-A filtering and reviewed execution", () => {
test.each(["singleton", "dedup", "partial-phantom"])("real Path-A filtering preserves original findings through reviewed source and outcome roundtrip (%s)", async mode => {
  const dedup = mode === "dedup";
  const original: Finding = {
    id: "COR-original", title: "Reject invalid input", category: "correctness", severity: "high", confidence: "high",
    lens: "correctness", summary: "The local input boundary accepts an invalid value.",
    affected_files: [{ path: "src/input.ts" }], evidence: ["src/input.ts:1 accepts the input"],
  };
  if (mode === "partial-phantom") original.affected_files.push({ path: "src/missing.ts" });
  const inputPath = join(harness.REPO_DIR, "original-audit.json");
  const originals: Finding[] = dedup ? [original, { ...original, id: "COR-secondary", lens: "tests", severity: "medium",
    evidence: ["src/input.ts:1 independently confirmed by the tests lens"] }] : [original];
  await writeFile(inputPath, JSON.stringify(buildAuditFindingsDeliverable(originals, null)));
  await harness.writeReadyStructuredAuditIntake(inputPath);
  if (mode === "partial-phantom") await rm(join(harness.REPO_DIR, "src/missing.ts"));
  const originalInput = await readFile(inputPath, "utf8");

  expect((await decideNextStep({ root: harness.REPO_DIR })).step_kind).toBe("collect_review_approval");
  await harness.approveReviewGate();
  expect((await decideNextStep({ root: harness.REPO_DIR })).step_kind).toBe("contract_pipeline");

  // The real pre-review filter grounds evidence on cloned survivors. That
  // annotation must not become a replacement for the original source payload.
  const source = (await readPlanSource(harness.ARTIFACTS_DIR))!;
  expect(source.findings).toEqual([original]);
  expect(source.findings[0]).not.toHaveProperty("evidence_grounded");
  expect(await readFile(inputPath, "utf8")).toBe(originalInput);

  await harness.writeApprovedExecutionPlan();
  expect((await decideNextStep({ root: harness.REPO_DIR, planOnly: true, finalGateRunner: harness.finalGateRunner })).step_kind)
    .toBe("operator_paused");
  const state = (await new StateStore(harness.ARTIFACTS_DIR).loadState())!;
  expect(state.plan?.findings).toEqual([original]);
  expect(state.plan_coverage?.entries[0]?.finding).toEqual(original);
  if (mode === "partial-phantom") expect(state.plan_coverage?.entries[0]?.phantom_paths_removed).toEqual(["src/missing.ts"]);
  for (const item of Object.values(state.items ?? {})) item.status = "resolved";
  const report = buildRemediationOutcomesReport(state, {
    contract_version: "remediate-code-closing-result/v1alpha1", action: "none", status: "skipped", commands: [],
  });
  const roundtrip = RemediationOutcomesReportSchema.parse(JSON.parse(JSON.stringify(report)));
  expect(roundtrip.outcomes).toHaveLength(originals.length);
  expect(roundtrip.outcomes.find(outcome => outcome.finding_id === original.id))
    .toMatchObject({ finding_id: original.id, outcome: "resolved", finding: original });
  if (dedup) expect(roundtrip.outcomes.find(outcome => outcome.finding_id === "COR-secondary"))
    .toMatchObject({ outcome: "ignored", finding: originals[1] });
});
});
