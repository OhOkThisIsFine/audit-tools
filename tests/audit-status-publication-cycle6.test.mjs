import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { format, promisify } from "node:util";
import { runCli } from "../dist/audit/cli.js";
import { prepareConceptualDispatch } from "../dist/audit/cli/conceptualDispatch.js";
import { functionalPreflightPath, functionalPreflightStep } from "../dist/audit/cli/functionalPreflight.js";
import { writeCurrentStep } from "../dist/audit/cli/steps.js";
import { readExistingRunConsentUnlocked } from "../dist/shared/analyzerRunConsent.js";
import { publishAuditReviewBindings } from "../dist/audit/cli/auditReviewBindings.js";
import { publishAuditQuestionWorkload } from "../dist/audit/cli/dispatch/hostHandoff.js";
import { AUDIT_GATE_SUBMISSION_SCOPE, laneSubmissionId, laneSubmissionPath, systemicChallengeLane } from "../dist/audit/cli/laneSubmissions.js";
import { systemicPremiseToken, systemicReviewInputRevision } from "../dist/audit/orchestrator/systemicChallengeExecutor.js";
import { hashContent } from "../dist/shared/hash.js";

const cli = fileURLToPath(new URL("../audit-code.mjs", import.meta.url));
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "audit-status-publication-cycle6-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, ".audit-tools", "audit");
  const steps = join(artifactsDir, "steps");
  await mkdir(steps, { recursive: true });
  const status = async (expectedExitCode, { subprocess = false } = {}) => {
    // One packaged process proves argument, stdout and exit-code wiring.
    // The remaining distinct publication states exercise the same CLI dispatch directly.
    if (!subprocess) {
      let stdout = "", stderr = "";
      const exitCode = process.exitCode;
      const log = t.mock.method(console, "log", (...args) => { stdout += format(...args) + "\n"; });
      const error = t.mock.method(console, "error", (...args) => { stderr += format(...args) + "\n"; });
      try {
        process.exitCode = undefined;
        await runCli([process.execPath, cli, "status", "--root", root]);
        assert.equal(process.exitCode ?? 0, expectedExitCode, stderr);
        return JSON.parse(stdout);
      } finally {
        log.mock.restore();
        error.mock.restore();
        process.exitCode = exitCode;
      }
    }
    const response = await exec(process.execPath, [cli, "status", "--root", root], {
      cwd: root, windowsHide: true, timeout: 15000,
    }).then(result => ({ code: 0, ...result }), error => error);
    assert.equal(response.code, expectedExitCode, response.stderr);
    return JSON.parse(response.stdout);
  };
  return { root, artifactsDir, stepPath: join(steps, "current-step.json"), status };
}

const damagedPublications = [
  ["malformed JSON", path => writeFile(path, "{malformed")],
  ["schema-invalid JSON", path => writeFile(path, JSON.stringify({ step_kind: "design_review_conceptual" }))],
  ["directory in place of the file", path => mkdir(path)],
];

function assertUnavailable(report, stepPath) {
  assert.equal(report.current_step.state, "unavailable");
  assert.equal(report.current_step.path, stepPath);
  assert.match(report.current_step.summary, /could not verify continuation/i);
  assert.equal(report.current_step.step_kind, undefined);
  assert.equal(report.current_step.action, undefined);
  assert.equal(report.functional_preflight, undefined);
  assert.equal(report.conceptual_review_progress, undefined);
}

test("before state exists, only absence reports no active audit; verified preflight still offers continuation", async t => {
  const { root, artifactsDir, stepPath, status } = await fixture(t);
  assert.equal((await status(1, { subprocess: true })).status, "no_active_audit");
  for (const [description, damage] of damagedPublications) {
    await t.test(description, async () => {
      await damage(stepPath);
      const report = await status(1);
      assert.equal(report.status, "current_step_unavailable");
      assertUnavailable(report, stepPath);
      await rm(stepPath, { recursive: true });
    });
  }

  await writeCurrentStep(await functionalPreflightStep(root, artifactsDir));
  const consent = await readExistingRunConsentUnlocked(root, artifactsDir);
  await writeFile(functionalPreflightPath(artifactsDir), JSON.stringify({
    contract_version: "audit-functional-preflight/v1",
    run_id: consent.run_id, repository_root: consent.repository_root,
    source_inspection: { available: true, evidence: "Fixture source inspection." },
    relationship_inspection: { available: true, evidence: "Fixture relationship inspection." },
    decision: "ready",
  }));
  const report = await status(0);
  assert.equal(report.current_step, undefined);
  assert.deepEqual(report.functional_preflight, {
    run_id: consent.run_id, status: "ready", summary: "Functional preflight is ready. Run next-step to continue.",
  });
  assert.equal(report.status, "preflight");
});

test("active conceptual state retains its summary without inventing progress from an unavailable publication", async t => {
  const { root, artifactsDir, stepPath, status } = await fixture(t);
  await writeFile(join(artifactsDir, "audit_state.json"), JSON.stringify({
    status: "active", last_obligation: "conceptual",
    obligations: [{ id: "conceptual", state: "present" }],
  }));
  const dispatch = await prepareConceptualDispatch({
    artifactsDir, sourceRoot: root, bundle: {}, settings: { conceptual_depth: "shallow" },
  });
  await writeFile(stepPath, JSON.stringify({
    contract_version: "audit-code-step/v1alpha1", status: "ready",
    step_kind: "design_review_conceptual", run_id: null,
    artifacts_dir: artifactsDir, repo_root: root, artifact_paths: dispatch.artifactPaths,
    prompt_path: join(artifactsDir, "unused.md"), allowed_commands: [], stop_condition: "Synthetic fixture",
  }));
  assert.equal((await status(0)).conceptual_review_progress.action, "dispatch_reviewer");
  await rm(stepPath);
  const absent = await status(0);
  assert.equal(absent.status, "active");
  assert.equal(absent.current_step, undefined);
  assert.equal(absent.conceptual_review_progress, undefined);
  for (const [description, damage] of damagedPublications) {
    await t.test(description, async () => {
      await damage(stepPath);
      const report = await status(0);
      assertUnavailable(report, stepPath);
      const { current_step, ...state } = report;
      assert.deepEqual(state, absent);
      assert.equal(state.last_obligation, "conceptual");
      assert.equal(state.obligations_summary.present, 1);
      await rm(stepPath, { recursive: true });
    });
  }
});

test("systemic status follows its own round with or without a co-published question workload", async t => {
  const { root, artifactsDir, stepPath, status } = await fixture(t);
  const put = (path, value) => writeFile(path, JSON.stringify(value));
  const statePath = join(artifactsDir, "audit_state.json");
  const registerPath = join(artifactsDir, "systemic_challenge.json");
  const promptPath = join(artifactsDir, "systemic-prompt.md");
  const register = {
    generated_at: new Date().toISOString(), target: "systemic_challenge", ceiling: { rung: "deep" },
    rounds: [], converged: false, findings: [], validation_issues: [], round_token: systemicPremiseToken({}),
  };
  const lane = systemicChallengeLane(register.rounds);
  const resultPath = laneSubmissionPath(artifactsDir, lane);
  const paths = { systemic_challenge_prompt: promptPath, systemic_challenge_results: resultPath };
  const publish = (runId = null, artifactPaths = paths) => put(stepPath, {
    contract_version: "audit-code-step/v1alpha1", status: "ready", step_kind: "systemic_challenge",
    run_id: runId, artifacts_dir: artifactsDir, repo_root: root, artifact_paths: artifactPaths,
    prompt_path: join(artifactsDir, "unused.md"), allowed_commands: [], stop_condition: "Synthetic fixture",
    ...(runId ? { progress: { summary: "Published with one question", pending_tasks: 1 } } : {}),
  });
  await put(statePath, { status: "active" });
  await put(registerPath, register);
  await writeFile(promptPath, "Synthetic systemic prompt");
  await publish();
  const binding = {
    requirement: "independent", promptSha256: hashContent("fixture digest"),
    promptContentSha256: hashContent(await readFile(promptPath)), promptPath,
    semanticInputRevision: systemicReviewInputRevision({ systemic_challenge: register }),
    submissionId: laneSubmissionId(lane), runId: AUDIT_GATE_SUBMISSION_SCOPE, inputs: [],
  };
  const bind = value => publishAuditReviewBindings(artifactsDir, new Map([[lane, value]]));
  await bind(binding);
  const inventory = async () => {
    const entries = await readdir(join(root, ".audit-tools"), { recursive: true, withFileTypes: true });
    return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
      const path = join(entry.parentPath, entry.name);
      return [relative(root, path), await readFile(path)];
    })));
  };
  const inspect = async () => {
    const before = await inventory();
    const report = await status(0);
    assert.deepEqual(await inventory(), before, "status must not write evidence or consume results");
    return report;
  };
  const systemic = async () => (await inspect()).systemic_challenge_continuation;
  const waiting = await inspect();
  assert.equal(waiting.question_review, null);
  assert.equal(waiting.question_review_handoff, null);
  assert.equal(waiting.systemic_challenge_continuation.state, "await_result");

  await mkdir(dirname(resultPath), { recursive: true });
  const answer = {
    contract_version: "review-submission/v1", prompt_sha256: binding.promptSha256,
    review: { mode: "independent", reason: "Synthetic independent review" }, result: { findings: [] },
  };
  await put(resultPath, answer);
  assert.equal((await systemic()).state, "ready");
  assert.equal((await systemic()).action, "continue");
  await publish(null, { ...paths, systemic_challenge_results: promptPath });
  assert.equal((await systemic()).state, "stale");
  await publish(null, { ...paths, systemic_challenge_prompt: resultPath });
  assert.equal((await systemic()).state, "stale");
  await publish();
  for (const invalid of [{ prompt_sha256: hashContent("different prompt") }, { result: { findings: [null] } }]) {
    await put(resultPath, { ...answer, ...invalid });
    assert.equal((await systemic()).state, "unavailable");
  }
  await put(resultPath, answer);
  await bind({ ...binding, semanticInputRevision: "obsolete" });
  assert.equal((await systemic()).state, "stale");
  await bind(binding);
  await put(registerPath, { ...register, round_token: "obsolete" });
  assert.equal((await systemic()).state, "stale");
  await put(registerPath, {
    ...register, folded_submission_hashes: [hashContent(lane + "\n" + hashContent(await readFile(resultPath)))],
  });
  assert.equal((await systemic()).state, "stale");
  await put(registerPath, register);
  await put(statePath, { status: "complete" });
  assert.equal(await systemic(), null);
  await put(statePath, { status: "active" });

  const runId = "question-review-fixture";
  const schema_version = "audit-tools/question-review/v1";
  const identity = { schema_version, snapshot_id: "snapshot", revision_id: "revision", question_id: "question" };
  const question = {
    ...identity, lens: "operability", inventory_item_ids: ["inventory"], expected_outcome: "Fixture continues",
    requested_parts: [{ part_id: "part", expectation: "Review fixture" }],
    source_dependencies: [], evidence_dependencies: [], plan_status: "active",
  };
  const assignment = {
    ...identity, assignment_id: "ordinary-answer", authorized_scope: { include: [], exclude: [] },
    suggested_sources: [], available_evidence_ids: [],
  };
  const review_plan = {
    schema_version, snapshot_id: identity.snapshot_id, questions: [question], inventory: [], omissions: [], lens_decisions: [],
  };
  await put(join(artifactsDir, "review_plan.json"), review_plan);
  await put(join(artifactsDir, "review_session.json"), { schema_version: "audit-tools/question-review-session/v1", run_id: runId });
  const currentRegister = { ...register, round_token: systemicPremiseToken({ review_plan }) };
  await put(registerPath, currentRegister);
  await bind({ ...binding, semanticInputRevision: systemicReviewInputRevision({ review_plan, systemic_challenge: currentRegister }) });
  assert.equal((await systemic()).state, "ready", "an existing ordinary run does not invalidate a standalone publication");
  const { workload_path } = await publishAuditQuestionWorkload({
    root, sourceRoot: root, artifactsDir, runId,
    bindings: [{ question, assignment, dependencies: [], evidence: [], sourceFiles: [] }],
  });
  const combined = { ...paths, host_workload: workload_path };
  await publish(runId, combined);
  const report = await inspect();
  assert.equal(report.question_review_handoff.action, "await_results");
  assert.equal(report.question_review_handoff.pending_answers, 1);
  assert.equal(report.systemic_challenge_continuation.state, "ready");
  await publish("obsolete-run", combined);
  assert.notEqual((await inspect()).question_review_handoff.state, "current");
  assert.equal(await systemic(), null);
});
