import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, promisify } from "node:util";
import test from "node:test";
import { runCli } from "../dist/audit/cli.js";
import { prepareConceptualDispatch } from "../dist/audit/cli/conceptualDispatch.js";
import { readAuditReviewBinding } from "../dist/audit/cli/auditReviewBindings.js";
import { GATE_LANES, recordLaneOutcome } from "../dist/audit/cli/laneSubmissions.js";
import { readConceptualReviewRoundManifest } from "../dist/audit/types/conceptualAdjudication.js";

const cli = fileURLToPath(new URL("../audit-code.mjs", import.meta.url));
const exec = promisify(execFile);
const finding = {
  id: "candidate", title: "Synthetic candidate", category: "unnecessary_complexity",
  severity: "low", confidence: "high", lens: "architecture", summary: "Synthetic finding.", affected_files: [],
};

async function fixture(t, depth) {
  const root = await mkdtemp(join(tmpdir(), "audit-conceptual-status-cycle3-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, ".audit-tools", "audit");
  const put = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  const statePath = join(artifactsDir, "audit_state.json");
  await put(statePath, { status: "active" });
  const dispatch = await prepareConceptualDispatch({
    artifactsDir, sourceRoot: root, bundle: {}, settings: { conceptual_depth: depth },
  });
  const stepPath = join(artifactsDir, "steps", "current-step.json");
  const step = {
    contract_version: "audit-code-step/v1alpha1",
    status: "ready", step_kind: "design_review_conceptual", run_id: null,
    artifacts_dir: artifactsDir, repo_root: root,
    artifact_paths: dispatch.artifactPaths,
    ...(dispatch.deep && { conceptual_workload: dispatch.workload }),
    prompt_path: join(artifactsDir, "unused.md"), allowed_commands: [], stop_condition: "Synthetic fixture",
  };
  await put(stepPath, step);

  // Compare every entry and its exact bytes. In particular, bare bound result
  // files are not ledger declarations until a mutating command consumes them.
  const inventory = async () => {
    const entries = await readdir(artifactsDir, { recursive: true, withFileTypes: true });
    return Promise.all(entries.map(async e => {
      const path = join(e.parentPath, e.name);
      return [path, e.isFile() ? await readFile(path) : e.isDirectory() ? "directory" : "other"];
    }).sort());
  };
  const status = async ({ subprocess = false } = {}) => {
    const before = await inventory();
    const argv = [cli, "status", "--root", root];
    // Keep one standalone CLI witness. The remaining calls exercise the
    // identical dispatcher against each on-disk state without restarting Node.
    let stdout;
    if (subprocess) {
      ({ stdout } = await exec(process.execPath, argv, { cwd: root, timeout: 15000 }));
    } else {
      stdout = "";
      const exitCode = process.exitCode;
      const log = t.mock.method(console, "log", (...args) => { stdout += format(...args) + "\n"; });
      try {
        process.exitCode = undefined;
        await runCli([process.execPath, ...argv]);
        assert.equal(process.exitCode ?? 0, 0);
      } finally {
        log.mock.restore();
        process.exitCode = exitCode;
      }
    }
    assert.deepEqual(await inventory(), before, "status must not modify the run, submissions, or ledger");
    const report = JSON.parse(stdout);
    assert.equal(report.systemic_challenge_continuation, null);
    return report.conceptual_review_progress;
  };
  const submit = async (lane, result, override = {}) => {
    const binding = await readAuditReviewBinding(artifactsDir, lane.lane_id);
    await put(lane.result_path, {
      contract_version: "review-submission/v1", prompt_sha256: binding.promptSha256,
      review: { mode: "independent", reason: "Synthetic independent result" }, result, ...override,
    });
  };
  return { artifactsDir, step, stepPath, statePath, put, dispatch, status, submit };
}

test("a deep publication follows current perspective and judge results without re-emitting or writing", async t => {
  const { artifactsDir, dispatch, put, step, stepPath, status, submit } = await fixture(t, "deep");
  const { pending_perspectives: lanes, judge } = dispatch.workload;
  assert.ok(lanes.length >= 2);
  const manifest = await readConceptualReviewRoundManifest(artifactsDir);
  const judgeAnswer = {
    round_id: manifest.round_id, findings: [], candidate_dispositions: [], final_finding_shares: [],
  };
  assert.equal((await status({ subprocess: true })).state, "await_perspectives");

  // A prompt-bound judge response cannot bypass missing perspectives.
  await submit(judge, judgeAnswer);
  assert.equal((await status()).state, "await_perspectives");
  await rm(judge.result_path);

  await submit(lanes[0], null, { review: { mode: "unavailable", reason: "Synthetic unavailable review" } });
  let progress = await status();
  assert.equal(progress.state, "blocked");
  assert.equal(progress.pending_perspectives[0].state, "unavailable");
  await writeFile(lanes[0].result_path, "{malformed");
  progress = await status();
  assert.equal(progress.action, "correct_perspectives");
  assert.equal(progress.pending_perspectives[0].state, "correction_required");

  await rm(lanes[0].result_path);
  await recordLaneOutcome(artifactsDir, lanes[0].lane_id, {
    kind: "rejected", issueCode: "submission_malformed", message: "Synthetic refusal",
  });
  assert.equal((await status()).action, "correct_perspectives");
  await submit(lanes[0], [{ ...finding, verification_status: "confirmed" }]);
  assert.equal((await status()).action, "correct_perspectives");

  for (const lane of lanes) await submit(lane, []);
  progress = await status();
  assert.equal(progress.state, "await_judge");
  assert.equal(progress.action, "dispatch_judge");
  assert.deepEqual(progress.pending_perspectives, []);

  await submit(judge, { ...judgeAnswer, round_id: "previous-round" });
  assert.equal((await status()).state, "stale");
  await submit(judge, judgeAnswer, { prompt_sha256: "9".repeat(64) });
  assert.equal((await status()).action, "correct_result");
  await submit(judge, { ...judgeAnswer, findings: [null] });
  assert.equal((await status()).action, "correct_result");

  // Valid judge schema is not enough: adjudication must cover all candidates.
  await submit(lanes[0], [finding]);
  await submit(judge, judgeAnswer);
  assert.equal((await status()).action, "correct_result");
  await submit(lanes[0], []);
  progress = await status();
  assert.equal(progress.state, "ready");
  assert.equal(progress.action, "continue");
  assert.equal(progress.judge.state, "validated");

  await put(stepPath, { ...step, step_kind: "design_review_parallel" });
  assert.match((await status()).summary, /Contract review is a separate lane/);
  const previousPrompt = await readFile(judge.prompt_path);
  await writeFile(judge.prompt_path, "Not the issued prompt.");
  assert.equal((await status()).state, "stale");
  await writeFile(judge.prompt_path, previousPrompt);
  await put(stepPath, {
    ...step, artifact_paths: { ...step.artifact_paths, conceptual_results: lanes[0].result_path },
  });
  assert.equal((await status()).state, "stale");
  await put(stepPath, { ...step, status: "blocked" });
  assert.equal((await status()).state, "blocked");
  await put(stepPath, step);
  await put(join(artifactsDir, "run-ended.json"), { fixture: true });
  assert.equal((await status()).state, "stale");
});

test("shallow review waits for the bound reviewer and refuses malformed results", async t => {
  const { dispatch, status, submit } = await fixture(t, "shallow");
  const lane = {
    lane_id: GATE_LANES.design_review_conceptual,
    result_path: dispatch.artifactPaths.conceptual_results,
  };
  let progress = await status();
  assert.equal(progress.mode, "shallow");
  assert.equal(progress.action, "dispatch_reviewer");
  await submit(lane, { findings: [null] });
  assert.equal((await status()).action, "correct_result");
  await submit(lane, { findings: [{ ...finding, verification_status: "confirmed" }] });
  assert.equal((await status()).action, "correct_result", "tool-owned verdicts are refused before schema shaping");
  await submit(lane, { findings: [] });
  assert.equal((await status()).action, "continue");
});
