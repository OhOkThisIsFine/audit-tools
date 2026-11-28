import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout,"dist",file)).href);

test("confirmation leads with one decision and a neutral checkpoint preserves applicable lenses and approved depth", async () => {
  const { renderConfirmIntentPrompt } = await load("audit/cli/confirmIntentStep.js");
  const { IntentCheckpointSchema, resolveRunBoundDesignReview } = await load("shared/types/intentCheckpoint.js");
  const { buildReviewQuestionPlan } = await load("audit/orchestrator/questionPlanning.js");
  const scope = {
    mode: "full", files_in_scope: 1, scope_dirs: [{ dir: "src", files: 1 }],
    excluded_summary: [], disposition_override_proposals: [], mis_scope_smells: [], docs_digest: [],
    lens_propositions: [
      { lens: "behavior", disposition: "recommend_include", reason: "Supported operation." },
      { lens: "performance", disposition: "recommend_include", reason: "Representative workload." },
    ],
  };
  const render = intentSummary => renderConfirmIntentPrompt(scope, {
    intentSummary, intentCheckpointPath: "intent_checkpoint.json", continueCommand: "audit-tools next-step",
    evidenceGraphCommand: "audit-tools review-graph", analyzerCoverageGaps: ["One analyzer did not run."],
  });
  const broadPrompt = render("full repository audit");
  const lead = broadPrompt.split("## Prepared evidence and scope details")[0];
  assert.match(lead, /Ask once: stop .* or continue/);
  assert.match(lead, /Scope:\*\* full, 1 file/);
  assert.match(lead, /\[included directories\]\(#in-scope-top-level-directories\)/);
  assert.match(lead, /\[lens recommendations\]\(#lens-proposition\): behavior, performance recommended/);
  assert.match(lead, /depth:\*\* \*\*deep\*\* proposed/);
  assert.doesNotMatch(lead, /One analyzer did not run/);
  assert.match(broadPrompt, /Query admitted files using: audit-tools review-graph/);
  assert.match(broadPrompt, /One analyzer did not run/);
  assert.match(broadPrompt, /audit-tools next-step/);

  const template = prompt => JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/)[1]);
  const raw = template(broadPrompt);
  assert.deepEqual(Object.keys(raw).sort(), [
    "confirmed_at", "confirmed_by", "design_review", "intent_summary", "schema_version", "scope_summary",
  ]);
  assert.deepEqual(Object.keys(raw.design_review).sort(), ["answered_at", "conceptual_depth"]);
  assert.match(raw.design_review.conceptual_depth, /^<.*shallow or deep>$/);
  const confirmed = (prompt, depth, changes = {}) => {
    const draft = template(prompt);
    const at = "2026-11-28T00:00:00Z";
    return IntentCheckpointSchema.parse({
      ...draft, confirmed_at: at, scope_summary: "src", intent_summary: "Review the declared operation.",
      design_review: { ...draft.design_review, answered_at: at, conceptual_depth: depth },
      ...changes,
    });
  };
  const broad = confirmed(broadPrompt, "deep");
  const shallowProposal = render("quick audit");
  assert.match(shallowProposal, /depth:\*\* \*\*shallow\*\* proposed/);
  assert.deepEqual(template(shallowProposal), raw);
  assert.equal(resolveRunBoundDesignReview(broad).conceptual_depth, "deep");
  assert.equal(resolveRunBoundDesignReview(confirmed(shallowProposal, "deep")).conceptual_depth, "deep");
  assert.equal(resolveRunBoundDesignReview(confirmed(broadPrompt, "shallow")).conceptual_depth, "shallow");

  const path = "src/value.ts";
  const plan = intent_checkpoint => buildReviewQuestionPlan({
    intent_checkpoint,
    repo_manifest: { files: [{ path, hash: "a".repeat(64) }] },
    file_disposition: { files: [{ path, status: "included" }] },
  }, {
    snapshotId: "snapshot",
    declaredQuestions: [
      { lens: "behavior", key: "value", kind: "operation", title: "Return the value",
        source_refs: [{ path }], expectation: "Return the input value." },
      { lens: "performance", key: "workload", kind: "workload", title: "Compute cost",
        source_refs: [{ path }], expectation: "Assess representative work." },
    ],
  });
  assert.deepEqual(plan(broad).questions.map(q => q.lens).sort(), ["behavior", "performance"]);
  const narrowed = confirmed(broadPrompt, "deep", {
    lens_selection: { include: ["performance"], omission_reasons: { behavior: "Already reviewed." } },
  });
  const narrowPlan = plan(narrowed);
  assert.deepEqual(narrowPlan.questions.map(q => q.lens), ["performance"]);
  assert.deepEqual(narrowPlan.lens_decisions.find(d => d.lens === "behavior"), {
    lens: "behavior", decision: "excluded", reason: "Already reviewed.",
  });
});

test("selected analyzers that did not run cannot be credited as covering source", async () => {
  const { analyzerCalibrationRequest, currentAnalyzerCalibration } = await load("audit/orchestrator/analyzerCalibration.js");
  const selection = {input_sha256:"1".repeat(64),decisions:[{tool:"semgrep",action:"run",reason:"Source rules would be useful."}],additional_checks:[],gaps:[]};
  const bundle = {external_analyzer_acquisition:{tool_statuses:[{tool:"semgrep",status:"skipped"}]}};
  const request = analyzerCalibrationRequest(bundle,selection);
  assert.equal(request.tools.length,1);
  assert.equal(request.tools[0].incomplete,true);
  const answer = action => ({input_sha256:request.input_sha256,decisions:[{tool:"semgrep",action,reason:"The executable is unavailable.",coverage:"No source rules ran."}],unresolved:[]});
  assert.equal(currentAnalyzerCalibration(answer("accept"),request),undefined);
  assert.equal(currentAnalyzerCalibration(answer("retry"),request),undefined);
  assert.deepEqual(currentAnalyzerCalibration(answer("limited"),request),answer("limited"));
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

test("Codebase Memory runtime cache stays out of a Windows audit's shared temp ancestry", async t => {
  const { reviewerCbmCacheDirectory } = await load("audit/io/reviewerCbmCache.js");
  const { homedir, tmpdir } = await import("node:os");
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "audit-cbm-layout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, "audit"), other = join(root, "other");
  await Promise.all([mkdir(run), mkdir(other)]);
  const cache = await reviewerCbmCacheDirectory(run);
  assert.equal(cache, await reviewerCbmCacheDirectory(join(run, "graph-index", "..")));
  assert.notEqual(cache, await reviewerCbmCacheDirectory(other));
  if (process.platform === "win32") {
    assert.ok(cache.startsWith(join(homedir(), ".audit-tools", "review-cbm") + "\\"));
    assert.ok(!cache.startsWith(run + "\\"));
    await assert.rejects(reviewerCbmCacheDirectory(join(root, "missing")), { code: "ENOENT" });
  } else {
    assert.equal(cache, join(run, "review-cbm"));
  }
});

test("full file inspection packets target only bounded, admitted gaps and require per-file source evidence", async t => {
  const { admittedFileCoverage, extendFullFileReview } = await load("audit/orchestrator/fullFileReview.js");
  const { reviewSourceScope } = await load("audit/orchestrator/questionPlanning.js");
  const { acceptQuestionReview } = await load("audit/cli/dispatch/questionReviewAcceptance.js");
  const { buildQuestionAuditFindingsReport } = await load("audit/reporting/questionReport.js");
  const schema_version = "audit-tools/question-review/v1";
  const snapshot_id = "review-snapshot";
  const paths = Array.from({length:11}, (_,i)=>"src/" + String(i).padStart(2,"0") + ".ts");
  const doc = "README.md", excluded = "src/private.ts", unavailable = "src/unavailable.ts";
  const scope = reviewSourceScope({
    scope: {mode:"full"},
    repo_manifest:{files:[...paths,doc,excluded].map(path=>({path,hash:"frozen-"+path})).concat([{path:unavailable}])},
    file_disposition:{files:[...paths,excluded,unavailable].map(path=>({path,status:"included"})).concat([{path:doc,status:"doc_only"}])},
    intent_checkpoint:{excluded_scope:[{path:excluded,reason:"Out of scope."}]},
  });
  const admitted = scope.includedSourcePaths;
  assert.ok(scope.allowedContractPaths.includes(doc));
  assert.deepEqual(admitted,[...paths,unavailable]);
  const hashes = new Map(scope.allowedSourcePaths.map(path=>[path,scope.files.get(path).hash]));
  const base = {schema_version,snapshot_id,questions:[],inventory:[],omissions:[],
    lens_decisions:[{lens:"architecture",decision:"selected",reason:"User selected architecture only."}]};
  const currentBase = [{submission:{
    inspected_sources:[{path:paths[0]},{path:paths[1]},{path:paths[2]},{path:doc},{path:excluded}],
    answer:{parts:[{observation_ids:["base-observation"]}],observations:[{
      kind:"source_confirmed",observation_id:"base-observation",
      source_refs:[{path:paths[0],start_line:1},{path:paths[2]},{path:doc,start_line:1},{path:excluded,start_line:1}],
    }]},
  }}];
  assert.equal(admittedFileCoverage(admitted,currentBase,new Set([paths[2]])).inspected_count,2);
  const extended = extendFullFileReview(base,admitted,hashes,currentBase,new Set());
  assert.deepEqual(base.questions,[]);
  assert.deepEqual(extended.questions.map(q=>q.requested_parts.length),[8,2]);
  assert.deepEqual(extended.questions.flatMap(q=>q.requested_parts.map(p=>p.part_id)),paths.slice(1));
  assert.ok(extended.questions.every(q=>q.lens==="architecture"));
  assert.deepEqual(extendFullFileReview(base,admitted,hashes,currentBase,new Set()),extended);

  const question = extended.questions[1], name = "fixture-assignment";
  const identity = {schema_version,snapshot_id,question_id:question.question_id,revision_id:question.revision_id};
  const fileA = paths[9], fileB = paths[10];
  const ref = {path:fileA,start_line:1};
  const sourceFiles = [fileA,fileB,doc].map(path=>({path,line_count:1,fingerprint:"frozen-"+path}));
  const binding = {question,assignment:{...identity,assignment_id:name,available_evidence_ids:[],
    authorized_scope:{include:["src",doc],exclude:[]}},sourceFiles,evidence:[],dependencies:question.source_dependencies};
  const observation = {...identity,part_id:fileA,observation_id:"obs",kind:"source_confirmed",statement:"Actual declaration.",source_refs:[ref],evidence_refs:[]};
  const clean = {part_id:fileA,outcome:"clean",observation_ids:["obs"]};
  const inaccessible = {part_id:fileB,outcome:"inconclusive",reason:"The reviewer could not open the frozen file.",observation_ids:[]};
  const answer = {...identity,submission_id:"coverage-fixture",assignment_id:name,limitations:[],inspected_sources:[ref],evidence_ids:[],
    answer:{outcome:"inconclusive",parts:[clean,inaccessible],observations:[observation],findings:[]}};
  const admit = candidate=>acceptQuestionReview([],binding,candidate,"2026-11-28T00:00:00Z");
  assert.throws(()=>admit({...answer,inspected_sources:[]}),/unread assigned file/);
  assert.throws(()=>admit({...answer,inspected_sources:[ref,{path:fileB}]}),/source-confirmed evidence/);
  assert.throws(()=>admit({...answer,inspected_sources:[ref,{path:doc}]}),/only for its assigned files/);
  assert.throws(()=>admit({...answer,answer:{...answer.answer,observations:[{...observation,source_refs:[{path:doc}]}]}}),/own assigned file/);
  assert.throws(()=>admit({...answer,answer:{...answer.answer,parts:[clean]}}),/each assigned file/);
  const {record} = admit(answer);
  // When a base reopen removes the previous read of paths[0], the old second packet
  // stays unchanged despite an earlier lexicographic gap and arbitrary answer part order.
  const reorderedRecord = { ...record, submission:{...record.submission,answer:{...record.submission.answer,parts:[inaccessible,clean]}}};
  const duringReopen = extendFullFileReview(base,admitted,hashes,[],new Set(),[reorderedRecord],false);
  assert.deepEqual(duringReopen.questions,[question]);
  const afterReopen = extendFullFileReview(base,admitted,hashes,[],new Set(),[reorderedRecord]);
  assert.ok(afterReopen.questions.some(q=>q.question_id===question.question_id && q.revision_id===question.revision_id));
  assert.deepEqual(afterReopen.questions.flatMap(q=>q.requested_parts.map(p=>p.part_id)),paths);
  const {buildReviewQuestionPlan} = await load("audit/orchestrator/questionPlanning.js");
  const noSemanticSubjects = buildReviewQuestionPlan({
    repo_manifest:{files:[{path:paths[0],hash:hashes.get(paths[0])}]},
    file_disposition:{files:[{path:paths[0],status:"included"}]},
  },{snapshotId:snapshot_id});
  assert.deepEqual(noSemanticSubjects.questions,[]);
  const restricted = {...noSemanticSubjects,lens_decisions:noSemanticSubjects.lens_decisions.map(row=>
    row.lens==="architecture"?row:{...row,decision:"excluded",reason:"Explicitly excluded."})};
  const fileOnly = extendFullFileReview(restricted,admitted,hashes,[],new Set());
  assert.ok(fileOnly.questions.length>0 && fileOnly.questions.every(q=>q.lens==="architecture"));
  assert.equal(fileOnly.lens_decisions.find(row=>row.lens==="architecture").decision,"selected");
  assert.equal(restricted.lens_decisions.find(row=>row.lens==="architecture").decision,"not_applicable");
  assert.equal(extendFullFileReview({...restricted,lens_decisions:[]},admitted,hashes,[],new Set()).questions.length,0);
  const coverage = admittedFileCoverage(admitted,[...currentBase,record],new Set());
  assert.deepEqual(coverage,{admitted_count:12,inspected_count:2,gaps:paths.slice(1,9).concat([fileB,unavailable])});
  const report = buildQuestionAuditFindingsReport({plan:extended,accepted:[record],evidence:[],
    dependenciesByQuestion:new Map([[question.question_id,record.dependency_bindings]]),auditRead:null,fileCoverage:coverage});
  assert.equal(report.question_review.completion,"incomplete");
  assert.deepEqual(report.question_review.file_coverage,coverage);
  assert.equal(report.summary.audited_file_count,2);

  const { buildTerminalStep } = await load("audit/cli/nextStepHelpers.js");
  const { mkdtemp, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const root = await mkdtemp(join(tmpdir(),"audit-coverage-terminal-"));
  t.after(() => rm(root,{recursive:true,force:true}));
  const artifactsDir = join(root,".audit-tools","audit");
  const terminal = await buildTerminalStep({root,artifactsDir},{
    audit_report:"Working report",audit_findings:report,review_plan:base,
  },{status:"complete",blockers:[],obligations:[]},"wrong success");
  assert.equal(terminal.kind,"blocked");
  assert.equal(terminal.state.status,"blocked");
  assert.match(terminal.reason,/2 of 12 admitted files/);
  await assert.rejects(stat(join(root,".audit-tools","audit-report.md")),{code:"ENOENT"});
});

test("supplemental review preserves significant path whitespace without putting it in part IDs", async () => {
  const { admittedFileCoverage, extendFullFileReview, fileInspectionPartId } = await load("audit/orchestrator/fullFileReview.js");
  const { acceptQuestionReview } = await load("audit/cli/dispatch/questionReviewAcceptance.js");
  const { ReviewAssignmentSchema, ReviewPlanSchema, ReviewSubmissionSchema } = await load("shared/types/reviewQuestion.js");
  const schema_version = "audit-tools/question-review/v1";
  const snapshot_id = "whitespace-snapshot";
  const admitted = [" src.ts","src.ts","src/ending.ts "];
  const fingerprints = new Map(admitted.map((path,i)=>[path,"hash:"+i]));
  const empty = new Set();
  const base = {schema_version,snapshot_id,questions:[],inventory:[],omissions:[],
    lens_decisions:[{lens:"behavior",decision:"selected",reason:"Inspect admitted source."}]};
  const effective = ReviewPlanSchema.parse(extendFullFileReview(base,admitted,fingerprints,[],empty));
  const [question] = effective.questions;
  const ids = admitted.map(fileInspectionPartId);
  assert.equal(ids[1],admitted[1],"valid preexisting part IDs are unchanged");
  assert.equal(new Set(ids).size,admitted.length);
  assert.deepEqual(question.requested_parts.map(part=>part.part_id),ids);
  const identity = {schema_version,snapshot_id,question_id:question.question_id,revision_id:question.revision_id};
  const assignment_id = "whitespace-fixture";
  const refs = admitted.map(path=>({path,start_line:1}));
  const sources = admitted.map(path=>({path,line_count:1,fingerprint:fingerprints.get(path)}));
  const assignment = ReviewAssignmentSchema.parse({...identity,assignment_id,available_evidence_ids:[],
    suggested_sources:refs,authorized_scope:{include:[" src.ts","src.ts","src"],exclude:[]}});
  assert.deepEqual(assignment.authorized_scope.include,[" src.ts","src.ts","src"]);
  const binding = {question,assignment,sourceFiles:sources,evidence:[],dependencies:question.source_dependencies};
  const submission = ReviewSubmissionSchema.parse({...identity,submission_id:"whitespace-answer",assignment_id,limitations:[],
    inspected_sources:refs,evidence_ids:[],
    answer:{outcome:"clean",findings:[],parts:ids.map((part_id,i)=>({part_id,outcome:"clean",observation_ids:["obs-"+i]})),
      observations:ids.map((part_id,i)=>({...identity,part_id,observation_id:"obs-"+i,kind:"source_confirmed",
        statement:"Reviewed exact literal file.",source_refs:[refs[i]],evidence_refs:[]}))}});
  assert.throws(()=>acceptQuestionReview([],binding,{...submission,
    inspected_sources:refs.map(ref=>({...ref,path:ref.path.trim()}))},"2026-11-28T00:00:00Z"),/unread assigned file|outside this assignment/);
  const {record} = acceptQuestionReview([],binding,submission,"2026-11-28T00:00:00Z");
  assert.deepEqual(admittedFileCoverage(admitted,[record],empty),{admitted_count:3,inspected_count:3,gaps:[]});
  assert.deepEqual(extendFullFileReview(base,admitted,fingerprints,[],empty,[record],false),effective);
});
