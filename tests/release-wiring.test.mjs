import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { catalogCommands } from "../scripts/shared/verify-steps.mjs";
import { DOC_MANIFEST } from "../scripts/doc-manifest-data.mjs";
import { PINS, legCommand } from "../scripts/shared/derived-file-preflight.mjs";
import {
  assessPreparedRemoteTag,
  assertPreparedReleaseMode,
  evaluatePreparedRuns,
  isPreparedVersionBump,
  isProtectedReleaseAncestor,
  verifyPreparedChecksJob,
} from "../scripts/release-and-publish.mjs";

const root = new URL("../", import.meta.url);
const read = name => readFileSync(new URL(name, root), "utf8");
test("CI, publishing and development use the replacement without dropping the release checks", () => {
  const { scripts } = JSON.parse(read("package.json"));
  assert.match(scripts.test, /npm run build && npm run test:built/);
  assert.equal(scripts["test:built"], "node scripts/shared/run-contract-tests.mjs");
  const workflow = name => YAML.parse(read(".github/workflows/" + name + ".yml")).jobs;
  const ci = workflow("audit-code-test-suite");
  const publish = workflow("publish-package");
  for (const job of [ci["orchestration-tests"], publish.test]) {
    assert.ok(job.steps.some(step => step.run === "npm test"));
    assert.ok(job.steps.every(step => !step.run?.includes("vitest")));
  }
  assert.deepEqual(publish.publish.needs, ["validate-source", "gate", "test"]);
  assert.ok(publish.gate.steps.some(step => step.run?.includes("npm run verify:checks")));
  assert.ok(publish.publish.steps.some(step => step.with?.["artifact-ids"] === "${{ needs.gate.outputs.artifact_id }}"));
  const checks = catalogCommands("checks");
  const release = catalogCommands("release");
  assert.ok(checks.some(command => command.label === "check:generated-artifacts"));
  assert.ok(release.some(command => command.args.includes("scripts/shared/run-contract-tests.mjs")));
});
test("staged release metadata has a build-free witness and rejects stray runner filters", () => {
  assert.deepEqual(PINS.get("scripts/guard-reach-data.mjs"), ["tests/release-wiring.test.mjs"]);
  assert.equal(legCommand({script:"test", testPath:"tests/release-wiring.test.mjs"}).command, "node --test tests/release-wiring.test.mjs");
  assert.ok(DOC_MANIFEST.find(row=>row.type==="ops / usage").files.includes("tests/README.md"));
  const result = spawnSync(process.execPath, ["scripts/shared/run-contract-tests.mjs", "untrusted-filter"], {cwd:root, encoding:"utf8", windowsHide:true});
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support filters/);
});

test("prepared release requires exact successful default pushes from both canonical workflows", () => {
  const identity = { headSha: "a".repeat(40), branch: "main", repoId: 42 };
  const run = {
    id: 17, name: "ci", path: ".github/workflows/ci.yml", event: "push", head_sha: identity.headSha,
    head_branch: identity.branch, repository: { id: 42 }, head_repository: { id: 42 },
    run_attempt: 1, status: "completed", conclusion: "success", created_at: "2026-11-27T00:00:00Z",
  };
  const suite = { ...run, id: 18, name: "audit-code-test-suite", path: ".github/workflows/audit-code-test-suite.yml" };
  const evaluate = (...rows) => evaluatePreparedRuns({ total_count: rows.length, workflow_runs: rows }, identity);
  assert.equal(evaluate(run, suite), run);
  const scoped = { ...run, path: `${run.path}@refs/heads/main` };
  assert.equal(evaluate(scoped, suite), scoped);
  assert.equal(evaluate(run), null);
  for (const wrong of [
    { event: "pull_request" }, { event: "workflow_dispatch" }, { head_sha: "b".repeat(40) },
    { head_branch: "feature" }, { path: ".github/workflows/lookalike.yml" },
    { path: `${run.path}@refs/heads/feature` }, { path: `${run.path}@refs/pull/1/merge` }, { head_repository: { id: 43 } },
    { repository: { id: 43 } }, { status: "in_progress", conclusion: null },
  ]) assert.equal(evaluate({ ...run, ...wrong }, suite), null);
  const rerun = { ...run, run_attempt: 2 };
  assert.equal(evaluate(rerun, suite), rerun);
  assert.throws(() => evaluate({ ...run, run_attempt: undefined }, suite), /ambiguous/);
  assert.throws(() => evaluate(run, { ...run, id: 19 }, suite), /ambiguous/);
  assert.throws(() => evaluate({ ...run, conclusion: "skipped" }, suite), /did not pass/);
  assert.throws(() => evaluate(run, { ...suite, conclusion: "failure" }), /red CI/);
  assert.throws(() => evaluatePreparedRuns({ total_count: 3, workflow_runs: [run, suite] }, identity), /incomplete/);

  const tag = "v0.57.20";
  const downstream = { ...run, id: 20, name: "publish-package", event: "release", head_branch: tag,
    path: ".github/workflows/publish-package.yml", conclusion: "failure" };
  const recover = (...rows) => evaluatePreparedRuns({ total_count: rows.length, workflow_runs: rows },
    { ...identity, pushedTag: tag });
  assert.equal(recover(run, suite, downstream), run);
  assert.equal(recover(run, suite, { ...downstream, status: "in_progress", conclusion: null }), run);
  assert.equal(recover(suite, { ...downstream, conclusion: "success" }), null);
  assert.throws(() => evaluate(run, suite, downstream), /red CI/);
  assert.equal(evaluate(run, suite, { ...downstream, status: "in_progress", conclusion: null }), null);
  for (const other of [
    { event: "workflow_dispatch" }, { path: ".github/workflows/lookalike.yml" },
    { head_branch: "v0.57.21", display_title: tag }, { head_repository: { id: 43 } },
  ]) assert.throws(() => recover(run, suite, { ...downstream, ...other }), /red CI/);
});

test("prepared release checks attest the exact job and actual verify step, not a green workflow shell", () => {
  const identity = { runId: 17, headSha: "a".repeat(40) };
  const step = { name: "Verify release checks (non-test gate)", status: "completed", conclusion: "success" };
  const job = {
    id: 19, run_id: 17, name: "checks", head_sha: identity.headSha,
    status: "completed", conclusion: "success", steps: [step],
  };
  const verify = (...jobs) => verifyPreparedChecksJob({ total_count: jobs.length, jobs }, identity);
  assert.doesNotThrow(() => verify(job));
  for (const wrong of [
    { run_id: 16 }, { head_sha: "b".repeat(40) }, { name: "another-check" }, { conclusion: "skipped" },
    { steps: [] }, { steps: [{ ...step, conclusion: "skipped" }] }, { steps: [step, step] },
  ]) assert.throws(() => verify({ ...job, ...wrong }), /actual successful checks job/);
  assert.throws(() => verify(job, job), /actual successful checks job/);
});

test("prepared version must be the requested conventional bump of the first-parent version", () => {
  assert.equal(isPreparedVersionBump("0.57.19", "0.57.20", "patch"), true);
  assert.equal(isPreparedVersionBump("0.57.19", "0.58.0", "minor"), true);
  assert.equal(isPreparedVersionBump("0.57.19", "1.0.0", "major"), true);
  assert.equal(isPreparedVersionBump("0.57.19", "0.57.19", "patch"), false);
  assert.equal(isPreparedVersionBump("0.57.19", "0.57.21", "patch"), false);
  assert.equal(isPreparedVersionBump("0.57.19", "0.57.20", "minor"), false);
  assert.equal(isPreparedVersionBump("0.57.19", "0.57.020", "patch"), false);
});

test("a pushed prepared release requires both the exact remote tag object and peeled commit", () => {
  const identity = { tag: "v0.57.20", localTagSha: "a".repeat(40), headSha: "b".repeat(40) };
  const object = `${identity.localTagSha}\trefs/tags/v0.57.20\n`;
  const peeled = `${identity.headSha}\trefs/tags/v0.57.20^{}\n`;
  assert.equal(assessPreparedRemoteTag("", identity), false);
  assert.equal(assessPreparedRemoteTag(object + peeled, identity), true);
  assert.equal(assessPreparedRemoteTag(peeled + object, identity), true);
  assert.throws(() => assessPreparedRemoteTag(object, identity), /differs/);
  assert.throws(() => assessPreparedRemoteTag(peeled, identity), /differs/);
  assert.throws(() => assessPreparedRemoteTag(object + peeled, { ...identity, localTagSha: null }), /differs/);
  assert.throws(() => assessPreparedRemoteTag(object + peeled, { ...identity, localTagSha: "c".repeat(40) }), /differs/);
  assert.throws(() => assessPreparedRemoteTag(object + peeled, { ...identity, headSha: "c".repeat(40) }), /differs/);
});

test("an advanced protected tip can only finish a pushed release whose exact commit remains an ancestor", () => {
  const sha = "a".repeat(40);
  const comparison = { status: "ahead", base_commit: { sha }, merge_base_commit: { sha } };
  assert.equal(isProtectedReleaseAncestor(comparison, sha), true);
  assert.equal(isProtectedReleaseAncestor({ ...comparison, status: "diverged" }, sha), false);
  assert.equal(isProtectedReleaseAncestor({ ...comparison, merge_base_commit: { sha: "b".repeat(40) } }, sha), false);
  assert.equal(isProtectedReleaseAncestor({ ...comparison, base_commit: { sha: "b".repeat(40) } }, sha), false);
});

test("a pending prepared journal blocks a legacy bump even when the checkout no longer matches it", () => {
  const pending = { preparedCiRun: 17, phases: { land: { alreadyLanded: true } } };
  assert.throws(() => assertPreparedReleaseMode(pending, false, false), /different mode/);
  assert.throws(() => assertPreparedReleaseMode(pending, false, true), /different mode/);
  assert.doesNotThrow(() => assertPreparedReleaseMode(pending, true, true));
  assert.doesNotThrow(() => assertPreparedReleaseMode({ ...pending, phases: { "reinstall+smoke": {} } }, false, false));
});
