import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPlanFixture, canonicalUnitFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { prepareRemediationHostHandoff } from "../../src/remediate/steps/dispatch/hostHandoff.js";
import { REMEDIATION_STATE_CONTRACT_VERSION } from "../../src/remediate/state/store.js";
test("workload carries reviewed affected interfaces, requirements and counterexamples verbatim",async()=>{
 const root=await mkdtemp(join(tmpdir(),"reviewed-work-item-"));try{
 const artifactsDir=join(root,".audit-tools","remediation");
 const example={id:"CE-retry",claim:"Retry is idempotent",reproduction_steps:["Retry the same request"],expected:"One effect",actual:"Two effects",requirement_ids:["REQ-U"],unit_ids:["U"]};
 const unit=canonicalUnitFixture("U",{affected_interfaces:[{name:"retry",description:"One effect for a repeated key"}],addresses_counterexample_ids:[example.id]});
 const state={contract_version:REMEDIATION_STATE_CONTRACT_VERSION,status:"implementing" as const,plan:canonicalPlanFixture({units:[unit],requirements:[{id:"REQ-U",description:"Retry safely",source_finding_ids:[],change_kind:"addition" as const,assertions:[{kind:"positive" as const,description:"One effect",scope_paths:["src/a.ts"]}]}],review_counterexamples:[example]}),items:{U:{unit_id:"U",status:"pending" as const}}};
 await writeApprovedPlanFixture(artifactsDir,state);
 const handoff=await prepareRemediationHostHandoff({root,artifactsDir,runId:state.plan.plan_id,baselineCommit:"a".repeat(40),state});
 if(typeof handoff==="string")throw new Error(handoff);
 const prompt=handoff.workload.work_items[0]!.prompt.text;
 expect(prompt).toContain("One effect for a repeated key");expect(prompt).toContain("Retry the same request");expect(prompt).toContain("Two effects");expect(prompt).toContain("REQ-U");
 }finally{await rm(root,{recursive:true,force:true});}
});
