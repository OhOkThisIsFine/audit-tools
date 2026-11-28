import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertSuccessfulConformance, refreshReplannedHostConformance } from "../dist/remediate/phases/triageConformance.js";
import { checkConformanceSubject, conformanceReviewPaths } from "../dist/remediate/steps/dispatch/contractConformanceReview.js";

test("closeout requests fresh independent conformance after a context-only replan", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "audit-closeout-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, ".audit-tools");
  const source = join(root, "source.txt");
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "user.name", "Fixture");
  git("config", "commit.gpgsign", "false");
  await writeFile(source, "original\n");
  git("add", "source.txt");
  git("commit", "-qm", "original");
  const baseline = git("rev-parse", "HEAD");
  await writeFile(source, "case fixed\n");
  git("add", "source.txt");
  git("commit", "-qm", "landed fix");
  const landed = git("rev-parse", "HEAD");
  const runId = "fixture-run";
  const itemId = "UNIT-working";
  const requirement = { id: "REQ-working", description: "Correct fixture behavior" };
  const unit = { id: itemId, allowed_files: ["source.txt"], requirement_ids: [requirement.id], addresses_counterexample_ids: [] };
  const prior = "a".repeat(64);
  const current = "b".repeat(64);
  const oldSubject = {
    repository_root: root, run_id: runId, work_item_id: itemId, baseline_commit: baseline,
    prompt_sha256: "c".repeat(64), obligation_ids: [requirement.id], unit, requirements: [requirement],
    review_revision_sha256: prior, accepted_counterexamples: [], result: { landed_commit: landed },
  };
  const paths = conformanceReviewPaths(artifactsDir, runId, itemId);
  const request = () => readFile(paths.request, "utf8").then(JSON.parse);
  const pass = async (req) => {
    const review = req.response_template;
    review.declaration.reason = "Independent fixture context.";
    review.summary = "Verified exact fixture source and behavior.";
    review.obligations[0].evidence = ["source.txt contains case fixed"];
    await writeFile(paths.response, JSON.stringify(review));
  };
  const checkOld = () => checkConformanceSubject({
    artifactsDir, runId, itemId, obligationIds: [requirement.id], content: oldSubject, evidenceInstruction: "Verify fixture.",
  });
  assert.equal((await checkOld()).ok, false);
  const old = await request();
  await pass(old);
  const accepted = await checkOld();
  assert.equal(accepted.ok, true);
  const item = { status: "resolved", host_landed_commit: landed, conformance_review: accepted.receipt };
  const state = {
    conformance_review: { enabled: true }, items: { [itemId]: item },
    plan: { plan_id: runId, review_revision_sha256: current, units: [unit], requirements: [requirement] },
  };
  await assert.rejects(assertSuccessfulConformance(root, artifactsDir, state), /conformance_review_required/);
  const missing = await refreshReplannedHostConformance(root, artifactsDir, state);
  assert.equal(missing[0].code, "conformance_review_required");
  assert.equal(item.conformance_review.binding, old.binding);
  const renewed = await request();
  assert.notEqual(renewed.binding, old.binding);
  assert.equal(renewed.content.review_revision_sha256, current);
  assert.equal(renewed.content.refreshed_head, landed);
  assert.equal(item.status, "resolved");
  assert.equal(item.host_landed_commit, landed);
  await pass(renewed);

  await writeFile(source, "unreviewed change\n");
  const changed = await refreshReplannedHostConformance(root, artifactsDir, state);
  assert.equal(changed[0].code, "conformance_review_insufficient");
  assert.equal(item.conformance_review.binding, old.binding);
  await writeFile(source, "case fixed\n");
  state.plan.requirements = [{ ...requirement, description: "Different requirement" }];
  const changedContract = await refreshReplannedHostConformance(root, artifactsDir, state);
  assert.equal(changedContract[0].code, "conformance_review_insufficient");
  state.plan.requirements = [requirement];

  assert.deepEqual(await refreshReplannedHostConformance(root, artifactsDir, state), []);
  assert.equal(item.conformance_review.binding, renewed.binding);
  await assertSuccessfulConformance(root, artifactsDir, state);

  // Partial refreshes may be persisted across calls. Reusing the same revision
  // must not reuse an independent review for an earlier candidate HEAD.
  await writeFile(join(root, "unrelated.txt"), "new committed context\n");
  git("add", "unrelated.txt");
  git("commit", "-qm", "advance candidate");
  await assert.rejects(assertSuccessfulConformance(root, artifactsDir, state), /conformance_review_required/);
  assert.equal((await refreshReplannedHostConformance(root, artifactsDir, state))[0].code, "conformance_review_required");
  const advanced = await request();
  assert.notEqual(advanced.binding, renewed.binding);
  assert.equal(advanced.content.refreshed_head, git("rev-parse", "HEAD"));
  await pass(advanced);
  assert.deepEqual(await refreshReplannedHostConformance(root, artifactsDir, state), []);
  await assertSuccessfulConformance(root, artifactsDir, state);

  await writeFile(source, "committed divergence\n");
  git("add", "source.txt");
  git("commit", "-qm", "diverge inside the reviewed scope");
  await writeFile(source, "case fixed\n");
  assert.equal((await refreshReplannedHostConformance(root, artifactsDir, state))[0].code, "conformance_review_insufficient");
  assert.equal(item.conformance_review.binding, advanced.binding);
});
