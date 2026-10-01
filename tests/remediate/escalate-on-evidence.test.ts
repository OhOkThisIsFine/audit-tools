import { afterEach, expect, test } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createExecutablePlanFixture } from "./helpers/executablePlanFixture.js";
import { resolveAdversarialDepth } from "../../src/remediate/steps/contractPipeline.js";
import { computeIntakeRiskSignal, writeIntakeRiskSignal } from "../../src/remediate/riskSignal.js";
import { readCanonicalPlan, ingestExecutionPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import { writeJsonFile } from "../../src/shared/index.js";
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
test("new executable write scope raises risk before review and never lowers it",async()=>{
 const f=await createExecutablePlanFixture();roots.push(f.root);await writeIntakeRiskSignal(f.artifactsDir,computeIntakeRiskSignal({affectedFiles:["greeting.ts"],goals:["Greeting"]}));
 const previous=(await readCanonicalPlan(f.artifactsDir))!;await mkdir(join(f.root,"src","shared"),{recursive:true});await writeFile(join(f.root,"src","shared","greeting.ts"),"export {};\n");
 await writeJsonFile(f.paths.submission,{base_revision_sha256:previous.revision_sha256,plan:{...f.plan,units:[{...f.plan.units[0]!,allowed_files:["src/shared/greeting.ts"]}]},retired_requirements:[]});
 expect((await ingestExecutionPlan(f.options)).issues).toEqual([]);expect((await resolveAdversarialDepth(f.artifactsDir)).riskSignal?.tier).toBe("high");
});
