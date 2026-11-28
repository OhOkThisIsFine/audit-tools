import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
test("a completed audit delivers canonical findings and narrative to remediation without rewriting its report", async t => {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "audit-contract-discovery-"));
  t.after(async () => {
    const sub = relative(temp, await realpath(root));
    assert.ok(sub.startsWith("audit-contract-discovery-") && !isAbsolute(sub) && !sub.includes(sep));
    await rm(root, {recursive:true,force:true});
  });
  const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
  const load = p => import(pathToFileURL(join(checkout, "dist", p)).href);
  const bin = join(checkout,"audit-code.mjs");
  const toolPath = [dirname(process.execPath), ...(process.env.SystemRoot ? [join(process.env.SystemRoot, "System32")] : [])].join(delimiter);
  const env = {...process.env, PATH:toolPath, AUDIT_CODE_STATE_DIR:join(root,"state")};
  delete env.AUDIT_TOOLS_CBM_BIN;
  const next = async () => JSON.parse((await promisify(execFile)(process.execPath,[bin,"next-step","--root",root],{cwd:root,env,windowsHide:true,timeout:15000})).stdout);
  await mkdir(join(root,"src"));
  await writeFile(join(root,"src/value.ts"),"export function total(a: number,b: number) { return a-b; }\n");
  await writeFile(join(root,"src/app.ts"),"import {total} from './value.js';\nexport const price=total(2,3);\n");
  await writeFile(join(root,"src/isolated.ts"),"const internal = 1;\n");
  const {persistAnalyzerSettings} = await load("shared/analyzerPolicy.js");
  const {EXTERNAL_ANALYZER_CANDIDATES} = await load("shared/analyzers/candidates.js");
  await persistAnalyzerSettings(root,Object.fromEntries([...EXTERNAL_ANALYZER_CANDIDATES.map(x=>x.id),"typescript","python","css","html","sql"].map(id=>[id,"skip"])));
  const one = await next();
  assert.equal(one.step_kind,"functional_preflight");
  await writeFile(one.artifact_paths.functional_preflight,JSON.stringify({
    contract_version:"audit-functional-preflight/v1",run_id:one.run_id,repository_root:root,
    source_inspection:{available:true,evidence:(await readFile(join(root,"src/value.ts"),"utf8")).trim()},
    relationship_inspection:{available:true,evidence:(await readFile(join(root,"src/app.ts"),"utf8")).split("\n")[0]},
    decision:"ready",
  }));
  const put = async (p,v) => {
    if (!p) throw new Error("Missing host output path");
    await mkdir(dirname(p),{recursive:true});
    await writeFile(p,JSON.stringify(v));
  };
  let writtenAnswer = false, writtenCoverage = false;
  for(let i=0;i<14;i++){
    const step = await next();
    const prompt = await readFile(step.prompt_path,"utf8");
    assert.notEqual(step.status,"blocked",step.progress?.summary);
    if(step.step_kind==="analyzer_selection"){
      const id=prompt.match(/"input_sha256": "([0-9a-f]{64})"/)?.[1];
      if(!id) throw new Error("Analyzer selection did not include a digest");
      await put(step.artifact_paths.analyzer_selection,{input_sha256:id,decisions:[],additional_checks:[],gaps:[]});
    }else if(step.step_kind==="analyzer_calibration"){
      const id=prompt.match(/"input_sha256": "([0-9a-f]{64})"/)?.[1];
      if(!id) throw new Error("Analyzer calibration did not include a digest");
      await put(step.artifact_paths.analyzer_calibration,{input_sha256:id,decisions:[],unresolved:[]});
    }else if(step.step_kind==="critical_flow_fallback"){
      await put(step.artifact_paths.critical_flow_fallback_results,{flows:[]});
    }else if(step.step_kind==="design_review_parallel"){
      for(const lane of ["contract","conceptual"]){
        const packet=await readFile(step.artifact_paths[lane+"_prompt"],"utf8");
        const digest=packet.match(/"prompt_sha256": "([0-9a-f]{64})"/)?.[1];
        if(!digest) throw new Error("Design review prompt did not publish its binding");
        await put(step.artifact_paths[lane+"_results"],{
          contract_version:"review-submission/v1",prompt_sha256:digest,
          review:{mode:"independent",reason:"Synthetic independent answer fixture; no external reviewer invoked."},
          result:{findings:[]}
        });
      }
    }else if(step.step_kind==="dispatch_review"){
      const {work_items}=JSON.parse(await readFile(step.artifact_paths.host_workload,"utf8"));
      if(work_items.length!==1) throw new Error("Expected one fixture review assignment, got "+work_items.length);
      const { binding } = work_items[0];
      if (binding.question.question_id.startsWith("full-file-inspection:")) {
        assert.equal(writtenAnswer, true);
        assert.equal(writtenCoverage, false);
        const {stdout:statusJson} = await promisify(execFile)(process.execPath,[bin,"status","--root",root],
          {cwd:root,env,windowsHide:true,timeout:15000});
        assert.equal(JSON.parse(statusJson).question_review_handoff.state,"current");
        const {schema_version, question_id, revision_id, snapshot_id} = binding.question;
        const identity = {schema_version, question_id, revision_id, snapshot_id};
        const refs = binding.question.requested_parts.map(p => ({path:p.part_id,start_line:1}));
        assert.deepEqual(refs.map(ref => ref.path), ["src/isolated.ts"]);
        const payload = { ...identity, submission_id:"full-coverage-answer", assignment_id:binding.assignment.assignment_id,
          inspected_sources:refs, evidence_ids:[], limitations:[],
          answer:{outcome:"clean", findings:[],
            parts:refs.map((ref,i)=>({part_id:ref.path,outcome:"clean",observation_ids:["inspection-"+i]})),
            observations:refs.map((ref,i)=>({...identity,part_id:ref.path,observation_id:"inspection-"+i,
              kind:"source_confirmed",statement:"Checked the isolated declaration.",source_refs:[ref],evidence_refs:[]}))}};
        const from = join(root,".audit-tools","coverage-test-answer.json");
        await put(from,payload);
        const {stdout} = await promisify(execFile)(process.execPath,[bin,"submit","--root",root,
          "--work-item",binding.assignment.assignment_id,"--from",from], {cwd:root,env,windowsHide:true,timeout:15000});
        assert.equal(JSON.parse(stdout).disposition,"accepted");
        writtenCoverage = true;
        continue;
      }
      assert.equal(writtenAnswer,false,"The same assignment should not be reissued after its answer is saved");
      writtenAnswer = true;
      const {binding:{question,assignment},result_path}=work_items[0];
      const source = assignment.suggested_sources.find(ref => ref.path === "src/value.ts");
      assert.ok(source);
      await put(join(root,result_path),{
        schema_version:"audit-tools/question-review/v1",submission_id:"contract-suite-answer",
        question_id:question.question_id,assignment_id:assignment.assignment_id,
        revision_id:question.revision_id,snapshot_id:question.snapshot_id,
        inspected_sources:[{path:"src/value.ts"},{path:"src/app.ts"},{path:"src/isolated.ts"}],evidence_ids:[],limitations:[],
        answer:{outcome:"findings",parts:question.requested_parts.map((p,i)=>({part_id:p.part_id,outcome:i===0?"findings":"clean",observation_ids:["observation-"+i]})),
          observations:question.requested_parts.map((p,i)=>({
            schema_version:"audit-tools/question-review/v1",question_id:question.question_id,revision_id:question.revision_id,
            snapshot_id:question.snapshot_id,observation_id:"observation-"+i,part_id:p.part_id,kind:"source_confirmed",
            statement:i===0?"The arithmetic helper subtracts instead of adding.":"The fixture has a single caller.",
            source_refs:i===0?[{path:"src/value.ts",start_line:1},{path:"src/app.ts",start_line:1}]:[{path:"src/app.ts",start_line:1}],evidence_refs:[]
          })),findings:["incorrect-total","incorrect-price"].map((finding_id,index)=>({
            schema_version:"audit-tools/question-review/v1",question_id:question.question_id,revision_id:question.revision_id,
            finding_id,kind:"confirmed_defect",severity:index===0?"high":"low",confidence:"high",
            claim:index===0?"Total subtracts instead of adding.":"Caller stores a negative price.",
            consequence:"The result does not match the declared total.",next_step:"Correct the calculation.",
            source_refs:[source],evidence_ids:[],observation_ids:["observation-0"],
            verification:[{kind:"assertion",obligation_id:"verify-"+finding_id,expected:"The declared value is returned.",source_refs:[source]}],
          }))}
      });
    }else if(step.step_kind==="synthesis_narrative"){
      const raw=JSON.parse(await readFile(join(root,".audit-tools","audit","audit-findings.json"),"utf8"));
      assert.equal(raw.findings.length,2);
      await put(step.artifact_paths.synthesis_narrative_results,{
        themes:[{theme_id:"T-001",title:"Arithmetic",root_cause:"Subtraction in total",
          finding_ids:raw.findings.map(({id})=>id),suggested_fix_pattern:"Use addition"}],
        top_risks:[...raw.findings.map(({id,title})=>id+": "+title)],
        executive_summary:"The arithmetic helper caused incorrect calculations.",
      });
    }else if(step.step_kind==="confirm_intent"){
      await put(step.artifact_paths.intent_checkpoint,{
        schema_version:"intent-checkpoint/v1",confirmed_at:new Date().toISOString(),confirmed_by:"host",scope_summary:"Two source fixture files",intent_summary:"full-audit"
      });
    }else if(step.step_kind==="present_report"){
      assert.equal(step.status,"complete");
      assert.equal(writtenAnswer,true);
      assert.equal(writtenCoverage,true);
      const machinePath=join(root,".audit-tools","audit-findings.json");
      const original=await readFile(machinePath,"utf8");
      const machine=JSON.parse(original);
      assert.equal(machine.contract_version,"audit-tools/audit-findings/v2");
      assert.equal(machine.question_review.completion,"complete");
      assert.deepEqual(machine.question_review.accepted.map(({submission})=>submission.submission_id),["contract-suite-answer","full-coverage-answer"]);
      assert.deepEqual(machine.question_review.file_coverage,{admitted_count:3,inspected_count:3,gaps:[]});
      const markdown=await readFile(step.artifact_paths.final_report,"utf8");
      assert.match(markdown,/Coverage: \*\*complete\*\*/);
      assert.ok(markdown.includes(machine.question_review.snapshot_id));
      assert.match(markdown,/The arithmetic helper caused incorrect calculations/);
      assert.match(markdown,/Arithmetic/);
      assert.equal(machine.findings.length,2);
      assert.ok(machine.findings.every(row=>row.theme_id===undefined));
      assert.deepEqual(machine.themes[0].finding_ids,machine.findings.map(({id})=>id));
      const remediate=async (...args)=>JSON.parse((await promisify(execFile)(process.execPath,[
        join(checkout,"remediate-code.mjs"),"next-step","--root",root,"--input",machinePath,...args,
      ],{cwd:root,env,windowsHide:true,timeout:15000})).stdout);
      const {projectApprovedFindings,projectAuditFindingsReportSubset}=await load("shared/validation/findingsReport.js");
      const all=projectAuditFindingsReportSubset(machine,machine.findings);
      assert.deepEqual(all.findings,machine.findings);
      assert.deepEqual(all.question_review,machine.question_review);
      for(const field of ["themes","top_risks","executive_summary"]) assert.deepEqual(all[field],machine[field]);
      const selectionDir=join(root,".audit-tools","test-remediation-selection");
      const projectedPath=join(selectionDir,"intake","selected-audit-findings.json");
      const selectedFinding=machine.findings.find(row=>row.severity==="high");
      const second=await remediate("--artifacts-dir",selectionDir,"--finding-id",selectedFinding.id);
      assert.equal(second.step_kind,"synthesize_intake");
      const subset=JSON.parse(await readFile(projectedPath,"utf8"));
      assert.deepEqual(subset.findings,[selectedFinding]);
      assert.deepEqual(subset.question_review.accepted,machine.question_review.accepted);
      assert.deepEqual(subset.themes,[{...machine.themes[0],finding_ids:[selectedFinding.id]}]);
      assert.equal(subset.executive_summary,undefined);
      assert.deepEqual(subset.top_risks,[selectedFinding.id+": "+selectedFinding.title]);
      // A normal unfiltered run validates the report again after owner review,
      // when it projects the approved originals for the execution-plan seed.
      const intake=await remediate();
      assert.equal(intake.step_kind,"synthesize_intake");
      await put(intake.artifact_paths.intake_summary,{
        schema_version:"remediate-code-intake-summary/v1alpha2",ready:true,source_type:"structured_audit",
        source_summary:"Fix arithmetic defects",goals:["Restore declared arithmetic"],non_goals:[],constraints:[],
        affected_files:[],acceptance_criteria:[],scope_summary:"The reported source files",
        intent_summary:"Repair both confirmed defects",filters:{},open_questions:[],
      });
      const confirm=await remediate();
      assert.equal(confirm.step_kind,"confirm_intent");
      const remediationDir=join(root,".audit-tools","remediation");
      await put(join(remediationDir,"intent_checkpoint.json"),{
        schema_version:"intent-checkpoint/v1",confirmed_at:new Date().toISOString(),confirmed_by:"host",
        scope_summary:"The reported source files",intent_summary:"Repair both confirmed defects",
      });
      const review=await remediate();
      assert.equal(review.step_kind,"collect_review_approval");
      await put(join(remediationDir,"review_resolution.json"),{});
      const planning=await remediate();
      assert.equal(planning.status,"ready");
      const seed=JSON.parse(await readFile(join(remediationDir,"intake","plan","source.json"),"utf8"));
      assert.deepEqual(seed.findings,machine.findings);
      assert.equal(seed.question_report,true);
      assert.deepEqual(seed.sources.map(({path})=>path),[machinePath]);
      assert.equal(await readFile(machinePath,"utf8"),original);

      const theme=machine.themes[0];
      assert.equal(projectApprovedFindings(machine).dispositionById.get(selectedFinding.id).themeId,theme.theme_id);
      assert.throws(()=>projectApprovedFindings({...machine,findings:machine.findings.map(row=>({...row,theme_id:"wrong"}))}),
        /canonical accepted-claim projection/);
      assert.throws(()=>projectApprovedFindings({...machine,themes:[{...theme,finding_ids:["dangling"]}]}),/non-approved finding/);
      assert.throws(()=>projectApprovedFindings({...machine,themes:[{...theme,finding_ids:[selectedFinding.id,selectedFinding.id]}]}),
        /Duplicate finding id/);
      assert.throws(()=>projectApprovedFindings({...machine,themes:[theme,{...theme,theme_id:"T-002"}]}),/belongs to multiple themes/);
      assert.throws(()=>projectApprovedFindings({...machine,themes:[theme,{...theme,finding_ids:[]}]}),/Duplicate theme id/);
      return;
    }else{
      throw new Error("Unexpected fixture step: "+step.step_kind);
    }
  }
  assert.fail("Synthetic workflow did not reach its report");
});

test("explicit cleanup proves owned custom targets before dry-run and refuses unsafe recovery", async t => {
  const temp = await realpath(tmpdir());
  const fixture = await mkdtemp(join(temp, "audit-cleanup-proof-"));
  t.after(async () => {
    const sub = relative(temp, await realpath(fixture));
    assert.ok(sub.startsWith("audit-cleanup-proof-") && !isAbsolute(sub) && !sub.includes(sep));
    await rm(fixture, { recursive: true, force: true });
  });
  const root = join(fixture, "repo with spaces");
  const stateDir = join(fixture, "snapshot-state");
  const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
  const bin = join(checkout, "audit-code.mjs");
  const load = p => import(pathToFileURL(join(checkout, "dist", p)).href);
  const toolPath = [dirname(process.execPath), ...(process.env.SystemRoot ? [join(process.env.SystemRoot, "System32")] : [])].join(delimiter);
  const env = { ...process.env, PATH:toolPath, AUDIT_CODE_STATE_DIR:stateDir };
  const run = (...argv) => promisify(execFile)(process.execPath, [bin, ...argv], { cwd: root, env, windowsHide: true, timeout: 15000 });
  const parent = join(root, "custom output");
  const owned = join(parent, "working audit");
  const copied = join(parent, "other run");
  const outside = join(fixture, "outside");
  for (const dir of [owned, copied, outside]) await mkdir(dir, { recursive: true });
  await writeFile(join(root, "example.ts"), "export const value = 1;");
  const originalState = process.env.AUDIT_CODE_STATE_DIR;
  process.env.AUDIT_CODE_STATE_DIR = stateDir;
  t.after(() => {
    if (originalState === undefined) delete process.env.AUDIT_CODE_STATE_DIR;
    else process.env.AUDIT_CODE_STATE_DIR = originalState;
  });
  const { ensureRunSnapshot } = await load("audit/io/runSnapshot.js");
  await ensureRunSnapshot(root, owned);
  const snapshotPath = join(owned, "run-snapshot.json");
  const snapshotBytes = await readFile(snapshotPath, "utf8");
  const statePath = join(owned, "audit_state.json");
  await writeFile(statePath, JSON.stringify({ status: "active", obligations: [] }));
  const promoted = join(parent, "audit-findings.json");
  await writeFile(promoted, "promoted");
  await writeFile(join(copied, "keep.txt"), "sibling");
  const clean = target => run("cleanup", "--force", "--dry-run", "--root", root, "--artifacts-dir", target);
  const dryRun = async (target, status) => assert.deepEqual(JSON.parse((await clean(target)).stdout), {
    artifacts_dir: target, action: "dry-run", status, dry_run: true,
  });
  const refuse = (target, reason) => assert.rejects(clean(target), error => {
    assert.equal(error.code, 1);
    const response = JSON.parse(error.stdout);
    assert.ok(["skipped", "refused"].includes(response.action));
    assert.match(response.reason, reason);
    return true;
  });

  await dryRun(owned, "active");
  await writeFile(statePath, "{unparseable");
  await dryRun(owned, "unknown");
  assert.equal(await readFile(statePath, "utf8"), "{unparseable");
  assert.equal(await readFile(snapshotPath, "utf8"), snapshotBytes);
  assert.equal(await readFile(promoted, "utf8"), "promoted");
  assert.equal(await readFile(join(copied, "keep.txt"), "utf8"), "sibling");
  assert.ok((await readFile(join(JSON.parse(snapshotBytes).source_root, "example.ts"), "utf8")).includes("value = 1"));

  await copyFile(statePath, join(copied, "audit_state.json"));
  await refuse(copied, /exactly one working-run snapshot record/);
  await copyFile(snapshotPath, join(copied, "run-snapshot.json"));
  await refuse(copied, /source_root is not the owned source directory/);
  await t.test("refuses a junction or symbolic-link escape", async child => {
    const onDiskAlias = join(root, "link");
    try {
      await symlink(outside, onDiskAlias, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
      child.skip("Windows runner does not permit creating a fixture junction");
      return;
    }
    await refuse(onDiskAlias, /unsafe directory topology/);
  });
  await refuse(outside, /not strictly inside/);
  await refuse(root, /not strictly inside/);
  await writeFile(join(owned, ".fold-receipt.json"), "{}");
  await refuse(owned, /incomplete fold receipt/);
  await rm(join(owned, ".fold-receipt.json"));
  await copyFile(snapshotPath, join(owned, "run-snapshot-acquiring.json"));
  await refuse(owned, /exactly one working-run snapshot record/);
  await rm(join(owned, "run-snapshot-acquiring.json"));
  await rm(statePath);
  await mkdir(statePath);
  await refuse(owned, /unsafe audit state marker/);
  await rm(statePath, { recursive: true });
  await writeFile(statePath, "{unparseable");

  // Test both recovery-hint producers directly so diagnostic assertions do
  // not depend on what next-step decides to do after rollover refuses.
  const { rollOverFinishedRun } = await load("audit/io/rollover.js");
  const record = JSON.parse(snapshotBytes);
  const sourceWithinState = relative(stateDir, await realpath(record.source_root));
  assert.ok(sourceWithinState.startsWith("snapshots" + sep) && !isAbsolute(sourceWithinState));
  await rm(record.source_root, { recursive: true });
  const expectHint = message => {
    assert.match(message, /audit-code cleanup --force --root /);
    assert.ok(message.includes(root), message);
    assert.ok(message.includes("--artifacts-dir ") && message.includes(owned), message);
  };
  await assert.rejects(ensureRunSnapshot(root, owned), error => {
    assert.match(error.message, /frozen copy/);
    expectHint(error.message);
    return true;
  });
  await writeFile(snapshotPath, JSON.stringify({ ...record, restore_unverified: true }));
  await assert.rejects(ensureRunSnapshot(root, owned), error => {
    assert.match(error.message, /previous recovery did not prove identity/);
    expectHint(error.message);
    return true;
  });
  const rollover = join(root, "custom rollover", "working");
  await mkdir(rollover, { recursive: true });
  await writeFile(join(rollover, "run-ended.json"), "{}");
  await writeFile(join(rollover, "audit-findings.json"), "{}");
  const restoreWrite = t.mock.method(process.stderr, "write", () => true);
  try {
    assert.equal(await rollOverFinishedRun(rollover, root), false);
  } finally {
    restoreWrite.mock.restore();
  }
  const message = restoreWrite.mock.calls.map(({ arguments: args }) => args[0]).join("");
  assert.match(message, /has no promoted copy/);
  assert.ok(message.includes("audit-code cleanup --force --root ") && message.includes(root) &&
    message.includes("--artifacts-dir ") && message.includes(rollover), message);
});
