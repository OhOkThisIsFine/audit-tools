import { beforeEach, afterEach, expect, test } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { detectProjectFacts } from "../../src/shared/tooling/projectFacts.js";
import { writeProjectFacts } from "../../src/remediate/intake.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { StateStore } from "../../src/remediate/state/store.js";
const h=createNextStepHarness(".test-reviewed-command-defaults");beforeEach(h.resetTestRepo);afterEach(h.cleanupTestRepo);
test("approved executable-plan activation carries the target repository's declared verification commands",async()=>{
 await writeFile(join(h.REPO_DIR,"package.json"),JSON.stringify({name:"fixture",scripts:{test:"node --test",e2e:"node --test e2e.js"}}));await h.writeIntentCheckpoint();await writeProjectFacts(h.ARTIFACTS_DIR,await detectProjectFacts(h.REPO_DIR));await h.writeApprovedExecutionPlan();
 await decideNextStep({root:h.REPO_DIR,artifactsDir:h.ARTIFACTS_DIR,planOnly:true});const state=await new StateStore(h.ARTIFACTS_DIR).loadState();expect(state?.plan?.test_command).toBeTruthy();expect(state?.plan?.test_command_source).toBe("project_facts");expect(state?.plan?.e2e_command).toBeTruthy();
});
