import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout, "dist", file)).href);

test("a valid proposed plan is stable on replay but cannot close without approved review", async t => {
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
  const { runClosePhase } = await load("remediate/phases/close.js");
  const paths = executionPlanPaths(artifactsDir);
  const put = (p,v) => writeFile(p,JSON.stringify(v));
  await mkdir(paths.directory,{recursive:true});
  const code = "export const title = count => String(count);";
  await writeFile(join(root,"title.mjs"),code);
  await put(paths.source,{plan_id:"title-plan",findings:[],request:{id:"title-request",text:"Expose the item count in the title",source_paths:[]},audit_read:null,sources:[]});
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
    plan:{...canonical.plan,review_revision_sha256:canonical.revision_sha256,findings:[]},
    items:{title:{unit_id:"title",status:"resolved"}},closing_plan:{action:"none"}};
  await assert.rejects(runClosePhase(state,options),{code:"plan_repair_required"});
  await assert.rejects(readFile(join(root,".audit-tools","remediation-outcomes.json")),{code:"ENOENT"});
  assert.equal(await readFile(join(root,"title.mjs"),"utf8"),code);
});
