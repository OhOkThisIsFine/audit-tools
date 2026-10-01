import { afterEach, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import { createExecutablePlanFixture, approveExecutablePlanFixture } from "./helpers/executablePlanFixture.js";
import { readApprovedExecutionPlan } from "../../src/remediate/contractPipeline/executionPlan.js";
import type { Finding } from "../../src/shared/types/finding.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const finding:Finding={id:"F-source",title:"Repair greeting",summary:"The greeting returns wrong text",category:"correctness",lens:"correctness",severity:"low",confidence:"high",affected_files:[{path:"greeting.ts"}],evidence:["Wrong greeting"]};
test.each(["conversation","audit"])("%s uses the same reviewed executable-plan engine",async kind=>{
 const f=await createExecutablePlanFixture(kind==="audit"?[finding]:[]);roots.push(f.root);await approveExecutablePlanFixture(f);
 const approved=await readApprovedExecutionPlan(f.artifactsDir);expect(approved?.canonical.plan.units).toHaveLength(1);
 expect(approved?.source.findings).toEqual(kind==="audit"?[finding]:[]);
});
