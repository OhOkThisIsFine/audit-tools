import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    plan: { plan_id: runId, review_revision_sha256: prior, units: [unit], requirements: [requirement] },
  };
  assert.deepEqual(await refreshReplannedHostConformance(root, artifactsDir, state), []);
  await assertSuccessfulConformance(root, artifactsDir, state);
  assert.equal((await request()).binding, old.binding);
  state.plan.review_revision_sha256 = current;
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

test("closeout only refreshes an exact independently conformed overlap", async t => {
  for (const scenario of ["fast-forward chain", "second parent", "original off mainline", "unreviewed writer", "incorrect recorded paths", "ungranted overlap",
    "different merge result", "different first-parent preimage", "reviewed first-parent preimage mismatch",
    "later unreviewed edit", "unstaged", "staged", "untracked"]) await t.test(scenario, async t => {
    const root = await mkdtemp(join(tmpdir(), "audit-closeout-overlap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const artifactsDir = join(root, ".audit-tools");
    const scoped = "target/source.txt";
    const source = join(root, scoped);
    const runId = "overlap-fixture";
    const revision = "a".repeat(64);
    const git = (...args) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "--template=", "-q");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "user.name", "Fixture");
    git("config", "commit.gpgsign", "false");
    await mkdir(join(root, "target"));
    const commit = async value => {
      await writeFile(source, value);
      git("add", "--", scoped);
      git("commit", "-qm", value);
      return git("rev-parse", "HEAD");
    };
    await commit("baseline");
    const oldBranch = git("branch", "--show-current");
    if (scenario === "original off mainline") git("switch", "-q", "-c", "original-writer");
    const oldLanded = await commit("original reviewed fix");
    if (scenario === "original off mainline") {
      git("switch", "-q", oldBranch);
      await writeFile(join(root, "baseline-context.txt"), "unrelated initial first parent");
      git("add", "baseline-context.txt");
      git("commit", "-qm", "initial mainline context");
      git("merge", "--no-ff", "-qm", "integrate original", "original-writer");
      assert.equal(git("rev-parse", "HEAD^2"), oldLanded);
    }
    const state = {
      conformance_review: { enabled: true }, items: {},
      plan: { plan_id: runId, review_revision_sha256: revision, units: [], requirements: [] },
    };
    const publish = async (paths, req) => {
      const response = req.response_template;
      response.declaration.reason = "Independent synthetic fixture context.";
      response.summary = "Verified the fixture candidate.";
      response.obligations[0].evidence = ["Fixture exact commit and path."];
      await writeFile(paths.response, JSON.stringify(response));
    };
    const seed = async (id, landed, allowed, actual, independentlyReviewed = true) => {
      const requirement = { id: "REQ-" + id, description: "Require " + id };
      const unit = { id, allowed_files: allowed, requirement_ids: [requirement.id], addresses_counterexample_ids: [] };
      state.plan.units.push(unit);
      state.plan.requirements.push(requirement);
      const paths = conformanceReviewPaths(artifactsDir, runId, id);
      const request = () => readFile(paths.request, "utf8").then(JSON.parse);
      const check = () => checkConformanceSubject({
        artifactsDir, runId, itemId: id, obligationIds: [requirement.id], evidenceInstruction: "Fixture.",
        content: { repository_root: root, run_id: runId, work_item_id: id, result: { landed_commit: landed },
          unit, requirements: [requirement], review_revision_sha256: revision, obligation_ids: [requirement.id], accepted_counterexamples: [] },
      });
      const item = { status: "resolved", host_landed_commit: landed, host_landed_files: actual };
      state.items[id] = item;
      if (independentlyReviewed) {
        assert.equal((await check()).ok, false);
        await publish(paths, await request());
        const accepted = await check();
        assert.equal(accepted.ok, true);
        item.conformance_review = accepted.receipt;
      }
      return { item, request, paths };
    };
    const prior = await seed("UNIT-original", oldLanded, ["target/"], [scoped]);
    const oldRequest = await prior.request();
    const differentPreimage = scenario === "different first-parent preimage" || scenario === "reviewed first-parent preimage mismatch";
    const merge = scenario === "second parent" || scenario === "different merge result" || differentPreimage;
    if (merge) git("switch", "-q", "-c", "later-writer");
    const reviewed = await commit("independently reviewed duplicate scope");
    await seed("UNIT-writer", reviewed, [scenario === "ungranted overlap" ? "other.txt" : scoped],
      scenario === "incorrect recorded paths" ? [scoped, "ghost.txt"] : [scoped],
      scenario !== "unreviewed writer");
    const writers = [{ id: "UNIT-writer", before: oldLanded, after: reviewed }];
    if (scenario === "fast-forward chain") {
      const later = await commit("second independently reviewed path transition");
      await seed("UNIT-next", later, [scoped], [scoped]);
      writers.push({ id: "UNIT-next", before: reviewed, after: later });
    }
    if (merge) {
      git("switch", "-q", oldBranch);
      if (differentPreimage) {
        const intervening = await commit("different first-parent scope preimage");
        if (scenario === "reviewed first-parent preimage mismatch") await seed("UNIT-first-parent", intervening, [scoped], [scoped]);
      } else {
        await writeFile(join(root, "unrelated.txt"), "first-parent context");
        git("add", "unrelated.txt");
        git("commit", "-qm", "unrelated first parent");
      }
      git("merge", "--no-ff", "--no-commit", ...(differentPreimage ? ["-s", "ours"] : []), "later-writer");
      if (scenario === "different merge result") {
        await writeFile(source, "merge produced a different path image");
        git("add", "--", scoped);
      } else if (differentPreimage) {
        // Final bytes match the approved branch. This is still B→C on the
        // actual first-parent edge, not the independently reviewed A→C.
        git("restore", "--source", reviewed, "--staged", "--worktree", "--", scoped);
      }
      git("commit", "-qm", "merge writer");
      assert.equal(git("rev-parse", "HEAD^2"), reviewed);
      if (differentPreimage) {
        assert.notEqual(git("rev-parse", "HEAD^1:" + scoped), git("rev-parse", oldLanded + ":" + scoped));
        assert.equal(git("rev-parse", "HEAD:" + scoped), git("rev-parse", reviewed + ":" + scoped));
      }
    }
    if (scenario === "later unreviewed edit") await commit("unexplained final path");
    if (scenario === "unstaged" || scenario === "staged") await writeFile(source, "dirty overlap");
    if (scenario === "staged") git("add", "--", scoped);
    if (scenario === "untracked") await writeFile(join(root, "target/extra.txt"), "dirty directory grant");

    // Even the same plan revision does not let a receipt for the old
    // path image authorize close, including through direct close admission.
    const refresh = () => refreshReplannedHostConformance(root, artifactsDir, state);
    if (scenario === "second parent") {
      await assert.rejects(assertSuccessfulConformance(root, artifactsDir, state), /conformance_review_required: UNIT-original/);
      const lost = new Error("fixture close ownership lost after scope reads");
      await assert.rejects(() => refreshReplannedHostConformance(root, artifactsDir, state, async () => { throw lost; }),
        error => error === lost);
      assert.deepEqual(await prior.request(), oldRequest);
    }
    const issue = (await refresh()).find(row => row.work_item_id === "UNIT-original");
    assert.equal(prior.item.conformance_review.binding, oldRequest.binding);
    if (!["second parent", "fast-forward chain", "original off mainline"].includes(scenario)) {
      assert.equal(issue.code, "conformance_review_insufficient");
      assert.deepEqual(await prior.request(), oldRequest);
      return;
    }
    assert.equal(issue.code, "conformance_review_required");
    const bound = await prior.request();
    assert.notEqual(bound.binding, oldRequest.binding);
    assert.equal(bound.content.review_revision_sha256, revision);
    assert.equal(bound.content.refreshed_head, git("rev-parse", "HEAD"));
    assert.deepEqual(bound.content.scope_transitions, writers.map(({ id, before, after }) => ({
      path: scoped, work_item_id: id, landed_commit: after,
      integrated_commit: merge ? git("rev-parse", "HEAD") : after,
      before: "100644:" + git("rev-parse", before + ":" + scoped),
      after: "100644:" + git("rev-parse", after + ":" + scoped),
    })));
    if (scenario === "second parent") {
      assert.equal((await refresh()).find(row => row.work_item_id === "UNIT-original").code, "conformance_review_required");
      assert.equal((await prior.request()).binding, bound.binding);
    }
    await publish(prior.paths, bound);
    // The first scope read is green. Change the path after the response read,
    // at the accepted-review write boundary, before receipt adoption.
    if (scenario === "second parent") {
      const changed = await refreshReplannedHostConformance(root, artifactsDir, state, async () => {
        await writeFile(source, "candidate changed during acceptance");
      });
      assert.match(changed.find(row => row.work_item_id === "UNIT-original").message, /candidate changed while refreshing/i);
      assert.equal(prior.item.conformance_review.binding, oldRequest.binding);
      git("restore", "--", scoped);
    }
    if (writers.length > 1) {
      const writerPaths = conformanceReviewPaths(artifactsDir, runId, "UNIT-writer");
      await publish(writerPaths, JSON.parse(await readFile(writerPaths.request, "utf8")));
    }
    assert.deepEqual(await refresh(), []);
    assert.equal(prior.item.conformance_review.binding, bound.binding);
    await assertSuccessfulConformance(root, artifactsDir, state);
  });
});
