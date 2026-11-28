import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { contentSha256 as hash, deriveResultId, hashContent } from "../dist/shared/index.js";
import { executionPlanPaths, executionPlanRevision, readApprovedExecutionPlan, readCanonicalPlan, readExecutionIntent } from "../dist/remediate/contractPipeline/executionPlan.js";
import { intakePaths } from "../dist/remediate/intake.js";
import { runClosePhase } from "../dist/remediate/phases/close.js";
import { currentHostBoundaryState } from "../dist/remediate/state/runIdentity.js";
import { StateStore } from "../dist/remediate/state/store.js";
import { buildNextContractPipelineStep } from "../dist/remediate/steps/contractPipeline.js";
import { prepareRemediationHostHandoff } from "../dist/remediate/steps/dispatch/hostHandoff.js";
import { decideNextStep } from "../dist/remediate/steps/nextStep.js";
import { REMEDIATION_HOST_DECISION_CONTRACT_VERSION } from "../dist/remediate/steps/types.js";
import { bindWaveSimplification, waveResponsePath } from "../dist/remediate/steps/waveSimplification.js";

const put = (path, json) => writeFile(path, JSON.stringify(json));
const get = async path => JSON.parse(await readFile(path, "utf8"));
const prompt = async pending => readFile((await pending).prompt_path, "utf8");
const absent = path => assert.rejects(readFile(path), { code: "ENOENT" });
const roles = ["critique", "critic", "judge"];
const review = { mode: "independent", reason: "Synthetic independent response fixture." };
const outcome = {
  critique: { verdict: "approved", issues: [] },
  critic: { counterexamples: [{
    id: "fixture-risk", claim: "Fixture data could change", reproduction_steps: ["Inspect local fixture data"],
    expected: "Current value", actual: "Maybe old value", requirement_ids: ["REQ-read"], unit_ids: ["UNIT-read"],
  }] },
  judge: {
    verdict: "approved", disposition_assessments: [],
    classifications: [{ counterexample_id: "fixture-risk", classification: "residual_risk", rationale: "Synthetic residual risk." }],
    requirement_assessments: ["REQ-landed", "REQ-unchanged", "REQ-read"].map(requirement_id => ({
      requirement_id, verdict: "satisfied", evidence: ["Fixture evidence."],
    })),
  },
};

async function fixture(t, { closing = false, requestDriven = true } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "same-source-replan-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const artifactsDir = join(root, ".audit-tools", "remediation");
  const paths = executionPlanPaths(artifactsDir);
  const store = new StateStore(artifactsDir);
  const runId = "replan-fixture";
  const options = { root, artifactsDir };
  const checkpoint = intakePaths(artifactsDir).intentCheckpoint;
  const readPath = join(root, "read.txt");
  const requestPath = join(root, "request.txt");
  const project = file => join(root, file);
  const git = (...args) => execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
  git("init", "--template=", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  const initialInput = "Inspect the fixture.";
  await writeFile(readPath, "original reviewed context");
  await writeFile(requestPath, initialInput);
  await writeFile(project("landed.txt"), "before");
  await writeFile(project("nochange.txt"), "already correct");
  git("add", ".");
  git("commit", "-qm", "Fixture baseline");
  await mkdir(paths.directory, { recursive: true });
  const intent = { schema_version: "intent-checkpoint/v1", confirmed_by: "host", confirmed_at: new Date().toISOString(),
    scope_summary: "Local text files", intent_summary: "Inspect fixture", closing_action: closing ? "commit" : "none" };
  await put(checkpoint, intent);
  const request = { id: "fixture-request", text: initialInput, source_paths: [requestPath] };
  const units = [
    ["UNIT-landed", "REQ-landed", "landed.txt"],
    ["UNIT-unchanged", "REQ-unchanged", "nochange.txt"],
    ["UNIT-read", "REQ-read", "read.txt"],
  ];
  const plan = {
    plan_id: runId, objective: "Inspect local fixture files", non_goals: [], source_dispositions: [],
    requirements: units.map(([, id, file]) => ({ id, description: "Inspect " + file, change_kind: "behavior_change",
      source_finding_ids: [], assertions: [
        { kind: "positive", description: "File is inspected", scope_paths: [file] },
        { kind: "negative", description: "Inspection does not report stale content", scope_paths: [file] },
      ] })),
    units: units.map(([id, req, file]) => ({ id, title: "Inspect " + file, description: "Check contents",
      source_finding_ids: [], requirement_ids: [req], dependencies: [], read_paths: [file], allowed_files: [file],
      required_tests: id === "UNIT-landed" ? ["node --version"] : [], affected_interfaces: [], addresses_counterexample_ids: [] })),
  };
  await put(paths.source, { plan_id: runId, findings: [], audit_read: null, ...(requestDriven ? { request } : {}),
    sources: [{ path: requestPath, sha256: hashContent(initialInput) }], intent: await readExecutionIntent(artifactsDir) });
  const next = extra => decideNextStep({ ...options, ...extra });
  const pipeline = () => buildNextContractPipelineStep({ ...options, runId });
  const submit = (base, proposed) => put(paths.submission, { base_revision_sha256: base, plan: proposed });
  const owner = revision => put(paths.ownerDecision, { revision_sha256: revision, confirmed_by: "host",
    approved_unit_ids: plan.units.map(unit => unit.id), declined_units: [], deferred_findings: [] });
  const risk = revision => put(paths.riskDecisions, { revision_sha256: revision, confirmed_by: "host",
    accepted_counterexample_ids: ["fixture-risk"] });
  const reviewInput = async role => ({ contract_version: "review-submission/v1",
    prompt_sha256: (await get(paths.review(role).request)).prompt_sha256, review, result: outcome[role] });
  await submit(null, plan);
  assert.match(await prompt(pipeline()), requestDriven ? /Confirm the requested change plan/u : /Executable plan critique/u);
  const a = await readCanonicalPlan(artifactsDir);
  if (requestDriven) await owner(a.revision_sha256);
  const reviewA = {};
  for (const role of roles) {
    assert.match(await prompt(pipeline()), new RegExp("Executable plan " + role, "u"));
    reviewA[role] = await reviewInput(role);
    await put(paths.review(role).submission, reviewA[role]);
  }
  assert.match(await prompt(pipeline()), /Accept or repair remaining risks/u);
  await risk(a.revision_sha256);
  assert.equal(await pipeline(), null);
  await writeFile(project("landed.txt"), "after");
  git("add", "landed.txt");
  git("commit", "-qm", "Accepted fixture edit after approval");
  const landedCommit = git("rev-parse", "HEAD");
  const state = {
    status: closing ? "closing" : "implementing", run_start_dirty: [], run_start_dirty_encoding: "git-z/v1",
    plan: { ...a.plan, ...(requestDriven ? { request } : {}), findings: [], audit_read: null, review_revision_sha256: a.revision_sha256,
      project_type: "unknown", candidate_closing_actions: ["none", "commit"] },
    conformance_review: { run_id: runId, enabled: false, checkpoint_sha256: hash(intent) },
    items: {
      "UNIT-landed": { unit_id: "UNIT-landed", status: "resolved", host_landed_commit: landedCommit, host_landed_files: ["landed.txt"] },
      "UNIT-unchanged": { unit_id: "UNIT-unchanged", status: "resolved_no_change", host_result_evidence: ["Already correct."] },
      "UNIT-read": closing ? { unit_id: "UNIT-read", status: "resolved_no_change" } : { unit_id: "UNIT-read", status: "pending" },
    },
    ...(closing ? { closing_plan: { action: "commit" } } : {}),
  };
  await store.saveState(state);
  const persisted = await store.loadState();
  const ack = join(artifactsDir, "confirm_resume_ack.json");
  await put(ack, { choice: "resume" });
  const handoff = async (projection = persisted) => prepareRemediationHostHandoff({
    ...options, runId, baselineCommit: git("rev-parse", "HEAD"),
    state: currentHostBoundaryState({ ...projection, status: "implementing" }),
  });
  const drift = async (value = "different committed read context") => {
    await writeFile(readPath, value);
    git("add", "read.txt");
    git("commit", "-qm", "Change fixture context");
  };
  return { ...options, paths, store, next, pipeline, submit, owner, risk, reviewInput, reviewA, a, state: persisted,
    handoff, drift, checkpoint, intent, requestPath, initialInput, ack, git };
}

async function assertHistorical(path, saved) {
  const bundle = await get(path);
  assert.deepEqual(bundle, saved);
  const { canonical, approval, owner_decision, risk_decision, history, reviews } = bundle;
  assert.equal(canonical.revision_sha256, executionPlanRevision(canonical.plan, canonical.source_sha256, canonical.context_files));
  assert.equal(approval.revision_sha256, canonical.revision_sha256);
  assert.equal(approval.owner_decision_sha256, hash(owner_decision.value));
  assert.equal(approval.risk_decision_sha256, hash(risk_decision.value));
  assert.equal(approval.history_sha256, hash(history));
  assert.equal(approval.judge_input_sha256, reviews.judge.input_sha256);
  for (const role of roles) assert.equal(approval.review_sha256[role], hash(reviews[role]));
}

test("same-source replan holds original authority, preserves exact historical evidence, and activates only revised semantics", async t => {
  const f = await fixture(t);
  const { paths, a, next, handoff, store } = f;
  const revision = a.revision_sha256;
  const evidencePath = paths.approvalHistory(revision);
  const saved = { canonical: await get(paths.canonical), approval: await get(paths.approval),
    owner_decision: { present: true, value: await get(paths.ownerDecision) },
    risk_decision: { present: true, value: await get(paths.riskDecisions) }, history: await get(paths.history),
    reviews: Object.fromEntries(await Promise.all(roles.map(async role => [role, await get(paths.review(role).accepted)]))),
  };
  const bytesA = await readFile(paths.canonical);
  // The accepted implementation changed a reviewed path after approval and
  // must not be mistaken for stale context or start new authoring.
  assert.equal(await f.pipeline(), null);
  assert.deepEqual((await handoff()).workload.work_items.map(item => item.id), ["UNIT-read"]);
  await f.drift();
  await assert.rejects(handoff(), { code: "plan_repair_required", message: /Reviewed repository context changed: read.txt/u });
  const locked = /"UNIT-landed":\["REQ-landed"\],"UNIT-unchanged":\["REQ-unchanged"\]/u;
  const author = await prompt(next({ forceReplan: true }));
  assert.match(author, /operator requested a revised plan/u);
  assert.match(author, /Reviewed repository context changed: read.txt/u);
  assert.doesNotMatch(author, /Reviewed repository context changed: landed.txt/u);
  assert.match(author, locked);
  assert.match(author, /entire linked requirement unchanged[\s\S]*Do not edit, remove, or retire[\s\S]*explicit follow-up requirements and units/u);
  assert.deepEqual(await get(paths.pendingReplan), { plan_id: a.plan.plan_id, base_revision_sha256: revision });
  await assertHistorical(evidencePath, saved);
  assert.match(await prompt(next()), /operator requested a revised plan/u);
  await assert.rejects(handoff(), { code: "plan_repair_required", message: /same-source replacement is pending/u });

  for (const base of [revision, null]) {
    await f.submit(base, a.plan);
    const retry = await prompt(next());
    assert.match(retry, /must change reviewed plan semantics/u);
    assert.match(retry, locked);
    assert.deepEqual(await readFile(paths.canonical), bytesA);
    assert.deepEqual(await get(paths.approval), saved.approval);
  }
  const retired = structuredClone(a.plan);
  retired.requirements = retired.requirements.filter(r => r.id !== "REQ-unchanged");
  await put(paths.submission, { base_revision_sha256: revision, plan: retired,
    retired_requirements: [{ id: "REQ-unchanged", reason: "Attempt to retire an evidenced requirement.", replaced_by: [] }] });
  const retirementRefusal = await prompt(next());
  assert.match(retirementRefusal, /REQ-unchanged is already evidenced/u);
  assert.match(retirementRefusal, locked);
  assert.deepEqual(await readFile(paths.canonical), bytesA);

  const replacement = structuredClone(a.plan);
  replacement.objective += " and verify the revised context";
  replacement.units.find(unit => unit.id === "UNIT-read").description = "Check the revised contents";
  for (const [change, refused] of [
    [p => { p.units.find(u => u.id === "UNIT-landed").description = "Changed"; }, /Accepted unit UNIT-landed is immutable/u],
    [p => { p.requirements.find(r => r.id === "REQ-unchanged").description = "Changed"; }, /REQ-unchanged is already evidenced/u],
  ]) {
    const bad = structuredClone(replacement);
    change(bad);
    await f.submit(revision, bad);
    assert.match(await prompt(next()), refused);
    assert.deepEqual(await readFile(paths.canonical), bytesA);
  }
  await f.submit(revision, replacement);
  assert.match(await prompt(next()), /Confirm the requested change plan/u);
  const b = await readCanonicalPlan(f.artifactsDir);
  const bytesB = await readFile(paths.canonical);
  assert.notEqual(b.revision_sha256, revision);
  await f.submit(b.revision_sha256, a.plan);
  assert.match(await prompt(next()), /must change reviewed plan semantics/u);
  assert.deepEqual(await readFile(paths.canonical), bytesB);
  await assert.rejects(handoff(), { code: "plan_repair_required" });
  await assert.rejects(runClosePhase({ ...f.state, status: "closing", closing_plan: { action: "none" } }, f), { code: "plan_repair_required" });

  await rm(paths.submission);
  assert.match(await prompt(next()), /Confirm the requested change plan/u);
  await f.owner(b.revision_sha256);
  for (const role of roles) {
    assert.match(await prompt(next()), new RegExp("Executable plan " + role, "u"));
    await put(paths.review(role).submission, f.reviewA[role]);
    assert.match(await prompt(next()), /Refused response/u);
    await put(paths.review(role).submission, await f.reviewInput(role));
  }
  assert.match(await prompt(next()), /Accept or repair remaining risks/u);
  await f.risk(b.revision_sha256);
  // Interruption after review overwrites the shared slots but before activation.
  assert.equal(await f.pipeline(), null);
  assert.deepEqual((await readApprovedExecutionPlan(f.artifactsDir)).canonical, b);
  assert.equal((await store.loadState()).plan.review_revision_sha256, revision);
  await assertHistorical(evidencePath, saved);
  await assert.rejects(handoff(), { code: "plan_repair_required" });
  await assert.rejects(runClosePhase({ ...f.state, status: "closing", closing_plan: { action: "none" } }, f), { code: "plan_repair_required" });

  // Deny the local projection write after state saves, then require exact live
  // receipt readback before finishing the interrupted activation.
  const projectionPath = join(f.artifactsDir, "remediation_plan.json");
  await mkdir(projectionPath);
  assert.match(await prompt(next()), /pending replan could not finish/u);
  const persistedB = await store.loadState();
  assert.equal(persistedB.plan.review_revision_sha256, b.revision_sha256);
  await assert.rejects(handoff(persistedB), { code: "plan_repair_required" });
  await rmdir(projectionPath);
  const approvalB = await get(paths.approval);
  await put(paths.approval, { ...approvalB, judge_input_sha256: "0".repeat(64) });
  assert.match(await prompt(next()), /No current independently approved executable plan/u);
  await absent(projectionPath);
  assert.equal((await get(paths.pendingReplan)).base_revision_sha256, revision);
  await put(paths.approval, approvalB);

  const resumed = await next();
  assert.equal(resumed.step_kind, "dispatch_implement", await prompt(resumed));
  await absent(paths.pendingReplan);
  assert.equal((await get(projectionPath)).review_revision_sha256, b.revision_sha256);
  const activeB = await store.loadState();
  assert.deepEqual(activeB.conformance_review, f.state.conformance_review);
  for (const id of ["UNIT-landed", "UNIT-unchanged"]) assert.deepEqual(activeB.items[id], f.state.items[id]);
  assert.deepEqual(activeB.plan.requirements.slice(0, 2), f.state.plan.requirements.slice(0, 2));
  assert.deepEqual(activeB.plan.units.slice(0, 2), f.state.plan.units.slice(0, 2));
  await assertHistorical(evidencePath, saved);
  assert.deepEqual((await handoff(activeB)).workload.work_items.map(item => item.id), ["UNIT-read"]);
  await f.drift("second unexplained edit after activation");
  await assert.rejects(handoff({ ...activeB, host_handoff: undefined }), { code: "plan_repair_required", message: /Reviewed repository context changed: read.txt/u });
});

test("force and pending marker respect changed input, actual source, intent, and closing boundaries", async t => {
  const f = await fixture(t, { closing: true });
  const { paths, next } = f;
  await f.drift();
  const other = join(f.root, "new-request.txt");
  await writeFile(other, "Different request");
  for (const flags of [{ input: other }, { guidanceText: "A different request" }, { findingIds: ["NEW"] }]) {
    const step = await next({ ...flags, forceReplan: true });
    assert.equal(step.step_kind, "input_conflict", await prompt(step));
    assert.doesNotMatch(await prompt(step), /merge/u);
    await absent(paths.pendingReplan);
  }
  await rm(f.ack);
  const normal = await next({ input: undefined });
  assert.equal(normal.step_kind, "confirm_resume_or_restart");
  assert.doesNotMatch(await prompt(normal), /merge/iu);
  await put(f.ack, { choice: "resume" });
  await writeFile(f.requestPath, "Changed bound source.");
  assert.match(await prompt(next({ forceReplan: true })), /No current exact approval/u);
  await absent(paths.pendingReplan);
  await writeFile(f.requestPath, f.initialInput);
  assert.match(await prompt(next({ forceReplan: true })), /operator requested a revised plan/u);
  let closeCalls = 0;
  const finalization = () => next({ finalizeClosing: true, closingCommandRunner: async () => { closeCalls++; throw new Error("unexpected closing"); } });
  assert.match(await prompt(next()), /operator requested a revised plan/u);
  assert.match(await prompt(finalization()), /operator requested a revised plan/u);
  assert.equal(closeCalls, 0);
  assert.equal((await f.store.loadState()).status, "closing");
  await assert.rejects(runClosePhase({ ...f.state, status: "closing", closing_plan: { action: "none" } }, f), { code: "plan_repair_required" });

  await writeFile(f.requestPath, "Changed after replan.");
  assert.match(await prompt(next()), /changed or disappeared/u);
  await writeFile(f.requestPath, f.initialInput);
  await put(f.checkpoint, { ...f.intent, intent_summary: "Changed confirmed intent" });
  assert.match(await prompt(next()), /confirmed scope or intent changed/u);
  assert.equal((await get(paths.pendingReplan)).base_revision_sha256, f.a.revision_sha256);
  await put(f.checkpoint, f.intent);
  const archive = paths.approvalHistory(f.a.revision_sha256);
  await rm(archive);
  assert.match(await prompt(next()), /original review evidence .* cannot be verified/u);
  await put(paths.pendingReplan, { ...await get(paths.pendingReplan), unknown: true });
  assert.match(await prompt(next()), /Cannot verify the pending replan marker/u);
  await assert.rejects(f.handoff(), { code: "plan_repair_required" });
});

test("same-source recovery requires a new owner decision even without a separate conversation request", async t => {
  const f = await fixture(t, { requestDriven: false });
  await absent(f.paths.ownerDecision);
  await f.drift();
  assert.match(await prompt(f.next({ forceReplan: true })), /Reviewed repository context changed: read.txt/u);
  const replacement = structuredClone(f.a.plan);
  replacement.units.find(unit => unit.id === "UNIT-read").description = "Inspect the newly observed read context";
  await f.submit(f.a.revision_sha256, replacement);
  assert.match(await prompt(f.next()), /Confirm the requested change plan/u);
  const b = await readCanonicalPlan(f.artifactsDir);
  await f.owner(f.a.revision_sha256);
  assert.match(await prompt(f.next()), /Confirm the requested change plan/u);
  await f.owner(b.revision_sha256);
  assert.match(await prompt(f.next()), /Executable plan critique/u);
});

test("force does not replace an open handoff and reconciles the exact existing submission without new work", async t => {
  const f = await fixture(t);
  const issued = await f.handoff();
  const [item] = issued.workload.work_items;
  await f.store.saveState({ ...f.state, host_handoff: issued.handoff_record, conformance_review: issued.conformance_review });
  const step = await f.next({ forceReplan: true });
  assert.match(await prompt(step), /existing host handoff still has bound work outstanding/u);
  await absent(f.paths.pendingReplan);
  assert.deepEqual((await f.store.loadState()).host_handoff, issued.handoff_record);
  await put(resolve(f.root, item.result_path), {
    contract_version: REMEDIATION_HOST_DECISION_CONTRACT_VERSION,
    result_id: deriveResultId(item.id, item.prompt.sha256), run_id: f.a.plan.plan_id, work_item_id: item.id,
    prompt_sha256: item.prompt.sha256, outcome: { status: "resolved_no_change", evidence: ["Fixture is already correct."] },
  });
  assert.match(await prompt(f.next({ forceReplan: true })), /Existing host results were reconciled without dispatching/u);
  const reconciled = await f.store.loadState();
  assert.equal(reconciled.items[item.id].status, "resolved_no_change");
  assert.equal(reconciled.host_handoff, undefined);
  await absent(f.paths.pendingReplan);
});

test("a held combined wave consumes its own response before force replan can open a marker", async t => {
  const f = await fixture(t);
  const issued = await f.handoff();
  const landed = f.state.items["UNIT-landed"].host_landed_commit;
  const baseline = f.git("rev-parse", landed + "^");
  await writeFile(join(f.root, "nochange.txt"), "a second combined-wave edit");
  f.git("add", "nochange.txt");
  f.git("commit", "-qm", "Second accepted fixture edit");
  const second = f.git("rev-parse", "HEAD");
  const state = {
    ...f.state,
    host_handoff: { ...issued.handoff_record, baseline_commit: baseline, work_item_ids: ["UNIT-landed", "UNIT-unchanged"] },
    items: { ...f.state.items, "UNIT-unchanged": {
      unit_id: "UNIT-unchanged", status: "resolved", host_landed_commit: second, host_landed_files: ["nochange.txt"],
    } },
  };
  await bindWaveSimplification(f.root, state);
  delete state.host_handoff;
  await f.store.saveState(state);
  const [wave] = state.wave_simplifications;
  assert.equal(wave.problem, undefined);
  const deferred = await f.next({ forceReplan: true });
  assert.equal(deferred.step_kind, "review_wave_simplification", await prompt(deferred));
  await absent(f.paths.pendingReplan);
  assert.deepEqual((await f.store.loadState()).wave_simplifications, [wave]);
  await writeFile(join(f.root, "landed.txt"), "simplified after integration");
  f.git("add", "landed.txt");
  f.git("commit", "-qm", "Accepted wave simplification");
  const response = { receipt: wave.receipt, disposition: "applied", commit: f.git("rev-parse", "HEAD"),
    note: "Simplify the synthetic fixture under its bound focused test." };
  await put(waveResponsePath(f.artifactsDir, wave), response);
  assert.match(await prompt(f.next({ forceReplan: true })), /combined-wave review is recorded/u);
  await absent(f.paths.pendingReplan);
  const reconciled = await f.store.loadState();
  assert.deepEqual(reconciled.wave_simplifications[0].response, response);
  assert.deepEqual(reconciled.wave_simplifications[0].applied_files, ["landed.txt"]);
  assert.equal(reconciled.host_handoff, undefined);
  const author = await prompt(f.next({ forceReplan: true }));
  assert.match(author, /operator requested a revised plan/u);
  assert.doesNotMatch(author, /Reviewed repository context changed: (landed|nochange).txt/u);
});
