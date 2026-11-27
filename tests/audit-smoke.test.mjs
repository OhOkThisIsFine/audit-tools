import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
  let writtenAnswer = false;
  for(let i=0;i<12;i++){
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
      assert.equal(writtenAnswer,false,"The same assignment should not be reissued after its answer is saved");
      writtenAnswer = true;
      const {work_items}=JSON.parse(await readFile(step.artifact_paths.host_workload,"utf8"));
      if(work_items.length!==1) throw new Error("Expected one fixture review assignment, got "+work_items.length);
      const {binding:{question,assignment},result_path}=work_items[0];
      const source = assignment.suggested_sources.find(ref => ref.path === "src/value.ts");
      assert.ok(source);
      await put(join(root,result_path),{
        schema_version:"audit-tools/question-review/v1",submission_id:"contract-suite-answer",
        question_id:question.question_id,assignment_id:assignment.assignment_id,
        revision_id:question.revision_id,snapshot_id:question.snapshot_id,
        inspected_sources:assignment.suggested_sources,evidence_ids:[],limitations:[],
        answer:{outcome:"findings",parts:question.requested_parts.map((p,i)=>({part_id:p.part_id,outcome:i===0?"findings":"clean",observation_ids:["observation-"+i]})),
          observations:question.requested_parts.map((p,i)=>({
            schema_version:"audit-tools/question-review/v1",question_id:question.question_id,revision_id:question.revision_id,
            snapshot_id:question.snapshot_id,observation_id:"observation-"+i,part_id:p.part_id,kind:"source_confirmed",
            statement:i===0?"The arithmetic helper subtracts instead of adding.":"The fixture has a single caller.",
            source_refs:assignment.suggested_sources,evidence_refs:[]
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
      const machinePath=join(root,".audit-tools","audit-findings.json");
      const original=await readFile(machinePath,"utf8");
      const machine=JSON.parse(original);
      assert.equal(machine.contract_version,"audit-tools/audit-findings/v2");
      assert.equal(machine.question_review.completion,"complete");
      assert.deepEqual(machine.question_review.accepted.map(({submission})=>submission.submission_id),["contract-suite-answer"]);
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
