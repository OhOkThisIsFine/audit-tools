import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout, "dist", file)).href);

test("a plan replays without change and closes only after approval and a verified fixture edit", async t => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "plan-contract-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("plan-contract-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const artifactsDir = join(root, ".audit-tools", "remediation");
  const options = { root, artifactsDir };
  const { executionPlanPaths, ingestExecutionPlan, readCanonicalPlan } = await load("remediate/contractPipeline/executionPlan.js");
  const { readFinalGateReport, runClosePhase } = await load("remediate/phases/close.js");
  const paths = executionPlanPaths(artifactsDir);
  const put = (p,v) => writeFile(p,JSON.stringify(v));
  await mkdir(paths.directory,{recursive:true});
  const code = "export const title = count => String(count);";
  await writeFile(join(root,"title.mjs"),code);
  await put(join(root,"package.json"),{name:"approved-close-fixture",private:true,scripts:{test:"node verify.mjs"}});
  await writeFile(join(root,"verify.mjs"),'import assert from "node:assert/strict";import {title} from "./title.mjs";assert.equal(title(2),"Items (2)");');
  const git = (...args) => execFileSync("git",args,{cwd:root,windowsHide:true,encoding:"utf8"});
  const commit = label => git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--no-gpg-sign","-qm",label);
  git("init","--template=","-q");
  git("add","package.json","title.mjs","verify.mjs");
  commit("Baseline");
  const request = {id:"title-request",text:"Expose the item count in the title",source_paths:[]};
  await put(paths.source,{plan_id:"title-plan",findings:[],request,audit_read:null,sources:[]});
  const plan = {
    plan_id:"title-plan", objective:"Show the item count", non_goals:[],
    requirements:[{id:"title-count",description:"The title should contain its item count",source_finding_ids:[],change_kind:"behavior_change",
      assertions:[
        {kind:"positive",description:"Two items are shown as a count of two",scope_paths:["title.mjs"]},
        {kind:"negative",description:"Zero items do not use a made-up count",scope_paths:["title.mjs"]}
      ]}],
    units:[{id:"title",title:"Fix title",description:"Include the actual count",source_finding_ids:[],requirement_ids:["title-count"],dependencies:[],
      read_paths:["title.mjs"],allowed_files:["title.mjs"],required_tests:[],affected_interfaces:[],addresses_counterexample_ids:[]}],
    source_dispositions:[]
  };
  const submission={base_revision_sha256:null,plan};
  await put(paths.submission,submission);
  assert.deepEqual(await ingestExecutionPlan(options),{changed:true,issues:[]});
  const canonical = await readCanonicalPlan(artifactsDir);
  assert.equal(canonical.plan.plan_id,"title-plan");
  assert.match(canonical.revision_sha256,/^[0-9a-f]{64}$/);
  const original = await readFile(paths.canonical);
  await put(paths.submission,submission);
  assert.deepEqual(await ingestExecutionPlan(options),{changed:false,issues:[]});
  assert.deepEqual(await readFile(paths.canonical),original);

  const state={status:"closing",run_start_dirty:[],run_start_dirty_encoding:"git-z/v1",
    plan:{...canonical.plan,request,review_revision_sha256:canonical.revision_sha256,findings:[],project_type:"node",candidate_closing_actions:["none"],test_command:"npm test",test_command_source:"project_facts"},
    items:{title:{unit_id:"title",status:"resolved"}},closing_plan:{action:"none"}};
  await assert.rejects(runClosePhase(state,options),{code:"plan_repair_required"});
  await assert.rejects(readFile(join(root,".audit-tools","remediation-outcomes.json")),{code:"ENOENT"});
  assert.equal(await readFile(join(root,"title.mjs"),"utf8"),code);

  // Simulate the completed review inputs to isolate the real closing boundary.
  // These records belong only to this fixture; no reviewer or user is contacted.
  const { contentSha256 } = await load("shared/index.js");
  const hash = contentSha256;
  const revision = canonical.revision_sha256;
  const history = {counterexamples:[],accepted_ids:[],repair_rounds:0};
  const review = { mode:"independent",reason:"Synthetic independent-answer fixture." };
  const reviewResults = {
    critique:{verdict:"approved",issues:[]},
    critic:{counterexamples:[]},
    judge:{verdict:"approved",classifications:[],requirement_assessments:[
      {requirement_id:"title-count",verdict:"satisfied",evidence:["The fixture covers the count behavior."]}],
      disposition_assessments:[]}
  };
  const reviewHashes = {};
  for (const [role,result] of Object.entries(reviewResults)) {
    const input = hash({role,revision});
    const receipt = {revision_sha256:revision,role,input_sha256:input,
      provenance:{requirement:"independent",prompt_sha256:input,review,reviewed_content_hash:revision},result};
    await put(paths.review(role).accepted,receipt);
    reviewHashes[role] = hash(receipt);
  }
  await put(paths.history,history);
  await put(paths.approval,{revision_sha256:revision,judge_input_sha256:hash({role:"judge",revision}),
    owner_decision_sha256:hash(null),risk_decision_sha256:hash(null),history_sha256:hash(history),review_sha256:reviewHashes});
  const blocked = await runClosePhase(state,options);
  assert.equal(blocked.status,"closing");
  const red = await readFinalGateReport(artifactsDir);
  assert.equal(red.outcome,"executed");
  assert.equal(red.passed,false);
  assert.equal(red.commands_run,1);
  await assert.rejects(readFile(join(root,".audit-tools","remediation-outcomes.json")),{code:"ENOENT"});

  await writeFile(join(root,"title.mjs"),'export const title = count => "Items (" + count + ")";');
  git("add","title.mjs");
  commit("Include actual count");
  const landed = git("rev-parse","HEAD").trim();
  const completed = await runClosePhase({...state,
    items:{title:{...state.items.title,host_landed_commit:landed,host_landed_files:["title.mjs"]}}},options);
  assert.equal(completed.status,"complete");
  const report = JSON.parse(await readFile(join(root,".audit-tools","remediation-outcomes.json"),"utf8"));
  assert.equal(report.final_gate.passed,true);
  assert.equal(report.execution_outcomes[0].landed_commit,landed);
  assert.equal(report.request_outcome.status,"resolved");
  const markdown = await readFile(join(root,".audit-tools","remediation-report.md"),"utf8");
  assert.match(markdown,/All reviewed execution units were verified/);
  const persisted = JSON.parse(await readFile(join(root,".audit-tools","remediation-state.complete.json"),"utf8"));
  assert.equal(persisted.status,"complete");
  assert.equal(persisted.items.title.host_landed_commit,landed);
});
