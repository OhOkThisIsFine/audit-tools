import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratch.js";
import { canonicalPlanFixture, writeApprovedPlanFixture } from "./helpers/canonicalPlanFixture.js";
import { makeState } from "./test-helpers.js";
import { runClosePhase } from "../../src/remediate/phases/close.js";
const root=scratchDir("request-outcomes");
const artifactsDir=join(root,".audit-tools","remediation");
beforeEach(async()=>{await mkdir(artifactsDir,{recursive:true});await writeFile(join(artifactsDir,"diagnostic.txt"),"preserve when unfinished");});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
describe("request-only disposition survives real close",()=>{
 for(const status of ["deferred","already_satisfied"] as const) it(status,async()=>{
  const disposition={status,reason:status==="deferred"?"Waiting for the owner dependency":"The route already exists",evidence:["Reviewed the requested route against current source"]};
  const state=makeState({status:"closing",plan:canonicalPlanFixture({request:{id:"R1",text:"Add route",source_paths:[]},request_disposition:disposition,candidate_closing_actions:["none"]}),items:{},closing_plan:{action:"none"}});
  await writeApprovedPlanFixture(artifactsDir, state, root);
  await runClosePhase(state,{root,artifactsDir,skipFinalGate:true});
  const report=JSON.parse(await readFile(join(root,".audit-tools","remediation-outcomes.json"),"utf8"));
  expect(report.request_disposition).toEqual(disposition);
  expect(report.request_outcome).toMatchObject({status,reason:disposition.reason,evidence:disposition.evidence});
  expect(report.outcomes).toEqual([]);
  const markdown=await readFile(join(root,".audit-tools","remediation-report.md"),"utf8");
  expect(markdown).toContain(disposition.reason);
  if(status==="deferred") {
   expect(existsSync(join(artifactsDir,"diagnostic.txt"))).toBe(true);
   expect(JSON.parse(await readFile(join(root,".audit-tools","verification_report.json"),"utf8")).overall_status).toBe("failed");
  }
 });
});

describe("owner request disposition", () => {
  it("owner-declined request work reports the tool-owned ignored decision",async()=>{
   const {canonicalUnitFixture}=await import("./helpers/canonicalPlanFixture.js");
   const unit=canonicalUnitFixture("U1");
   const plan=canonicalPlanFixture({request:{id:"R1",text:"Add route",source_paths:[]},units:[unit],requirements:[{id:"REQ-U1",description:"Add requested route",source_finding_ids:[],change_kind:"structural",assertions:[]}],candidate_closing_actions:["none"]});
   const state=makeState({status:"closing",plan,items:{U1:{unit_id:"U1",status:"ignored",failure_reason:"Owner declined this unit"}},closing_plan:{action:"none"}});
   await writeApprovedPlanFixture(artifactsDir, state, root);
   await runClosePhase(state,{root,artifactsDir,skipFinalGate:true});
   const report=JSON.parse(await readFile(join(root,".audit-tools","remediation-outcomes.json"),"utf8"));
   expect(report.request_outcome).toMatchObject({status:"ignored"});
   expect(report.execution_outcomes[0]).toMatchObject({status:"ignored",reason:"Owner declined this unit"});
   expect(JSON.parse(await readFile(join(root,".audit-tools","verification_report.json"),"utf8")).overall_status).toBe("passed");
   expect(existsSync(join(artifactsDir,"diagnostic.txt"))).toBe(false);
  });
});
