import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout,"dist",file)).href);

test("selected analyzers that did not run cannot be credited as covering source", async () => {
  const { analyzerCalibrationRequest, currentAnalyzerCalibration } = await load("audit/orchestrator/analyzerCalibration.js");
  const selection = {input_sha256:"1".repeat(64),decisions:[{tool:"semgrep",action:"run",reason:"Source rules would be useful."}],additional_checks:[],gaps:[]};
  const bundle = {external_analyzer_acquisition:{tool_statuses:[{tool:"semgrep",status:"skipped"}]}};
  const request = analyzerCalibrationRequest(bundle,selection);
  assert.equal(request.tools.length,1);
  assert.equal(request.tools[0].incomplete,true);
  const answer = action => ({input_sha256:request.input_sha256,decisions:[{tool:"semgrep",action,
    reason:"The executable is unavailable.",coverage:"No source rules ran.",
    ...(action==="limited" && {recovery:{failure:"complete",disposition:"permission_refused",detail:"Run was not authorized"}})}],unresolved:[]});
  assert.equal(currentAnalyzerCalibration(answer("accept"),request),undefined);
  assert.equal(currentAnalyzerCalibration(answer("retry"),request),undefined);
  const limited = answer("limited");
  const { recovery, ...withoutFailure } = limited.decisions[0];
  assert.equal(currentAnalyzerCalibration({...limited,decisions:[withoutFailure]},request),undefined);
  assert.deepEqual(currentAnalyzerCalibration(limited,request),limited);
  const changed = analyzerCalibrationRequest({...bundle,external_analyzer_results:[{tool:"semgrep",results:[]}]},selection);
  assert.notEqual(changed.input_sha256, request.input_sha256);
  assert.equal(currentAnalyzerCalibration(answer("limited"),changed),undefined);
});

test("an admitted review is replayable but is not silently replaced", async () => {
  const { acceptQuestionReview } = await load("audit/cli/dispatch/questionReviewAcceptance.js");
  const version="audit-tools/question-review/v1";
  const identity = {question_id:"Q",revision_id:"v1",snapshot_id:"s1"};
  const assignment = {...identity,assignment_id:"A",authorized_scope:{include:["value.ts"],exclude:[]},available_evidence_ids:[]};
  const binding = {assignment,question:{...identity,requested_parts:[{part_id:"body"}]},
    sourceFiles:[{path:"value.ts",line_count:1,fingerprint:"8".repeat(64)}],evidence:[],dependencies:[]};
  const submission = {...identity,schema_version:version,assignment_id:"A",submission_id:"one",
    inspected_sources:[{path:"value.ts"}],evidence_ids:[],limitations:["Inspected source only."],
    answer:{outcome:"inconclusive",parts:[{part_id:"body",outcome:"inconclusive",observation_ids:[]}],observations:[],findings:[]}};
  const at = "2026-11-27T00:00:00Z";
  const admit = (answers,value) => acceptQuestionReview(answers,binding,value,at);
  assert.throws(()=>admit([],{...submission,snapshot_id:"different"}),/does not match/);
  const accepted = admit([],submission);
  assert.equal(accepted.kind,"accepted");
  assert.equal(admit([accepted.record],submission).kind,"replay");
  assert.throws(()=>admit([accepted.record],{...submission,limitations:["Different text."]}),/Conflicting reuse/);
  assert.throws(()=>admit([accepted.record],{...submission,submission_id:"two"}),/already has an accepted response/);
  assert.deepEqual(accepted.record.submission,submission);
});

test("hybrid graph keeps the exact current calibrated index, not a rediscovered runtime", async () => {
  const { measuredCodebaseMemoryHandle, publishAuditEvidenceGraph, reviewerGraphIndex } = await load("audit/cli/dispatch/hostHandoff.js");
  const { buildReviewerGraph } = await load("audit/cli/reviewGraphCommand.js");
  const { hashContent, stableStringify } = await load("shared/index.js");
  const directory = await mkdtemp(join(tmpdir(),"audit-measured-graph-"));
  try {
    const files = [{path:"entry.js",fingerprint:"8".repeat(64)}];
    const meta = {engine:"codebase-memory-mcp",key:"a".repeat(64)};
    const text = buildReviewerGraph({graphs:{}},["entry.js"],meta,hashContent(stableStringify(files)));
    const digest = hashContent(text);
    const path = reviewerGraphIndex(directory,digest);
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,text);
    const acquisition = {codebase_memory:{status:"success",index_sha256:digest}};
    assert.deepEqual(measuredCodebaseMemoryHandle(directory,acquisition),{graphIndex:path,graphSha256:digest});
    const graph = {graphs:{calls:[{from:"entry.js",to:"entry.js",kind:"calls"}]}};
    const hybrid = await publishAuditEvidenceGraph(directory,join(directory,"not-a-source-dir"),files,graph,false,undefined,acquisition);
    assert.deepEqual(hybrid.indexed,meta);
    assert.notEqual(hybrid.graphSha256,digest,"native graph adds edges without replacing the measured CBM index");
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});

test("Codebase Memory distinguishes daemon startup from generic failures without exposing stderr", async () => {
  const { codebaseMemoryFailureDetail } = await load("audit/cli/reviewerCodebaseMemory.js");
  for (const error of ["CBM daemon could not start within 30000 ms", "secure CLI coordination directory rejected", "CLI exact-build admission could not be verified; retry after active CBM operations exit"]) {
    const detail = codebaseMemoryFailureDetail(error + "\nprivate/runtime/path", 1, false);
    assert.match(detail, /host already authorized for local daemon access/);
    assert.doesNotMatch(detail, /private\/runtime\/path/);
  }
  assert.equal(codebaseMemoryFailureDetail("saved runtime settings", 1, false), "could not load isolated runtime settings");
  assert.equal(codebaseMemoryFailureDetail("", null, true), "process could not complete within the runner bounds");
  assert.equal(codebaseMemoryFailureDetail("unknown stderr", 1, false), "exit 1");
});

test("shared entrypoints retain distinct flow evidence and explicitly chosen lenses", async () => {
  const { buildReviewQuestionPlan } = await load("audit/orchestrator/questionPlanning.js");
  const { questionWorkloadBindings } = await load("audit/cli/questionWorkloadBindings.js");
  const paths = ["entry.js", "calendar.sql", "mail.sql"];
  const hash = "8".repeat(64);
  const version = "audit-tools/question-review/v1";
  const scope = {mode:"full"};
  const bundle = {scope, intent_checkpoint:{lens_selection:{include:["behavior","security"]}},
    repo_manifest:{files:paths.map(path=>({path,hash}))},
    file_disposition:{files:paths.map(path=>({path,status:"included"}))},
    surface_manifest:{surfaces:[{id:"entry",kind:"interface",entrypoint:"entry.js",exposure:"local"}]},
    critical_flows:{flows:[
      {id:"calendar",name:"Calendar",entrypoints:["entry.js:2-6","entry.js:18-19"],paths:["entry.js","calendar.sql"],concerns:[]},
      {id:"mail",name:"Mail",entrypoints:["entry.js:10-15"],paths:["entry.js","mail.sql"],concerns:[]},
    ]},
    charter_register:{lanes:[{kind:"stated",nodes:[
      {purpose:"Keep Calendar work replayable.",provenance:[{ref:"entry.js:18"},{ref:"entry.js"}]},
      {purpose:"Keep unrelated mail out of billing.",provenance:[{ref:"entry.js:11"}]},
    ]}]}};
  const plan = buildReviewQuestionPlan(bundle,{snapshotId:"s1"});
  const calendar = plan.questions.find(q=>q.lens==="behavior" && q.expected_outcome.startsWith("Review Calendar."));
  const mail = plan.questions.find(q=>q.lens==="behavior" && q.expected_outcome.startsWith("Review Mail."));
  assert.ok(calendar && mail);
  assert.match(calendar.expected_outcome,/Keep Calendar work replayable/);
  assert.doesNotMatch(calendar.expected_outcome,/unrelated mail/);
  assert.deepEqual(calendar.source_dependencies.filter(dep=>dep.kind==="source").map(dep=>dep.key),["calendar.sql","entry.js"]);
  assert.equal(plan.questions.filter(q=>q.lens==="security").length,1);
  assert.equal(plan.lens_decisions.find(row=>row.lens==="security").decision,"selected");
  const direct = {kind:"evidence", key:"cross", fingerprint:hash};
  calendar.evidence_dependencies.push(direct);
  const observation = (id, refs, dependencies=[]) => ({schema_version:version,evidence_id:id,snapshot_id:"s1",
    kind:"source",status:"observed",description:"Fixture",source_refs:refs,dependencies});
  const calendarRef = {path:"entry.js",start_line:3};
  const mailRef = {path:"entry.js",start_line:11};
  const evidence = [observation("calendar",[calendarRef]),observation("mail",[mailRef]),
    observation("mixed",[calendarRef,{path:"mail.sql",start_line:1}]),
    observation("explicit",[calendarRef,mailRef],[direct])];
  const bindings = await questionWorkloadBindings({...bundle,review_plan:plan},checkout,evidence,
    paths.map(path=>({path,line_count:20,fingerprint:hash})));
  const idsFor = question => bindings.find(binding=>binding.question===question).assignment.available_evidence_ids;
  assert.deepEqual(idsFor(calendar),["calendar","explicit"]);
  assert.deepEqual(idsFor(mail),["mail"]);
});
