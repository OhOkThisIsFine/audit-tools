import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
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
  const { executionPlanPaths, ingestExecutionPlan, readApprovedExecutionPlan, readCanonicalPlan } = await load("remediate/contractPipeline/executionPlan.js");
  const { buildNextContractPipelineStep } = await load("remediate/steps/contractPipeline.js");
  const { contentSha256: hash, hashContent } = await load("shared/index.js");
  const { readFinalGateReport, runClosePhase } = await load("remediate/phases/close.js");
  const paths = executionPlanPaths(artifactsDir);
  const put = (p,v) => writeFile(p,JSON.stringify(v));
  await mkdir(paths.directory,{recursive:true});
  const code = "export const title = count => String(count);";
  await writeFile(join(root,"title.mjs"),code);
  await put(join(root,"package.json"),{name:"approved-close-fixture",private:true,scripts:{test:"node verify.mjs"}});
  await writeFile(join(root,"verify.mjs"),'import assert from "node:assert/strict";import {appendFileSync} from "node:fs";import {title} from "./title.mjs";appendFileSync(".audit-tools/check-runs","test\\n");assert.equal(title(2),"Items (2)");');
  const git = (...args) => execFileSync("git",args,{cwd:root,windowsHide:true,encoding:"utf8"});
  const commit = label => git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--no-gpg-sign","-qm",label);
  git("init","--template=","-q");
  // Both byte sequences decode to the same UTF-8 text; only one was agreed.
  const guidance = join(root, "guidance.md");
  const agreed = Buffer.from([0x41, 0xff]);
  const changed = Buffer.from([0x41, 0xfe]);
  assert.equal(agreed.toString("utf8"), changed.toString("utf8"));
  await writeFile(guidance, agreed);
  git("add","package.json","title.mjs","verify.mjs","guidance.md");
  commit("Baseline");
  const request = {id:"title-request",text:"Expose the item count in the title",source_paths:[guidance]};
  await put(paths.source,{plan_id:"title-plan",findings:[],request,audit_read:null,sources:[{path:guidance,sha256:hashContent(agreed)}]});
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

  const unchangedStep = await buildNextContractPipelineStep({...options,runId:"guidance-unchanged"});
  assert.doesNotMatch(await readFile(unchangedStep.prompt_path, "utf8"), /changed or disappeared/);

  // Simulate the completed review inputs to isolate the real closing boundary.
  // These records belong only to this fixture; no reviewer or user is contacted.
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
  assert.ok(await readApprovedExecutionPlan(artifactsDir), "Unchanged input bytes must retain approval");
  await writeFile(guidance, changed);
  assert.equal(await readApprovedExecutionPlan(artifactsDir), undefined);
  const changedStep = await buildNextContractPipelineStep({...options,runId:"guidance-changed"});
  assert.equal(changedStep.status, "blocked");
  assert.match(await readFile(changedStep.prompt_path, "utf8"), /changed or disappeared/);
  await writeFile(guidance, agreed);
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
  const closing = {...state,items:{title:{...state.items.title,host_landed_commit:landed,host_landed_files:["title.mjs"]}}};
  // A deliberate filesystem obstruction interrupts reporting after verification.
  // Removing just that empty directory must resume the recorded operation.
  const markdownPath = join(root,".audit-tools","remediation-report.md");
  await mkdir(markdownPath);
  await assert.rejects(runClosePhase(closing,options));
  const receipt = JSON.parse(await readFile(join(artifactsDir,"remediation-closing-result.json"),"utf8"));
  assert.ok(receipt.pending_report,"A report interruption must retain the closing receipt.");
  const verificationRuns = join(root,".audit-tools","check-runs");
  const beforeResume = await readFile(verificationRuns,"utf8");
  assert.equal(beforeResume,"test\ntest\n");
  await rmdir(markdownPath);
  const completed = await runClosePhase(closing,options);
  assert.equal(await readFile(verificationRuns,"utf8"),beforeResume);
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

  const { decideNextStep, renderRepositoryFloorPreview } = await load("remediate/steps/nextStep.js");
  const { readFinalGateVerdict, writeFinalGateVerdict } = await load("remediate/steps/finalGate.js");
  const preview = renderRepositoryFloorPreview(root, state, {}).join("\n");
  assert.match(preview, /unit: npm test/);
  assert.match(preview, /Do not run the repository-wide suite here/);
  assert.match(renderRepositoryFloorPreview(root, {
    ...state, plan: { ...state.plan, test_command_source: "explicit", test_command: "node verify.mjs" },
  }, {}).join("\n"), /unit: node verify\.mjs/);
  assert.deepEqual(renderRepositoryFloorPreview(root, state, { skipFinalGate: true }), []);
  const cliHelp = execFileSync(process.execPath, [join(checkout, "dist", "remediate", "index.js"), "next-step", "--help"], {
    cwd: root, encoding: "utf8", windowsHide: true,
  });
  assert.match(cliHelp, /--retry-final-gate\b/);

  const scope = "phase 1 boundary";
  const commandBinding = hash(preview);
  const verdict = { scope, tree: landed, binding: commandBinding, scoped_out: false, outcome: "executed", results: [] };
  await writeFinalGateVerdict(artifactsDir, { ...verdict, passed: false });
  assert.equal((await readFinalGateVerdict(artifactsDir, scope, landed, commandBinding)).passed, false);
  assert.equal(await readFinalGateVerdict(artifactsDir, scope, landed, commandBinding, true), undefined);
  await writeFinalGateVerdict(artifactsDir, { ...verdict, passed: true });
  assert.equal((await readFinalGateVerdict(artifactsDir, scope, landed, commandBinding, true)).passed, true);
  assert.equal(await readFinalGateVerdict(artifactsDir, scope, landed, "other binding", true), undefined);

  const { intakePaths } = await load("remediate/intake.js");
  const { intentInterpretationPath } = await load("remediate/intent/intentPersistence.js");
  const discoverOptions = { root, artifactsDir: join(root, ".audit-tools", "discover-fixture") };
  const intake = intakePaths(discoverOptions.artifactsDir);
  const interpretation = intentInterpretationPath(discoverOptions.artifactsDir);
  const discovered = join(root, "audit-report.md");
  await writeFile(discovered, "Change the title.");
  const confirmSource = async () => {
    const offered = await decideNextStep(discoverOptions);
    assert.equal(offered.step_kind, "confirm_auto_discovered_input");
    const offer = JSON.parse(await readFile(intake.discoveredInputOffer, "utf8"));
    await put(intake.discoveredInputAck, { ...offer, path: offer.path.replaceAll("\\", "/"), status: "confirmed" });
    assert.equal((await decideNextStep(discoverOptions)).step_kind, "synthesize_intake");
  };
  await confirmSource();
  const checkpoint = {
    schema_version: "intent-checkpoint/v1", confirmed_by: "host", confirmed_at: new Date().toISOString(),
    scope_summary: "Only title", intent_summary: "Improve the title",
  };
  await put(intake.intentCheckpoint, checkpoint);
  await put(interpretation, { fixture: "old interpretation" });
  await decideNextStep(discoverOptions);
  assert.deepEqual(JSON.parse(await readFile(intake.intentCheckpoint, "utf8")), checkpoint);
  await writeFile(discovered, "Replace the title and its markup.");
  await confirmSource();
  await assert.rejects(readFile(intake.intentCheckpoint), { code: "ENOENT" });
  await assert.rejects(readFile(interpretation), { code: "ENOENT" });
});
