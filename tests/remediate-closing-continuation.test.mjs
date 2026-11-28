import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { contentSha256 as hash, hashContent } from "../dist/shared/index.js";
import {
  executionPlanPaths, ingestExecutionPlan, readCanonicalPlan, readExecutionIntent,
} from "../dist/remediate/contractPipeline/executionPlan.js";
import {
  buildStructuredAuditSourceManifest, intakePaths, INTAKE_SUMMARY_SCHEMA_VERSION,
} from "../dist/remediate/intake.js";
import { StateStore } from "../dist/remediate/state/store.js";

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

async function reviewedClosing({ root, artifactsDir, store }) {
  const paths = executionPlanPaths(artifactsDir);
  const { intentCheckpoint } = intakePaths(artifactsDir);
  await mkdir(paths.directory, { recursive: true });
  await put(intentCheckpoint, {
    schema_version: "intent-checkpoint/v1", confirmed_by: "host", confirmed_at: new Date().toISOString(),
    scope_summary: "Fixture only", intent_summary: "Verify the fixture", closing_action: "commit",
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
      project_type: "unknown", candidate_closing_actions: ["commit"] },
    items: { fixture: { unit_id: "fixture", status: "resolved_no_change" } }, closing_plan: { action: "commit" },
  });
  return { approval, paths };
}

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
