import { beforeEach, afterEach, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
import { readCanonicalPlan, executionPlanPaths } from "../../src/remediate/contractPipeline/executionPlan.js";
import { writeJsonFile } from "../../src/shared/index.js";
const h=createNextStepHarness(".test-reviewed-plan-dispatch");
beforeEach(async()=>{await h.resetTestRepo();await h.writeIntentCheckpoint();});afterEach(h.cleanupTestRepo);
test("next-step activates the exact reviewed execution units with no operational findings",async()=>{
 await h.writeApprovedExecutionPlan();
 const canonical=(await readCanonicalPlan(h.ARTIFACTS_DIR))!;
 const step=await decideNextStep({root:h.REPO_DIR,artifactsDir:h.ARTIFACTS_DIR,planOnly:true});
 expect(step.step_kind).not.toBe("contract_pipeline");
 const state=await new StateStore(h.ARTIFACTS_DIR).loadState();
 expect(state?.plan?.findings).toEqual([]);expect(state?.plan?.units).toEqual(canonical.plan.units);
 expect(Object.keys(state?.items??{})).toEqual(canonical.plan.units.map(unit=>unit.id));
});
test("a changed semantic plan cannot silently dispatch under an earlier approval",async()=>{
 await h.writeApprovedExecutionPlan();const canonical=(await readCanonicalPlan(h.ARTIFACTS_DIR))!;const paths=executionPlanPaths(h.ARTIFACTS_DIR);
 await writeJsonFile(paths.submission,{base_revision_sha256:canonical.revision_sha256,plan:{...canonical.plan,objective:"A materially different objective"},retired_requirements:[]});
 const step=await decideNextStep({root:h.REPO_DIR,artifactsDir:h.ARTIFACTS_DIR});
 expect(step.step_kind).toBe("contract_pipeline");expect(step.step_kind).not.toBe("dispatch_implement");
});
test("scope changed in the confirmed checkpoint invalidates activation",async()=>{
 await h.writeApprovedExecutionPlan();const checkpoint=join(h.ARTIFACTS_DIR,"intent_checkpoint.json");const prior=JSON.parse(await readFile(checkpoint,"utf8"));await writeJsonFile(checkpoint,{...prior,must_not_touch:["src/**"]});
 const step=await decideNextStep({root:h.REPO_DIR,artifactsDir:h.ARTIFACTS_DIR});expect(step.step_kind).not.toBe("dispatch_implement");
});
