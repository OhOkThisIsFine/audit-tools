import { createExecutablePlanFixture, approveExecutablePlanFixture } from "./helpers/executablePlanFixture.js";
import { afterEach, expect, test } from "vitest";
import { rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readOptionalJsonFile, writeJsonFile } from "../../src/shared/index.js";
import { buildNextContractPipelineStep } from "../../src/remediate/steps/contractPipeline.js";
import { readCanonicalPlan, ingestExecutionPlan, readApprovedExecutionPlan } from "../../src/remediate/contractPipeline/executionPlan.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() { const value = await createExecutablePlanFixture(); roots.push(value.root); return value; }
const approve = approveExecutablePlanFixture;

test("an unrelated requirement insertion preserves IDs and assertions instead of positional obligation identity", async () => {
  const f = await fixture(); const before = (await readCanonicalPlan(f.artifactsDir))!;
  const added = { ...f.plan.requirements[0]!, id: "REQ-other", description: "An unrelated new requirement" };
  const plan = { ...f.plan, requirements: [added, ...f.plan.requirements], units: [{ ...f.plan.units[0]!, requirement_ids: [added.id, ...f.plan.units[0]!.requirement_ids] }] };
  await writeJsonFile(f.paths.submission, { base_revision_sha256: before.revision_sha256, plan, retired_requirements: [] });
  expect((await ingestExecutionPlan(f.options)).issues).toEqual([]);
  expect((await readCanonicalPlan(f.artifactsDir))?.plan.requirements.find(requirement => requirement.id === "REQ-greeting")).toEqual(f.plan.requirements[0]);
});

test("approved conversation plan is immediately executable without synthetic findings or post-judge planning", async () => {
  const f = await fixture(); await approve(f);
  const approved = await readApprovedExecutionPlan(f.artifactsDir);
  expect(approved?.source.findings).toEqual([]);
  expect(approved?.canonical.plan.units).toEqual(f.plan.units);
  expect(await buildNextContractPipelineStep(f.options)).toBeNull();
});

test("approval of revision R cannot activate revision R+1", async () => {
  const f = await fixture(); await approve(f);
  const before = (await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(f.paths.submission, { base_revision_sha256: before.revision_sha256, plan: { ...f.plan, objective: "Changed objective" }, retired_requirements: [] });
  expect((await ingestExecutionPlan(f.options)).issues).toEqual([]);
  expect(await readApprovedExecutionPlan(f.artifactsDir)).toBeUndefined();
});

test("stale base submission cannot replace the accepted canonical plan", async () => {
  const f = await fixture(); const before = (await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(f.paths.submission, { base_revision_sha256: null, plan: { ...f.plan, objective: "Stale edit" }, retired_requirements: [] });
  expect((await ingestExecutionPlan(f.options)).issues.join(" ")).toMatch(/stale/);
  expect(await readCanonicalPlan(f.artifactsDir)).toEqual(before);
});

test("accepted unit freezes its requirement semantics, not merely its array of IDs", async () => {
  const f = await fixture(); const before = (await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(f.paths.submission, { base_revision_sha256: before.revision_sha256, plan: { ...f.plan, requirements: [{ ...f.plan.requirements[0]!, description: "A different behavior" }] }, retired_requirements: [] });
  expect((await ingestExecutionPlan({ ...f.options, acceptedUnits: new Map([[f.plan.units[0]!.id, f.plan.units[0]!]]) })).issues.join(" ")).toMatch(/already evidenced/);
});

test("changing original request bytes invalidates activation even when source.json is untouched", async () => {
  const f = await fixture(); await approve(f);
  await writeFile(f.input, "A different request");
  expect(await readApprovedExecutionPlan(f.artifactsDir)).toBeUndefined();
});

test("an empty conversation plan needs an evidence-backed request disposition", async () => {
  const f = await fixture(); const before = (await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(f.paths.submission, { base_revision_sha256: before.revision_sha256, plan: { ...f.plan, units: [], requirements: [] }, retired_requirements: [{ id: "REQ-greeting", reason: "No work", replaced_by: [] }] });
  expect((await ingestExecutionPlan(f.options)).issues.join(" ")).toMatch(/request disposition/);
});

test("silently renaming an unchanged requirement is refused", async () => {
  const f = await fixture(); const before = (await readCanonicalPlan(f.artifactsDir))!;
  const renamed = { ...f.plan, requirements: [{ ...f.plan.requirements[0]!, id: "REQ-renamed" }], units: [{ ...f.plan.units[0]!, requirement_ids: ["REQ-renamed"] }] };
  await writeJsonFile(f.paths.submission, { base_revision_sha256: before.revision_sha256, plan: renamed, retired_requirements: [] });
  expect((await ingestExecutionPlan(f.options)).issues.join(" ")).toMatch(/disappeared/);
});

test("declared dependency cycles are refused before independent review", async () => {
  const f=await fixture();const before=(await readCanonicalPlan(f.artifactsDir))!;
  const first={...f.plan.units[0]!,dependencies:["UNIT-second"]};
  const second={...f.plan.units[0]!,id:"UNIT-second",dependencies:[first.id]};
  await writeJsonFile(f.paths.submission,{base_revision_sha256:before.revision_sha256,plan:{...f.plan,units:[first,second]},retired_requirements:[]});
  expect((await ingestExecutionPlan(f.options)).issues.join(" ")).toMatch(/cycle/);
});

test("an accepted counterexample must survive repair and gets fresh independent judgment",async()=>{
  const f=await fixture();const before=(await readCanonicalPlan(f.artifactsDir))!;
  await writeJsonFile(join(f.paths.directory,"owner-decision.json"),{revision_sha256:before.revision_sha256,confirmed_by:"host",approved_unit_ids:f.plan.units.map(unit=>unit.id),declined_units:[]});
  for(const role of ["critique","critic","judge"] as const){
    await buildNextContractPipelineStep(f.options);
    const request=(await readOptionalJsonFile<{prompt_sha256:string}>(f.paths.review(role).request))!;
    const result=role==="critique"?{verdict:"approved",issues:[]}:role==="critic"?{counterexamples:[{id:"CE-empty",claim:"Greeting handles empty names",reproduction_steps:["Pass an empty name"],expected:"Explicit handling",actual:"Unspecified",requirement_ids:["REQ-greeting"],unit_ids:["UNIT-greeting"]}]}:{verdict:"needs_repair",classifications:[{counterexample_id:"CE-empty",classification:"accepted",rationale:"Missing case"}],requirement_assessments:[{requirement_id:"REQ-greeting",verdict:"insufficient",evidence:["No empty-input assertion"]}],disposition_assessments:[]};
    await writeJsonFile(f.paths.review(role).submission,{contract_version:"review-submission/v1",prompt_sha256:request.prompt_sha256,review:{mode:"independent",reason:"Separate critic"},result});
  }
  const repair=await buildNextContractPipelineStep(f.options);
  expect(repair).not.toBeNull();expect(await readApprovedExecutionPlan(f.artifactsDir)).toBeUndefined();
  await writeJsonFile(f.paths.submission,{base_revision_sha256:before.revision_sha256,plan:f.plan,retired_requirements:[]});
  expect((await ingestExecutionPlan(f.options)).issues.join(" ")).toMatch(/CE-empty/);
  f.plan={...f.plan,units:[{...f.plan.units[0]!,addresses_counterexample_ids:["CE-empty"]}],requirements:[{...f.plan.requirements[0]!,assertions:[...f.plan.requirements[0]!.assertions,{kind:"negative",description:"Empty names produce a bounded error",scope_paths:["greeting.ts"]}]}]};
  await writeJsonFile(f.paths.submission,{base_revision_sha256:before.revision_sha256,plan:f.plan,retired_requirements:[]});
  expect((await ingestExecutionPlan(f.options)).issues).toEqual([]);
  await approve(f);
  expect((await readApprovedExecutionPlan(f.artifactsDir))?.canonical.plan.units[0]?.addresses_counterexample_ids).toEqual(["CE-empty"]);
});

test("an interruption after canonical acceptance replays the same author submission idempotently",async()=>{
 const f=await fixture();const canonical=(await readCanonicalPlan(f.artifactsDir))!;
 await writeJsonFile(f.paths.submission,{base_revision_sha256:null,plan:f.plan,retired_requirements:[]});
 expect(await ingestExecutionPlan(f.options)).toEqual({changed:false,issues:[]});
 expect(await readCanonicalPlan(f.artifactsDir)).toEqual(canonical);
});

test("changed confirmed scope returns one actionable pause instead of replaying unusable approval", async () => {
  const f = await fixture(); await approve(f);
  await writeJsonFile(join(f.artifactsDir, "intent_checkpoint.json"), {
    schema_version: "intent-checkpoint/v1", confirmed_at: new Date().toISOString(), confirmed_by: "host",
    scope_summary: "Documentation only", intent_summary: "Do not edit the greeting", excluded_scope: [{ path: "greeting.ts", reason: "Owner excluded code edits" }],
  });
  const step = await buildNextContractPipelineStep(f.options);
  expect(step).not.toBeNull();
  expect(step?.status).toBe("blocked");
  if (step) expect(await readFile(step.prompt_path, "utf8")).toMatch(/scope|intent/i);
  expect(await readApprovedExecutionPlan(f.artifactsDir)).toBeUndefined();
});
