import { beforeEach, afterEach, expect, test } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { executionPlanPaths, readCanonicalPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import { writeJsonFile } from "../../src/shared/index.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { applyGuidanceText } from "../../src/shared/intake/guidanceBootstrap.js";
const h=createNextStepHarness(".test-executable-plan-integration");beforeEach(h.resetTestRepo);afterEach(h.cleanupTestRepo);
test("a planning continuation cannot bypass the confirmed intent checkpoint",async()=>{
 await h.writeApprovedExecutionPlan();const step=await decideNextStep({root:h.REPO_DIR,artifactsDir:h.ARTIFACTS_DIR});expect(step.step_kind).toBe("confirm_intent");
});
test("a confirmed source request yields a bounded dependency-ready host workload after review",async()=>{
 await h.writeIntentCheckpoint();await h.writeApprovedExecutionPlan();const step=await decideNextStep({root:h.REPO_DIR,artifactsDir:h.ARTIFACTS_DIR});expect(step.step_kind).toBe("dispatch_implement");
 const workload=JSON.parse(await readFile(step.artifact_paths.host_workload!,"utf8"));expect(workload.work_items).toHaveLength(1);expect(workload.work_items[0].source_finding_ids).toEqual([]);expect(workload.work_items[0].obligation_ids).toEqual(["REQ-auth"]);
 const state=await new StateStore(h.ARTIFACTS_DIR).loadState();expect(state?.plan?.findings).toEqual([]);
});
test("changing approval's owner decision invalidates the approval instead of authorizing a broader dispatch",async()=>{
 await h.writeIntentCheckpoint();await h.writeApprovedExecutionPlan();const canonical=(await readCanonicalPlan(h.ARTIFACTS_DIR))!;
 await writeJsonFile(join(executionPlanPaths(h.ARTIFACTS_DIR).directory,"owner-decision.json"),{revision_sha256:canonical.revision_sha256,confirmed_by:"host",approved_unit_ids:[],declined_units:canonical.plan.units.map(unit=>({id:unit.id,reason:"Declined"}))});
 const step=await decideNextStep({root:h.REPO_DIR,artifactsDir:h.ARTIFACTS_DIR});expect(step.step_kind).toBe("contract_pipeline");
});
test("a source-only planning continuation takes precedence over an older completed report", async () => {
  await h.writeIntentCheckpoint();
  const report = join(h.REPO_DIR, ".audit-tools", "remediation-report.md");
  await writeFile(report, "# Previous completed remediation\n");
  const input = join(h.REPO_DIR, "new-request.md");
  await writeFile(input, "Implement the newly confirmed request.\n");
  await buildNextContractPipelineStep({ root: h.REPO_DIR, artifactsDir: h.ARTIFACTS_DIR, runId: "SOURCE-only", sourcePaths: [input] });
  expect(await readCanonicalPlan(h.ARTIFACTS_DIR)).toBeUndefined();
  const sourcePath = executionPlanPaths(h.ARTIFACTS_DIR).source;
  const sourceBefore = await readFile(sourcePath, "utf8");
  const step = await decideNextStep({ root: h.REPO_DIR, artifactsDir: h.ARTIFACTS_DIR });
  expect(step.step_kind).toBe("contract_pipeline");
  expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
  expect(await readFile(report, "utf8")).toBe("# Previous completed remediation\n");
});
test.each(["different-input", "same-input", "new-guidance"] as const)("bound source planning handles %s without replacing its agreed request", async mode => {
  await h.writeIntentCheckpoint();
  const input = join(h.REPO_DIR, "agreed-request.md");
  const changedInput = join(h.REPO_DIR, "different-request.md");
  await writeFile(input, "Implement the original agreed request.\n");
  await writeFile(changedInput, "Implement a materially different request.\n");
  await buildNextContractPipelineStep({ root: h.REPO_DIR, artifactsDir: h.ARTIFACTS_DIR, runId: "SOURCE-bound", sourcePaths: [input] });
  const sourcePath = executionPlanPaths(h.ARTIFACTS_DIR).source;
  const sourceBefore = await readFile(sourcePath, "utf8");
  const step = await decideNextStep({ root: h.REPO_DIR, artifactsDir: h.ARTIFACTS_DIR,
    ...(mode === "new-guidance" ? { guidanceFileSupplied: true } : { input: mode === "same-input" ? input : changedInput }),
  });
  expect(step.step_kind).toBe(mode === "same-input" ? "contract_pipeline" : "input_conflict");
  expect(await readFile(sourcePath, "utf8")).toBe(sourceBefore);
  expect(await new StateStore(h.ARTIFACTS_DIR).loadState()).toBeNull();
});
test("new literal guidance cannot overwrite the bound conversation source before refusing it", async () => {
  await h.writeIntentCheckpoint();
  const input = applyGuidanceText(h.ARTIFACTS_DIR, "Keep the original requested behavior.");
  await buildNextContractPipelineStep({ root: h.REPO_DIR, artifactsDir: h.ARTIFACTS_DIR, runId: "SOURCE-guidance", sourcePaths: [input] });
  const before = await readFile(input, "utf8");
  const step = await decideNextStep({ root: h.REPO_DIR, artifactsDir: h.ARTIFACTS_DIR,
    guidanceText: "Replace the original behavior with a different feature.", guidanceFileSupplied: true,
  });
  expect(await readFile(input, "utf8")).toBe(before);
  expect(step.step_kind).toBe("input_conflict");
});
