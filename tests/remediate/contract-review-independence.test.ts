import { afterEach, expect, test } from "vitest";
import { rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFile, readOptionalJsonFile } from "../../src/shared/index.js";
import { createExecutablePlanFixture } from "./helpers/executablePlanFixture.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { readCanonicalPlan, readPlanReview } from "../../src/remediate/contractPipeline/executionPlan.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(){const f=await createExecutablePlanFixture(); roots.push(f.root);const canonical=(await readCanonicalPlan(f.artifactsDir))!;await writeJsonFile(join(f.paths.directory,"owner-decision.json"),{revision_sha256:canonical.revision_sha256,confirmed_by:"host",approved_unit_ids:f.plan.units.map(unit=>unit.id),declined_units:[]});await buildNextContractPipelineStep(f.options);return {...f,canonical,request:(await readOptionalJsonFile<{prompt_sha256:string}>(f.paths.review("critique").request))!};}
test("raw, stale, unavailable and self-reviewed independent submissions cannot approve",async()=>{
 for(const mode of ["raw","stale","unavailable","degraded"]){const f=await fixture();await writeJsonFile(f.paths.review("critique").submission,mode==="raw"?{verdict:"approved",issues:[]}:{contract_version:"review-submission/v1",prompt_sha256:mode==="stale"?"a".repeat(64):f.request.prompt_sha256,review:{mode:mode==="stale"?"independent":mode,reason:"fixture"},result:{verdict:"approved",issues:[]}});const step=await buildNextContractPipelineStep(f.options);expect(step).not.toBeNull();expect(await readPlanReview(f.artifactsDir,"critique",f.canonical.revision_sha256)).toBeUndefined();}
});
test("review explicitly permits bounded source inspection instead of only authored summaries",async()=>{const f=await fixture();const step=await buildNextContractPipelineStep(f.options);const prompt=await readFile(step!.prompt_path,"utf8");expect(prompt).toContain("may inspect the affected repository files");expect(prompt).toContain("independent context");});
