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
