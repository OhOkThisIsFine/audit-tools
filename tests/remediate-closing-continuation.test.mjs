import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contentSha256 as hash, currentPromptPath, currentStepPath, FileLockOwnershipLostError, hashContent, runWithBlockedStepBackstop } from "../dist/shared/index.js";
import {
  executionPlanPaths, ingestExecutionPlan, readCanonicalPlan, readExecutionIntent,
} from "../dist/remediate/contractPipeline/executionPlan.js";
import {
  buildStructuredAuditSourceManifest, intakePaths, INTAKE_SUMMARY_SCHEMA_VERSION,
} from "../dist/remediate/intake.js";
import { PHASE_LOCK_FILENAME, StateStore } from "../dist/remediate/state/store.js";
import { closingActionCompleted, runClosePhase } from "../dist/remediate/phases/close.js";
import { decideNextStep } from "../dist/remediate/steps/nextStep.js";

import { runCloseAcceptance } from "../dist/remediate/phases/closeAcceptance.js";
import { finalGateOutcomePath, finalGateRecordPath, writeFinalGateVerdict, finalGateVerdictPath } from "../dist/remediate/steps/finalGate.js";
import { processAgentId } from "../dist/shared/io/stepContractWriter.js";
import { presentReportStep } from "../dist/remediate/steps/frictionCloseout.js";

const entry = fileURLToPath(new URL("../dist/remediate/index.js", import.meta.url));
const put = (path, value) => writeFile(path, JSON.stringify(value));

async function fixture(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "remediate-closing-continuation-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const artifactsDir = join(root, ".audit-tools", "remediation");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  git("init", "--template=", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  await writeFile(join(root, "fixture.txt"), "fixture\n");
  git("add", "fixture.txt");
  git("commit", "-qm", "Fixture baseline");
  const cli = (verb, ...args) => JSON.parse(execFileSync(process.execPath, [entry, verb, ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, REMEDIATE_SKIP_FINAL_GATE: "1" },
  }));
  const next = (...args) => cli("next-step", ...args);
  const store = new StateStore(artifactsDir);
  return { root, artifactsDir, git, cli, next, store };
}

async function reviewedClosing({ root, artifactsDir, store }, action = "commit") {
  const paths = executionPlanPaths(artifactsDir);
  const { intentCheckpoint } = intakePaths(artifactsDir);
  await mkdir(paths.directory, { recursive: true });
  await put(intentCheckpoint, {
    schema_version: "intent-checkpoint/v1", confirmed_by: "host", confirmed_at: new Date().toISOString(),
    scope_summary: "Fixture only", intent_summary: "Verify the fixture", closing_action: action,
  });
  const request = { id: "fixture-request", text: "Verify the fixture remains stable.", source_paths: [] };
  const plan = {
    plan_id: "fixture-plan", objective: "Verify stable fixture", non_goals: [],
    requirements: [{
      id: "fixture-stable", description: "The fixture stays stable", source_finding_ids: [], change_kind: "behavior_change",
      assertions: [
        { kind: "positive", description: "Fixture content is present", scope_paths: ["fixture.txt"] },
        { kind: "negative", description: "Fixture is not overwritten", scope_paths: ["fixture.txt"] },
      ],
    }],
    units: [{
      id: "fixture", title: "Verify fixture", description: "Check fixture content", source_finding_ids: [],
      requirement_ids: ["fixture-stable"], dependencies: [], read_paths: ["fixture.txt"], allowed_files: ["fixture.txt"],
      required_tests: [], affected_interfaces: [], addresses_counterexample_ids: [],
    }],
    source_dispositions: [],
  };
  await put(paths.source, { plan_id: plan.plan_id, findings: [], request, audit_read: null, sources: [],
    intent: await readExecutionIntent(artifactsDir) });
  await put(paths.submission, { base_revision_sha256: null, plan });
  assert.deepEqual(await ingestExecutionPlan({ root, artifactsDir }), { changed: true, issues: [] });
  const canonical = await readCanonicalPlan(artifactsDir);
  const revision = canonical.revision_sha256;
  const history = { counterexamples: [], accepted_ids: [], repair_rounds: 0 };
  const review = { mode: "independent", reason: "Synthetic test fixture." };
  const reviewResults = {
    critique: { verdict: "approved", issues: [] },
    critic: { counterexamples: [] },
    judge: {
      verdict: "approved", classifications: [], disposition_assessments: [],
      requirement_assessments: [{ requirement_id: "fixture-stable", verdict: "satisfied", evidence: ["Fixture content."] }],
    },
  };
  const reviewHashes = {};
  for (const [role, result] of Object.entries(reviewResults)) {
    const input = hash({ role, revision });
    const receipt = { revision_sha256: revision, role, input_sha256: input,
      provenance: { requirement: "independent", prompt_sha256: input, review, reviewed_content_hash: revision }, result };
    await put(paths.review(role).accepted, receipt);
    reviewHashes[role] = hash(receipt);
  }
  await put(paths.history, history);
  const approval = { revision_sha256: revision, judge_input_sha256: hash({ role: "judge", revision }),
    owner_decision_sha256: hash(null), risk_decision_sha256: hash(null), history_sha256: hash(history), review_sha256: reviewHashes };
  await put(paths.approval, approval);
  await store.saveState({
    status: "closing", run_start_dirty: [], run_start_dirty_encoding: "git-z/v1",
    plan: { ...canonical.plan, request, review_revision_sha256: revision, findings: [],
      project_type: "unknown", candidate_closing_actions: [action] },
    items: { fixture: { unit_id: "fixture", status: "resolved_no_change" } }, closing_plan: { action },
  });
  return { approval, paths };
}

const address = "https://github.com/fixture-owner/fixture-repo.git";
const ref = "refs/heads/topic";
const httpsGit = ["git", "--no-replace-objects", "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always"];
const oid = "[a-f0-9]{40}";
const strayTip = "a".repeat(40);

async function fakeDelivery(t, action = "push", { dirty = true, legacy = false, ...behavior } = {}) {
  const f = await fixture(t);
  const { root, artifactsDir, git, store } = f;
  const ancestor = git("rev-parse", "HEAD");
  git("commit", "--allow-empty", "-qm", "Already at remote");
  await reviewedClosing(f, action);
  const parent = git("rev-parse", "HEAD");
  const report = join(root, ".audit-tools", "remediation-report.md");
  if (dirty) await writeFile(report, "Existing run deliverable content.\n");
  if (legacy) {
    const state = await store.loadState();
    state.closing_plan.pre_authorized = true;
    await store.saveState(state);
  }
  const calls = { localCommits: 0, adds: 0, pushes: [], prs: [], reads: [] };
  let tip = behavior.remoteInitiallyAtAncestor ? ancestor : parent;
  let actionAfterRead;
  const runner = async (_cwd, binary, args) => {
    assert.equal(_cwd, root);
    const argv = [binary, ...args];
    const matches = expected => JSON.stringify(argv) === JSON.stringify(expected);
    const result = (exit_code = 0, stdout = "") => ({ command: argv, exit_code, stdout });
    const candidate = git("rev-parse", "HEAD");
    if (matches(["git", "symbolic-ref", "--quiet", "HEAD"])) return result(0, ref);
    if (matches(["git", "for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)", "--", ref])) return result(0, `origin\t${ref}`);
    if (matches(["git", "config", "--get-regexp", "^(url\\..*\\.(insteadof|pushinsteadof)$|remote\\.https://|http\\..*\\.followredirects$)"])) {
      return behavior.rewrittenAddress ? result(0, "Synthetic rewrite present") : result(1);
    }
    if (matches(["git", "config", "--get-all", "branch.topic.remote"])) return result(0, "origin");
    if (matches(["git", "config", "--get-all", "branch.topic.merge"])) return result(0, ref);
    if (matches(["git", "config", "--get-all", "remote.pushDefault"]) && behavior.conflictingPushDefault) return result(0, "other");
    if (matches(["git", "config", "--get-all", "remote.pushDefault"]) && behavior.extraBlankConfigValue) return result(0, "origin\n");
    if (matches(["git", "config", "--get-all", "remote.origin.vcs"]) && behavior.customHelper) return result(0, "custom");
    if (["branch.topic.pushRemote", "remote.pushDefault", "push.default", "remote.origin.push", "remote.origin.mirror",
      "remote.origin.vcs", "remote.origin.receivepack"]
      .some(key => matches(["git", "config", "--get-all", key]))) return result(1);
    if (matches(["git", "remote", "get-url", "--all", "origin"]) ||
        matches(["git", "remote", "get-url", "--push", "--all", "origin"])) return result(0, address);
    if (matches([...httpsGit, "ls-remote", "--exit-code", "--symref", "--", address, "HEAD"])) {
      return result(0, `ref: refs/heads/main\tHEAD\n${parent}\tHEAD`);
    }
    if (matches([...httpsGit, "ls-remote", "--exit-code", "--refs", "--", address, ref])) {
      calls.reads.push(argv);
      if (calls.pushes.length && behavior.unavailablePrHead) return result(null);
      if (calls.pushes.length && behavior.driftPrHead) tip = strayTip;
      return result(0, `${tip}\t${ref}`);
    }
    if (matches([...httpsGit, "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
      `--force-with-lease=${ref}:${parent}`, "--", address, `${candidate}:${ref}`])) {
      calls.pushes.push(argv);
      assert.equal(git("rev-parse", "HEAD^"), parent);
      assert.equal((await readReceipt()).in_progress.delivery.candidate, candidate);
      await actionAfterRead?.();
      if (behavior.race) tip = ancestor; // moves to an ancestor immediately before the CAS
      if (behavior.alreadyCandidate) return result(0, `To ${address}\n=\t${candidate}:${ref}\t[up to date]\nDone`);
      if (tip !== parent) return result(1);
      tip = candidate;
      const deliveredAddress = behavior.wrongReceiptDestination ? "https://github.com/other/repo.git" : address;
      return result(0, `To ${deliveredAddress}\n \t${candidate}:${ref}\t${parent.slice(0, 7)}..${candidate.slice(0, 7)}\nDone`);
    }
    if (matches(["gh", "pr", "create", "--repo", "github.com/fixture-owner/fixture-repo",
      "--head", "topic", "--base", "main", "--fill"])) {
      calls.prs.push(argv);
      assert.equal(tip, candidate);
      assert.equal((await readReceipt()).in_progress.receipts.at(-1).stdout, `${candidate}\t${ref}`);
      return result(0, "https://github.com/fixture-owner/fixture-repo/pull/123");
    }
    if (matches(["gh", "api", "--hostname", "github.com", "repos/fixture-owner/fixture-repo/pulls/123", "--jq",
      "[.head.repo.full_name,.head.ref,.head.sha,.base.repo.full_name,.base.ref] | @tsv"])) {
      return result(0, `fixture-owner/fixture-repo\ttopic\t${behavior.unverifiedPr ? strayTip : candidate}\tfixture-owner/fixture-repo\tmain`);
    }
    const isAdd = matches(["git", "--literal-pathspecs", "add", "--", ".audit-tools/remediation-report.md"]);
    const isCommit = matches(["git", "--literal-pathspecs", "commit", "-m", "Fix: Verify fixture", "--", ".audit-tools/remediation-report.md"]);
    const isCat = matches(["git", "--no-replace-objects", "cat-file", "commit", candidate]);
    assert.ok(isAdd || isCommit || isCat || matches(["git", "rev-parse", "--verify", "HEAD"]),
      `Unexpected argv (no fallback): ${JSON.stringify(argv)}`);
    if (isAdd) calls.adds++;
    if (isCommit) {
      calls.localCommits++;
      const { in_progress } = await readReceipt();
      assert.equal(in_progress.preparation.parent, parent);
      assert.deepEqual(in_progress.preparation.files, [".audit-tools/remediation-report.md"]);
    }
    const local = spawnSync(binary, args, { cwd: root, encoding: "utf8", windowsHide: true });
    if (isCommit && behavior.unknownLocalCommit) return result(null);
    return { ...result(local.status, isCat ? local.stdout.split("\n\n")[0] : local.stdout.trim()), stderr: local.stderr.trim() };
  };
  const next = (finalizeClosing = false) => decideNextStep({
    root, artifactsDir, skipFinalGate: true, closingCommandRunner: runner, finalizeClosing,
  });
  const resultPath = join(artifactsDir, "remediation-closing-result.json");
  const readReceipt = async () => JSON.parse(await readFile(resultPath, "utf8"));
  const outcomes = async () => (JSON.parse(await readFile(join(root, ".audit-tools", "remediation-outcomes.json"), "utf8"))).closing_result;
  return { ...f, next, calls, parent, readReceipt, resultPath, outcomes, report, afterPush: fn => { actionAfterRead = fn; } };
}

test("delivery approval is reconstructed solely from durable local preparation; matching approval conditionally pushes", async t => {
  const f = await fakeDelivery(t);
  const first = await f.next(true);
  assert.match(await readFile(first.prompt_path, "utf8"), /local commit preparation only/);
  const preCommitState = await f.store.loadState();
  assert.equal(f.calls.localCommits, 0);
  const second = await f.next(true);
  const prompt = await readFile(second.prompt_path, "utf8");
  const candidate = f.git("rev-parse", "HEAD");
  assert.match(candidate, new RegExp(`^${oid}$`));
  assert.match(prompt, new RegExp(candidate));
  assert.match(prompt, new RegExp(f.parent));
  assert.ok(prompt.includes(address) && prompt.includes(ref));
  assert.equal(second.step_kind, "close_run");
  assert.equal(f.calls.pushes.length, 0);
  assert.equal(f.calls.localCommits, 1);
  const journal = await f.readReceipt();
  assert.deepEqual(Object.keys(journal), ["prepared_local"]);
  assert.equal(journal.prepared_local.candidate, candidate);
  assert.equal(journal.prepared_local.parent, f.parent);
  assert.deepEqual(journal.prepared_local.receipts.map(receipt => receipt.exit_code), [0, 0]);

  // Crash after checkpoint rename, before next-step persisted the second approval.
  await f.store.saveState(preCommitState);
  const bare = await f.next();
  assert.equal(bare.step_kind, "close_run");
  assert.equal(await readFile(bare.prompt_path, "utf8"), prompt);
  assert.deepEqual(await f.readReceipt(), journal);
  assert.equal(f.calls.localCommits, 1);
  assert.equal(f.calls.adds, 1);
  assert.equal(f.calls.pushes.length, 0);
  const stale = await f.store.loadState();
  stale.closing_plan.closing_action_preview.delivery.remote = "other";
  stale.closing_plan.pre_authorized = true;
  await f.store.saveState(stale);
  assert.equal((await f.next(true)).step_kind, "close_run");
  assert.equal(f.calls.pushes.length, 0);
  assert.equal((await f.next(true)).step_kind, "present_report");
  assert.equal(f.calls.pushes.length, 1);
  assert.equal(f.calls.localCommits, 1);
  const result = await f.outcomes();
  assert.equal(closingActionCompleted(result), true);
  assert.equal(closingActionCompleted({ ...result, commands: result.commands.slice(0, -1) }), false);
});

test("unattributed, unknown and raced delivery never produce successful remote evidence", async t => {
  for (const [name, behavior, pushCount, attemptedCommit] of [
    ["precommitted clean checkout", { dirty: false }, 0, 0],
    ["unrelated earlier ahead history", { remoteInitiallyAtAncestor: true }, 0, 1],
    ["ordinary Git selects a different push remote", { conflictingPushDefault: true }, 0, 1],
    ["ordinary Git has an extra blank push remote", { extraBlankConfigValue: true }, 0, 1],
    ["ordinary Git selects a custom transport helper", { customHelper: true }, 0, 1],
    ["Git URL rewrite makes the effective address ambiguous", { rewrittenAddress: true }, 0, 1],
    ["unknown tracked local commit", { unknownLocalCommit: true }, 0, 1],
    ["tip moved backward at the update boundary", { race: true }, 1, 1],
    ["tip already equals candidate at the update boundary", { alreadyCandidate: true }, 1, 1],
    ["push receipt names a different destination", { wrongReceiptDestination: true }, 1, 1],
  ]) await t.test(name, async t => {
    const f = await fakeDelivery(t, "push", { ...behavior, legacy: true });
    const first = await f.next(true);
    if (behavior.unknownLocalCommit) {
      assert.equal(first.step_kind, "close_run");
      assert.equal(first.status, "blocked");
      const unresolved = await f.readReceipt();
      assert.equal(unresolved.in_progress.in_flight[2], "commit");
      assert.equal(unresolved.in_progress.receipts.at(-1).exit_code, null);
      assert.equal((await f.next()).status, "blocked");
      await put(join(f.artifactsDir, "closing_reconciliation.json"), {
        receipt_sha256: unresolved.in_progress.sha256, disposition: "observed", note: "Synthetic observed local commit.",
      });
      assert.equal((await f.next()).step_kind, "present_report");
    } else if (first.step_kind === "close_run") {
      assert.equal(f.calls.pushes.length, 0);
      assert.equal((await f.next(true)).step_kind, "present_report");
    } else {
      assert.equal(first.step_kind, "present_report");
    }
    const result = await f.outcomes();
    assert.equal(closingActionCompleted(result), false);
    assert.equal(f.calls.pushes.length, pushCount);
    assert.equal(f.calls.localCommits, attemptedCommit);
    assert.equal(f.calls.prs.length, 0);
  });
});

test("PR requires the successful exact update and corroborated candidate head; partial receipts are never green", async t => {
  for (const [name, behavior] of [
    ["matching post-push head", {}],
    ["post-push head unavailable", { unavailablePrHead: true }],
    ["post-push head drifted", { driftPrHead: true }],
    ["created PR points at a different head OID", { unverifiedPr: true }],
  ]) await t.test(name, async t => {
    const success = Object.keys(behavior).length === 0;
    const f = await fakeDelivery(t, "open-pr", { ...behavior, legacy: true });
    const preview = await f.next(true);
    assert.equal(preview.step_kind, "close_run");
    assert.match(await readFile(preview.prompt_path, "utf8"), /fixture-owner\/fixture-repo, head topic, base main/);
    assert.equal(f.calls.pushes.length, 0);
    assert.equal((await f.next(true)).step_kind, "present_report");
    assert.equal(f.calls.pushes.length, 1);
    assert.equal(f.calls.prs.length, success || behavior.unverifiedPr ? 1 : 0);
    const result = await f.outcomes();
    assert.equal(closingActionCompleted(result), success);
    assert.ok(result.commands.some(command => command.command.includes("push") && command.exit_code === 0));
    assert.equal(closingActionCompleted({ ...result, commands: result.commands.slice(0, -1) }), false);
    if (!success) {
      assert.match(result.nondelivery_reason, behavior.unverifiedPr ? /candidate could not all be verified/
        : /branch update succeeded, but no PR was created/);
      assert.equal((await f.next()).step_kind, "present_report");
      assert.equal(f.calls.pushes.length, 1);
    }
  });
});

test("terminal push receipt recovery is report-only; missing terminal receipts stay unresolved", async t => {
  for (const incomplete of [false, true]) await t.test(incomplete ? "incomplete" : "exact", async t => {
    const f = await fakeDelivery(t, "push", { legacy: true });
    assert.equal((await f.next(true)).step_kind, "close_run");
    // Make only report promotion fail after the fake push completes.
    f.afterPush(async () => { await rm(f.report); await mkdir(f.report); });
    await assert.rejects(f.next(true), /EISDIR|EPERM|EEXIST|ENOTDIR/);
    await rm(f.report, { recursive: true });
    const saved = await f.readReceipt();
    assert.equal(closingActionCompleted(saved), true);
    assert.ok(saved.pending_report);
    if (incomplete) {
      const { pending_report, ...result } = saved;
      result.commands.pop();
      pending_report.sha256 = hash([result, pending_report.verified_state, pending_report.context]);
      await put(f.resultPath, { ...result, pending_report });
      assert.equal((await f.next()).status, "blocked");
      assert.equal((await f.next(true)).status, "blocked");
    } else {
      assert.equal((await f.next()).step_kind, "present_report");
      assert.equal(closingActionCompleted(await f.outcomes()), true);
    }
    assert.equal(f.calls.pushes.length, 1);
    assert.equal(f.calls.localCommits, 1);
  });
});

test("the native emitted finalize command advances only a current, approved closing preview", async t => {
  const f = await fixture(t);
  const { approval, paths } = await reviewedClosing(f);
  const { next, cli, root, git, store, artifactsDir } = f;
  const baseline = git("rev-parse", "HEAD");
  const finalize = (...args) => next("--finalize-closing", ...args);
  const noClose = async () => {
    assert.equal((await store.loadState()).closing_plan.pre_authorized, undefined);
    assert.equal(git("rev-parse", "HEAD"), baseline);
  };

  await store.saveState({ ...await store.loadState(), status: "implementing" });
  assert.equal(finalize().step_kind, "confirm_resume_or_restart");
  await store.saveState({ ...await store.loadState(), status: "closing" });
  // The exact flag is a continuation, not approval of a preview that did not exist.
  const first = finalize();
  assert.equal(first.step_kind, "close_run");
  assert.deepEqual(first.allowed_commands, ["remediate-code next-step --finalize-closing"]);
  const runEmitted = () => cli(...first.allowed_commands[0].split(" ").slice(1));
  await noClose();

  assert.equal(next().step_kind, "confirm_resume_or_restart");
  await put(join(artifactsDir, "confirm_resume_ack.json"), { choice: "resume" });
  assert.equal(next().step_kind, "close_run"); // A resume ack is not closing approval.
  await rm(join(artifactsDir, "confirm_resume_ack.json"));
  await noClose();

  const other = join(root, "other.md");
  await writeFile(other, "Fresh intake\n");
  assert.equal(finalize("--input", other).step_kind, "input_conflict");
  assert.equal(finalize("--guidance", "Different request").step_kind, "input_conflict");

  const { sourceManifest } = intakePaths(artifactsDir);
  await mkdir(join(artifactsDir, "intake"), { recursive: true });
  await put(sourceManifest, {
    ...buildStructuredAuditSourceManifest(other, "input"),
    finding_selection: {
      criteria: { severity: [], finding_ids: ["fixture-finding"] }, source_path: other,
      source_hash: hashContent("Original report"), projected_path: other, selected_count: 1,
    },
  });
  const sourceChanged = runEmitted();
  assert.equal(sourceChanged.step_kind, "input_conflict");
  assert.match(await readFile(sourceChanged.prompt_path, "utf8"), /original audit report changed/);
  await rm(sourceManifest);

  await put(join(artifactsDir, "confirm_resume_ack.json"), { choice: "restart" });
  assert.equal(runEmitted().step_kind, "confirm_resume_or_restart");
  await rm(join(artifactsDir, "confirm_resume_ack.json"));
  await noClose();

  cli("pause");
  assert.equal(runEmitted().step_kind, "operator_paused");
  await noClose();
  cli("resume");

  await rm(paths.approval);
  const unreviewed = runEmitted();
  assert.equal(unreviewed.step_kind, "contract_pipeline");
  assert.equal(unreviewed.status, "blocked");
  await noClose();
  await put(paths.approval, approval);

  const changed = runEmitted();
  assert.equal(changed.step_kind, "close_run"); // The observed file list changed.
  assert.match(await readFile(changed.prompt_path, "utf8"), /other\.md/);
  await noClose();
  assert.equal(runEmitted().step_kind, "present_report");
  assert.equal(await readFile(other, "utf8"), "Fresh intake\n");
});

test("finalize does not carry old closing approval into a newly submitted plan revision", async t => {
  const f = await fixture(t);
  const { paths } = await reviewedClosing(f);
  const preview = f.next("--finalize-closing");
  assert.equal(preview.step_kind, "close_run");
  const canonical = await readCanonicalPlan(f.artifactsDir);
  await put(paths.submission, {
    base_revision_sha256: canonical.revision_sha256,
    plan: { ...canonical.plan, objective: "Revised fixture objective" },
  });
  assert.equal(f.next("--finalize-closing").step_kind, "contract_pipeline");
  assert.notEqual((await readCanonicalPlan(f.artifactsDir)).revision_sha256, canonical.revision_sha256);
  assert.equal((await f.store.loadState()).closing_plan.pre_authorized, undefined);
});

test("finalize does not advance a cancelled closing run", async t => {
  const f = await fixture(t);
  await reviewedClosing(f);
  f.cli("cancel");
  assert.equal(f.next("--finalize-closing").step_kind, "operator_cancelled");
  assert.equal((await f.store.loadState()).closing_plan.pre_authorized, undefined);
});

test("the real structured intent checkpoint explains source authority with and without a summary", async t => {
  for (const withSummary of [true, false]) await t.test(withSummary ? "summary" : "fallback", async t => {
    const f = await fixture(t);
    const paths = intakePaths(f.artifactsDir);
    const source = join(f.root, "audit-findings.json");
    await mkdir(paths.dir, { recursive: true });
    await put(source, { narrative: "Implement an unrelated design." });
    await put(paths.sourceManifest, buildStructuredAuditSourceManifest(source, "input"));
    if (withSummary) {
      await put(paths.summary, {
        schema_version: INTAKE_SUMMARY_SCHEMA_VERSION, ready: true, source_type: "structured_audit",
        goals: [], non_goals: [], constraints: [], affected_files: [], open_questions: [], acceptance_criteria: [],
        filters: {}, source_summary: "Audit findings", scope_summary: "Fixture findings", intent_summary: "Review fixture",
      });
    } else {
      await f.store.saveState({ status: "planning", run_start_dirty: [], run_start_dirty_encoding: "git-z/v1" });
      await put(join(f.artifactsDir, "confirm_resume_ack.json"), { choice: "resume" });
    }
    const step = f.next();
    assert.equal(step.step_kind, "confirm_intent");
    const prompt = await readFile(step.prompt_path, "utf8");
    assert.equal(prompt.includes("## Proposed Scope"), withSummary);
    assert.match(prompt, /findings define the eligible work.*narrative is context, not a separate implementation request/);
    assert.match(prompt, /`free_form_intent` to clarify or narrow.*cannot add unrelated write scope/);
    assert.match(prompt, /work outside those findings that the user explicitly requests.*`--guidance <text>`/);
  });
});

test("close acceptance fences subsequent local gate launches and red evidence independently", async t => {
  for (const loss of ["none", "runner", "red"]) await t.test(loss, async t => {
    const f = await fixture(t);
    await reviewedClosing(f, "none");
    const state = await f.store.loadState();
    await put(join(f.root, "package.json"), { name: "close-fixture", scripts: {
      build: "node --version", lint: "node --version",
    } });
    const commands = [];
    const outcome = finalGateOutcomePath(f.artifactsDir);
    const red = finalGateRecordPath(f.artifactsDir);
    const verdict = finalGateVerdictPath(f.artifactsDir);
    const lost = new Error("synthetic close ownership lost");
    await writeFile(red, "earlier red evidence");
    await writeFile(verdict, "earlier verdict evidence");
    await writeFile(outcome, "earlier outcome");
    const assertOwnership = async () => {
      if (loss === "runner" && commands.length) throw lost;
      if (loss === "red" && (await readFile(outcome, "utf8")) !== "earlier outcome") throw lost;
    };
    const verification = runCloseAcceptance({
      state, assertOwnership,
      options: { root: f.root, artifactsDir: f.artifactsDir, finalGateRunner: async argv => {
        commands.push(argv.join(" "));
        await Promise.resolve();
        return { status: argv.includes("lint") ? 8 : 0, stderr: "synthetic verdict" };
      } },
      runCombined: () => assert.fail("no combined suite in this fixture"),
    });
    if (loss === "none") {
      const result = await verification;
      assert.equal(result.gate.passed, false);
      assert.equal(JSON.parse(await readFile(red, "utf8")).exit_code, 8);
      // A close does not cache its floor. Guard the shared verdict writer if used.
      await writeFinalGateVerdict(f.artifactsDir, { scope: "fixture", tree: null, passed: false,
        scoped_out: false, outcome: "executed", results: result.gate.results }, assertOwnership);
      assert.equal(JSON.parse(await readFile(verdict, "utf8")).passed, false);
    } else {
      await assert.rejects(verification, error => error === lost);
      await assert.rejects(() => writeFinalGateVerdict(f.artifactsDir, { scope: "fixture", tree: null,
        passed: false, scoped_out: false, outcome: "executed", results: [] }, assertOwnership), error => error === lost);
      assert.equal(await readFile(red, "utf8"), "earlier red evidence");
      assert.equal(await readFile(verdict, "utf8"), "earlier verdict evidence");
    }
    assert.deepEqual(commands, loss === "runner" ? ["npm run build"] : ["npm run build", "npm run lint"]);
    const outcomeText = await readFile(outcome, "utf8");
    if (loss === "runner") assert.equal(outcomeText, "earlier outcome");
    else assert.equal(JSON.parse(outcomeText).passed, false);
  });
});

test("fully green close publishes before cleanup; a fenced terminal pointer leaves recovery intact", async t => {
  for (const lose of [false, true]) await t.test(lose ? "lost before terminal pointer" : "fully green", async t => {
    const f = await fixture(t);
    const { root, artifactsDir, store } = f;
    await reviewedClosing(f, "none");
    const friction = join(artifactsDir, "friction", "fixture.json");
    await mkdir(join(artifactsDir, "friction"));
    await writeFile(friction, "{}");
    const receipt = join(artifactsDir, "remediation-closing-result.json");
    const lock = join(artifactsDir, PHASE_LOCK_FILENAME);
    const report = join(root, ".audit-tools", "remediation-report.md");
    let published;
    let fallbackPublished = false;
    const agentId = processAgentId();
    const lost = new FileLockOwnershipLostError(lock);
    const continuation = runWithBlockedStepBackstop(() => store.withActiveOperator(async assertOwnership => {
      const state = await store.loadState();
      return runClosePhase(state, {
        root, artifactsDir, skipFinalGate: true, assertOwnership,
        publishReport: async (complete, assertCurrent) => {
          assert.equal((await store.loadState()).status, "complete");
          assert.equal(existsSync(report), true);
          assert.equal(existsSync(friction), true);
          assert.equal(existsSync(lock), true);
          assert.ok(JSON.parse(await readFile(receipt, "utf8")).pending_report);
          published = await presentReportStep(root, artifactsDir, complete, async () => {
            await assertCurrent();
            if (lose && existsSync(currentPromptPath(artifactsDir, agentId))) throw lost;
          });
          assert.equal(existsSync(lock), true);
        },
      });
    }), async () => { fallbackPublished = true; });
    if (lose) await assert.rejects(continuation, error => error === lost);
    else assert.equal((await continuation).status, "complete");
    assert.equal(fallbackPublished, false);
    assert.equal(existsSync(lock), false);
    assert.ok((await readFile(report, "utf8")).length);
    assert.equal((await store.loadState()).status, "complete");
    assert.equal(existsSync(friction), lose);
    assert.equal(Boolean(JSON.parse(await readFile(receipt, "utf8")).pending_report), lose);
    if (lose) {
      assert.equal(existsSync(currentStepPath(artifactsDir)), false);
      assert.equal(existsSync(currentStepPath(artifactsDir, agentId)), false);
      assert.equal(published, undefined);
      const recovered = await decideNextStep({ root, artifactsDir, skipFinalGate: true });
      assert.equal(recovered.step_kind, "present_report");
      assert.equal(existsSync(friction), false);
      assert.equal(existsSync(lock), false);
    } else {
      assert.equal(published.step_kind, "present_report");
      assert.equal(JSON.parse(await readFile(published.artifact_paths.current_step, "utf8")).step_kind, "present_report");
      assert.match(await readFile(published.prompt_path, "utf8"), /Present Remediation Report/);
      assert.equal(JSON.parse(await readFile(currentStepPath(artifactsDir), "utf8")).step_kind, "present_report");
      assert.match(await readFile(currentPromptPath(artifactsDir), "utf8"), /Present Remediation Report/);
      assert.equal(await readFile(join(root, ".audit-tools", "remediation-friction-fixture.json"), "utf8"), "{}");
    }
  });
});
