import { scratchDir } from "../helpers/scratch.js";
import { RemediationOutcomesReportSchema, REMEDIATION_OUTCOMES_CONTRACT_VERSION } from "../../src/shared/types/remediationOutcome.js";
import { describe, it, expect } from "vitest";
import { buildRemediationOutcomesReport, buildRemediationReportMarkdown, buildVerificationReport } from "../../src/remediate/phases/close.js";
import { canonicalPlanFixture, canonicalUnitFixture } from "./helpers/canonicalPlanFixture.js";
import type { RemediationState } from "../../src/remediate/state/store.js";

const finding = (id: string) => ({ id, title: id, summary: id, lens: "correctness", category: "correctness", severity: "high" as const, confidence: "high" as const, affected_files: [{path:"src/a.ts"}] });
const closing = { contract_version: "remediate-code-closing-result/v1alpha1" as const, action: "none" as const, status: "skipped" as const, commands: [] };
function report(sourceIds: string[], units: Array<{id:string;sources:string[];status:"resolved"|"blocked"|"ignored"|"pending"}>) {
 const plan = canonicalPlanFixture({ findings: sourceIds.map(finding), units: units.map(u => canonicalUnitFixture(u.id,{source_finding_ids:u.sources})) });
 return buildRemediationOutcomesReport({status:"closing",plan,items:Object.fromEntries(units.map(u=>[u.id,{unit_id:u.id,status:u.status}]))} as RemediationState, closing);
}
describe("source outcomes derive from all canonical execution units",()=>{
 it("one blocked required unit keeps the original source blocked",()=>{
  const result=report(["F1"],[{id:"U1",sources:["F1"],status:"resolved"},{id:"U2",sources:["F1"],status:"blocked"}]);
  expect(result.outcomes).toHaveLength(1);
  expect(result.outcomes[0]?.finding_id).toBe("F1");
  expect(result.outcomes[0]?.outcome).toBe("blocked");
 });
 it("partial resolution plus an ignored unit is not source success",()=>{
  expect(report(["F1"],[{id:"U1",sources:["F1"],status:"resolved"},{id:"U2",sources:["F1"],status:"ignored"}]).outcomes[0]?.outcome).toBe("ignored");
 });
 it("an unlinked source never passes an empty all-units check",()=>{
  expect(report(["F1"],[]).outcomes[0]?.outcome).toBe("blocked");
 });
 it("a source-free request reports completed units without inventing findings",()=>{
  const result=report([],[{id:"U1",sources:[],status:"resolved"}]);
  expect(result.outcomes).toEqual([]);
  expect(result.execution_outcomes).toEqual([expect.objectContaining({unit_id:"U1",status:"resolved",source_finding_ids:[]})]);
 });
 it("a shared completed unit reports each immutable original source once",()=>{
  const result=report(["F1","F2"],[{id:"U1",sources:["F1","F2"],status:"resolved"}]);
  expect(result.outcomes.map(o=>[o.finding_id,o.outcome])).toEqual([["F1","resolved"],["F2","resolved"]]);
  expect(result.execution_outcomes).toHaveLength(1);
 });
});

describe("execution-unit outcome contract", () => {
  it("unfinished runnable units remain pending rather than blocked",()=>{
   expect(report(["F1"],[{id:"U1",sources:["F1"],status:"resolved"},{id:"U2",sources:["F1"],status:"pending"}]).outcomes[0]?.outcome).toBe("pending");
  });

  it("emits the v2 wire contract and refuses the retired version",()=>{
   const result=report(["F1"],[{id:"U1",sources:["F1"],status:"resolved"}]);
   expect(result.contract_version).toBe(REMEDIATION_OUTCOMES_CONTRACT_VERSION);
   expect(RemediationOutcomesReportSchema.safeParse(result).success).toBe(true);
   expect(RemediationOutcomesReportSchema.safeParse({...result,contract_version:"remediate-code-outcomes/v1alpha1"}).success).toBe(false);
  });

  it("source-free report and verification preserve real execution-unit results",()=>{
   const state={status:"closing",closing_plan:{action:"none"},plan:canonicalPlanFixture({units:[canonicalUnitFixture("U1",{title:"Add the requested route"})]}),items:{U1:{unit_id:"U1",status:"resolved",host_result_evidence:["Route test passes"]}}} as RemediationState;
   const outcomes=buildRemediationOutcomesReport(state,closing);
   const combined={passed:true,ran:true,suite_name:"route tests",duration_ms:1,output:""};
   const markdown=buildRemediationReportMarkdown(state,{resolved:[],verifiedNoChange:[],ignored:[],inappropriate:[],blocked:[]},closing,undefined,outcomes,combined);
   expect(markdown).toContain("U1");
   expect(markdown).toContain("Add the requested route");
   expect(markdown).toContain("1 verified complete");
   const verification=buildVerificationReport(state,{root:scratchDir("unit-source-root"),artifactsDir:scratchDir("unit-source-artifacts")},closing,combined);
   expect(verification.findings).toEqual([]);
   expect(verification.units).toEqual([expect.objectContaining({unit_id:"U1",overall_status:"passed"})]);
  });
});
