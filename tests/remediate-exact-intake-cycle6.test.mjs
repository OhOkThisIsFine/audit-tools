import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { buildSampleAuditBundle } from "../dist/audit/cli/sampleRunCommand.js";
import { readPlanSource } from "../dist/remediate/contractPipeline/executionPlan.js";
import { INTAKE_SUMMARY_SCHEMA_VERSION, intakePaths } from "../dist/remediate/intake.js";
import { StateStore } from "../dist/remediate/state/store.js";
import { toolOwnedFinalGateCommands } from "../dist/remediate/steps/gateCommands.js";
import { decideNextStep, defaultInputCandidates } from "../dist/remediate/steps/nextStep.js";
import { toPromptPathToken } from "../dist/shared/tooling/exec.js";
import { parseCommandString } from "../dist/shared/tooling/commandShape.js";

const audit = buildSampleAuditBundle().auditFindings;
const report = JSON.stringify(audit) + "\n";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

async function put(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "remediate-exact-intake-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, ".audit-tools", "remediation");
  return {
    root, artifactsDir, paths: intakePaths(artifactsDir), candidates: defaultInputCandidates(root),
    next: options => decideNextStep({ root, artifactsDir, ...options }),
  };
}

async function displayedBinding(step) {
  assert.equal(step.step_kind, "confirm_auto_discovered_input");
  const prompt = await readFile(step.prompt_path, "utf8");
  const match = /\x60{3}json\r?\n([^\r\n]+)\r?\n\x60{3}/u.exec(prompt);
  assert.ok(match, prompt);
  return JSON.parse(match[1]);
}

async function readySummary(paths) {
  await put(paths.summary, {
    schema_version: INTAKE_SUMMARY_SCHEMA_VERSION, ready: true, source_type: "structured_audit",
    goals: ["Process fixture findings."], non_goals: [], constraints: [], affected_files: [], open_questions: [],
    source_summary: "Synthetic audit report.", acceptance_criteria: ["Use the confirmed revision."],
    scope_summary: "Synthetic report only.", intent_summary: "Process fixture findings.", filters: {},
  });
}

test("discovered selection preserves the displayed report digest through a changed ranking and bare pre-plan calls", async t => {
  const f = await fixture(t);
  const [higher, , original] = f.candidates;
  await put(original, report);
  const publication = await f.next();
  const binding = await displayedBinding(publication);
  assert.deepEqual(binding, { status: "confirmed", path: toPromptPathToken(original), sha256: digest(report) });
  await put(higher, " " + report);
  await put(publication.artifact_paths.confirm_auto_discovered_input_ack, binding);
  const synthesis = await f.next();
  assert.equal(synthesis.step_kind, "synthesize_intake");
  const snapshot = join(f.paths.discoveredInputSnapshots, digest(report), basename(original));
  assert.ok((await readFile(synthesis.prompt_path, "utf8")).includes(toPromptPathToken(snapshot)));
  assert.equal(await readFile(snapshot, "utf8"), report);
  const manifest = JSON.parse(await readFile(f.paths.sourceManifest, "utf8"));
  assert.equal(manifest.created_from, "default_candidates");
  assert.deepEqual(manifest.discovered_input, { path: original, sha256: digest(report) });
  assert.equal((await f.next()).step_kind, "synthesize_intake");
  await readySummary(f.paths);
  assert.equal((await f.next()).step_kind, "confirm_intent");
  await put(f.paths.intentCheckpoint, {
    schema_version: "intent-checkpoint/v1", confirmed_by: "host",
    confirmed_at: "2026-01-01T00:00:00.000Z",
    scope_summary: "Synthetic report only.", intent_summary: "Process fixture findings.", filters: {},
  });
  assert.equal((await f.next()).step_kind, "contract_pipeline");
  const source = await readPlanSource(f.artifactsDir);
  assert.equal(source.question_report, true);
  assert.deepEqual(source.sources, [{ path: original, sha256: digest(report) }]);
});

test("status-only acknowledgement and revised bytes need a new exact approval", async t => {
  const f = await fixture(t);
  const original = f.candidates[2];
  await put(original, report);
  let step = await f.next();
  const first = await displayedBinding(step);
  await put(step.artifact_paths.confirm_auto_discovered_input_ack, { status: "confirmed" });
  step = await f.next();
  assert.deepEqual(await displayedBinding(step), first);
  const revised = "\n" + report;
  await put(original, revised);
  await put(step.artifact_paths.confirm_auto_discovered_input_ack, first);
  step = await f.next();
  const revisedBinding = await displayedBinding(step);
  assert.deepEqual(revisedBinding, { status: "confirmed", path: toPromptPathToken(original), sha256: digest(revised) });
  assert.equal(await readPlanSource(f.artifactsDir), undefined);
  await assert.rejects(readFile(f.paths.sourceManifest), { code: "ENOENT" });

  await put(step.artifact_paths.confirm_auto_discovered_input_ack, revisedBinding);
  assert.equal((await f.next()).step_kind, "synthesize_intake");
  await readySummary(f.paths);
  await put(original, report);
  step = await f.next();
  assert.deepEqual(await displayedBinding(step), first);
  assert.equal(await readPlanSource(f.artifactsDir), undefined);
  await put(step.artifact_paths.confirm_auto_discovered_input_ack, first);
  assert.equal((await f.next()).step_kind, "synthesize_intake");
  await assert.rejects(readFile(f.paths.summary), { code: "ENOENT" });
});

test("a disappeared only discovered report requests a new source instead of re-delivering prior completion", async t => {
  const f = await fixture(t);
  const priorReport = join(dirname(f.artifactsDir), "remediation-report.md");
  await put(priorReport, "# Previous completed fixture");
  await utimes(priorReport, new Date(0), new Date(0));
  assert.equal((await f.next()).step_kind, "present_report");
  const original = f.candidates[2];
  await put(original, report);
  const publication = await f.next();
  await put(publication.artifact_paths.confirm_auto_discovered_input_ack, await displayedBinding(publication));
  await unlink(original);
  assert.equal((await f.next()).step_kind, "collect_starting_point");
  assert.equal((await f.next()).step_kind, "collect_starting_point");
  assert.equal(await readPlanSource(f.artifactsDir), undefined);
  assert.equal(await readFile(priorReport, "utf8"), "# Previous completed fixture");
  await put(original, report);
  assert.equal((await f.next()).step_kind, "confirm_auto_discovered_input");
});

test("decline still requests a starting point and explicit input or guidance still bypasses discovery", async t => {
  for (const kind of ["input", "guidanceFile"]) await t.test(kind, async t => {
    const f = await fixture(t);
    await put(f.candidates[2], report);
    const publication = await f.next();
    await displayedBinding(publication);
    await put(publication.artifact_paths.confirm_auto_discovered_input_ack, { status: "declined" });
    assert.equal((await f.next()).step_kind, "collect_starting_point");
    const path = join(f.root, kind === "input" ? "alternate.json" : "guidance.md");
    await put(path, kind === "input" ? report : "Use this synthetic guidance.");
    assert.equal((await f.next({ [kind]: path })).step_kind, "synthesize_intake");
    const manifest = JSON.parse(await readFile(f.paths.sourceManifest, "utf8"));
    assert.equal(manifest.created_from, kind === "input" ? "input" : "conversation");
    assert.equal(manifest.discovered_input, undefined);
    assert.equal(manifest.sources[0].path, kind === "input" ? path : f.paths.conversationStart);
  });
});

test("a discovered document is synthesized from the confirmed bytes, not a moving working path", async t => {
  const f = await fixture(t);
  const original = f.candidates[5];
  const document = Buffer.from("# Synthetic narrative\r\n\r\nExample: é.\r\n");
  await put(original, document);
  const publication = await f.next();
  await put(publication.artifact_paths.confirm_auto_discovered_input_ack, await displayedBinding(publication));
  const step = await f.next();
  assert.equal(step.step_kind, "synthesize_intake");
  const snapshot = join(f.paths.discoveredInputSnapshots, digest(document), basename(original));
  assert.ok((await readFile(step.prompt_path, "utf8")).includes(toPromptPathToken(snapshot)));
  assert.deepEqual(await readFile(snapshot), document);
  await put(original, "Revised document");
  assert.deepEqual(await readFile(snapshot), document);
  assert.equal((await f.next()).step_kind, "confirm_auto_discovered_input");
});

test("a verification override requires a nonempty executable but preserves empty later arguments", async t => {
  const f = await fixture(t);
  const store = new StateStore(f.artifactsDir);
  const oldCommand = "node --version";
  await store.saveState({
    status: "implementing", items: {}, run_start_dirty: [], run_start_dirty_encoding: "git-z/v1",
    plan: {
      plan_id: "fixture-plan", objective: "Verify fixture intake", non_goals: [], requirements: [], units: [],
      source_dispositions: [], review_revision_sha256: "0".repeat(64), findings: [], project_type: "node",
      candidate_closing_actions: [], test_command: oldCommand, test_command_source: "project_facts",
    },
  });
  await assert.rejects(f.next({ verificationCommand: '"" argument' }), /--verification-command must name an executable command/u);
  assert.equal((await store.loadState()).plan.test_command, oldCommand);
  assert.equal((await store.loadState()).plan.test_command_source, "project_facts");
  const valid = 'node ""';
  assert.equal((await f.next({ verificationCommand: valid })).step_kind, "confirm_resume_or_restart");
  const { plan } = await store.loadState();
  assert.equal(plan.test_command_source, "explicit");
  const argv = parseCommandString(plan.test_command);
  assert.deepEqual(argv, ["node", ""]);
  assert.deepEqual(toolOwnedFinalGateCommands(f.root, argv).find(gate => gate.layer === "unit")?.argv, argv);
});
