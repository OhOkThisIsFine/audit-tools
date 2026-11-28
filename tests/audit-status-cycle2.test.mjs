import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { pathToFileURL } from "node:url";

const checkout = resolve(process.env.AUDIT_TOOLS_TRIAL_CHECKOUT ?? process.cwd());
const load = file => import(pathToFileURL(join(checkout, "dist", file)).href);
const exec = promisify(execFile);

async function fixture(t) {
  const temp = await realpath(tmpdir());
  const root = await mkdtemp(join(temp, "audit-status-cycle2-"));
  t.after(async () => {
    const name = relative(temp, await realpath(root));
    assert.ok(name.startsWith("audit-status-cycle2-") && !isAbsolute(name) && !name.includes(sep));
    await rm(root, { recursive: true, force: true });
  });
  const artifacts = join(root, ".audit-tools", "audit");
  const put = async (relativePath, value) => {
    const path = join(artifacts, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const step = (step_kind, run_id, artifact_paths, progress = { summary: "Ready when published." }) =>
    put("steps/current-step.json", {
      contract_version: "audit-code-step/v1alpha1", status: "ready",
      step_kind, run_id, progress, artifact_paths, repo_root: root, artifacts_dir: artifacts,
      prompt_path: join(artifacts, "unused.md"), allowed_commands: [], stop_condition: "Fixture",
    });
  const status = async (expectedExitCode = 0) => {
    const inventory = async () => {
      const entries = await readdir(artifacts, { recursive: true, withFileTypes: true });
      return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
        const path = join(entry.parentPath, entry.name);
        return [relative(artifacts, path), await readFile(path, "utf8")];
      })));
    };
    const before = await inventory();
    let output;
    try {
      const result = await exec(process.execPath, [join(checkout, "audit-code.mjs"), "status", "--root", root], {
        cwd: root, windowsHide: true, timeout: 15000,
      });
      assert.equal(expectedExitCode, 0);
      output = result.stdout;
    } catch (error) {
      if (!expectedExitCode) throw error;
      assert.equal(error.code, expectedExitCode, error.stderr);
      output = error.stdout;
    }
    assert.deepEqual(await inventory(), before, "status must not write, consume or replace audit artifacts");
    return JSON.parse(output);
  };
  return { root, artifacts, put, step, status };
}

test("status projects the current bound operator decision, not the ready publication", async t => {
  const { root, artifacts, put, step, status } = await fixture(t);
  const id = randomUUID();
  await step("functional_preflight", id, { functional_preflight: join(artifacts, "functional-preflight.json") });
  assert.equal((await status(1)).status, "no_active_audit", "status must not create a missing consent binding");
  await put("run-consent.json", {
    schema_version: "audit-run-consent/v1", run_id: id, repository_root: root, decisions: {},
  });
  assert.equal((await status()).functional_preflight.status, "pending");

  const report = {
    contract_version: "audit-functional-preflight/v1", run_id: id, repository_root: root,
    source_inspection: { available: true, evidence: "Synthetic source inspection" },
    relationship_inspection: { available: false, evidence: "Synthetic missing capability" },
    decision: "stop",
  };
  const reportPath = await put("functional-preflight.json", report);
  const stopped = (await status()).functional_preflight;
  assert.equal(stopped.status, "blocked");
  assert.match(stopped.summary, /operator stopped/);

  for (const unbound of [{ run_id: randomUUID() }, { repository_root: join(root, "other") }, { decision: "ready" }]) {
    await put("functional-preflight.json", { ...report, ...unbound });
    assert.equal((await status()).functional_preflight.status, "pending");
  }
  await writeFile(reportPath, "{bad json");
  assert.equal((await status()).functional_preflight.status, "pending");
  await put("functional-preflight.json", {
    ...report, relationship_inspection: { available: true, evidence: "Synthetic relationship inspection" }, decision: "ready",
  });
  assert.equal((await status()).functional_preflight.status, "ready");
  await put("functional-preflight.json", {
    ...report, decision: "degraded", operator_approved_degraded: true, limitation: "Synthetic relationship coverage unavailable",
  });
  assert.equal((await status()).functional_preflight.status, "degraded");
});

test("ordinary questions wait while only the exact current independent systemic result permits continuation", async t => {
  const { root, artifacts, put, step, status } = await fixture(t);
  const { publishAuditQuestionWorkload } = await load("audit/cli/dispatch/hostHandoff.js");
  const { publishAuditReviewBindings } = await load("audit/cli/auditReviewBindings.js");
  const { AUDIT_GATE_SUBMISSION_SCOPE, laneSubmissionId, laneSubmissionPath, systemicChallengeLane } =
    await load("audit/cli/laneSubmissions.js");
  const { systemicPremiseToken, systemicReviewInputRevision } = await load("audit/orchestrator/systemicChallengeExecutor.js");
  const { hashContent } = await load("shared/hash.js");
  const runId = "question-review-fixture";
  const schema_version = "audit-tools/question-review/v1";
  const identity = { schema_version, snapshot_id: "snapshot", revision_id: "revision", question_id: "question" };
  const question = {
    ...identity, lens: "operability", inventory_item_ids: ["inventory"], expected_outcome: "Synthetic workflow continues",
    requested_parts: [{ part_id: "part", expectation: "Review fixture" }],
    source_dependencies: [], evidence_dependencies: [], plan_status: "active",
  };
  const assignment = {
    ...identity, assignment_id: "ordinary-answer", authorized_scope: { include: [], exclude: [] },
    suggested_sources: [], available_evidence_ids: [],
  };
  await put("audit_state.json", { status: "in_progress" });
  await put("review_session.json", { schema_version: "audit-tools/question-review-session/v1", run_id: runId });
  const review_plan = {
    schema_version, snapshot_id: identity.snapshot_id, questions: [question], inventory: [], omissions: [], lens_decisions: [],
  };
  const planPath = await put("review_plan.json", review_plan);
  const { workload_path } = await publishAuditQuestionWorkload({
    root, sourceRoot: root, artifactsDir: artifacts, runId,
    bindings: [{ question, assignment, dependencies: [], evidence: [], sourceFiles: [] }],
  });
  const bundle = { review_plan };
  const systemic_challenge = {
    generated_at: new Date().toISOString(), target: "systemic_challenge", ceiling: { rung: "deep" },
    rounds: [], converged: false, findings: [], validation_issues: [], round_token: systemicPremiseToken(bundle),
  };
  bundle.systemic_challenge = systemic_challenge;
  await put("systemic_challenge.json", systemic_challenge);
  const lane = systemicChallengeLane(systemic_challenge.rounds);
  const resultPath = laneSubmissionPath(artifacts, lane);
  const promptPath = await put("systemic-prompt.json", "Synthetic systemic prompt");
  const binding = {
    requirement: "independent", promptSha256: hashContent("fixture digest"),
    promptContentSha256: hashContent(await readFile(promptPath)), promptPath,
    semanticInputRevision: systemicReviewInputRevision(bundle),
    submissionId: laneSubmissionId(lane, AUDIT_GATE_SUBMISSION_SCOPE), runId: AUDIT_GATE_SUBMISSION_SCOPE, inputs: [],
  };
  const saveBinding = entry => publishAuditReviewBindings(artifacts, new Map([[lane, entry]]));
  const paths = { host_workload: workload_path, systemic_challenge_prompt: promptPath, systemic_challenge_results: resultPath };
  const publishStep = (kind = "systemic_challenge", artifactPaths = paths) =>
    step(kind, runId, artifactPaths, { summary: "Published with one question", pending_tasks: 1 });
  await publishStep();
  const continuation = async () => {
    const output = await status();
    assert.equal(output.question_review_handoff.pending_answers, 1);
    assert.equal(output.question_review_handoff.action, "await_results");
    return output.systemic_challenge_continuation;
  };
  assert.notEqual((await continuation()).state, "ready", "missing binding");
  await saveBinding(binding);
  assert.equal((await continuation()).state, "await_result");
  await mkdir(dirname(resultPath), { recursive: true });
  const answer = {
    contract_version: "review-submission/v1", prompt_sha256: binding.promptSha256,
    review: { mode: "independent", reason: "Synthetic independent review fixture" }, result: { findings: [] },
  };
  const saveAnswer = entry => writeFile(resultPath, JSON.stringify(entry));
  await saveAnswer(answer);
  assert.equal((await continuation()).state, "ready");
  assert.equal((await continuation()).action, "continue");
  await publishStep("systemic_challenge", { ...paths, systemic_challenge_results: promptPath });
  assert.equal((await continuation()).state, "stale");
  await publishStep();
  for (const invalid of [
    { prompt_sha256: hashContent("stale digest") },
    { result: { findings: [null] } },
    { review: { mode: "degraded", reason: "Not independent" } },
  ]) {
    await saveAnswer({ ...answer, ...invalid });
    assert.notEqual((await continuation()).state, "ready");
  }
  await saveAnswer(answer);
  await saveBinding({ ...binding, semanticInputRevision: "stale-input" });
  assert.equal((await continuation()).state, "stale");
  await saveBinding(binding);
  const originalPrompt = await readFile(promptPath);
  await writeFile(promptPath, "Modified after the binding was issued.");
  assert.equal((await continuation()).state, "stale");
  await writeFile(promptPath, originalPrompt);
  await put("systemic_challenge.json", {
    ...systemic_challenge, folded_submission_hashes: [hashContent(lane + "\n" + hashContent(await readFile(resultPath)))],
  });
  assert.equal((await continuation()).state, "stale", "an already-folded result cannot advance the round again");
  await put("systemic_challenge.json", systemic_challenge);
  await writeFile(planPath, JSON.stringify({ ...review_plan, questions: [{ ...question, revision_id: "new-revision" }] }));
  const independent = await status();
  assert.equal(independent.question_review_handoff.state, "stale");
  assert.equal(independent.systemic_challenge_continuation.state, "ready");
  await writeFile(planPath, JSON.stringify(review_plan));
  await publishStep("dispatch_review");
  assert.equal(await continuation(), null, "no published systemic round");
});
