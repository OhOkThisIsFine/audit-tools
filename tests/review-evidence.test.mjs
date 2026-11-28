import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
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
