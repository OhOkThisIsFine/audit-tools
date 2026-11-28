import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AGENT_FEEDBACK_FILENAME, EXTERNAL_ANALYZER_CANDIDATES } from "../dist/shared/index.js";
import { cmdNextStep } from "../dist/audit/cli/nextStepCommand.js";
import { requireFunctionalPreflight } from "../dist/audit/cli/functionalPreflight.js";

const limitation = "Synthetic fixture cannot inspect structural relationships.";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "audit-degraded-depth-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({
    AUDIT_CODE_STATE_DIR: join(root, ".audit-tools", "test-state"),
    AUDIT_TOOLS_CBM_BIN: join(root, "nonexistent-indexer.exe"),
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const fetch = t.mock.method(globalThis, "fetch", () => assert.fail("This fixture must not fetch"));
  t.after(() => assert.equal(fetch.mock.callCount(), 0));
  const artifacts = join(root, ".audit-tools", "audit");
  const put = (name, value) => writeFile(join(artifacts, name), JSON.stringify(value));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  await writeFile(join(root, "main.js"), "export const fixture = 42;\n");
  git("add", "main.js");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  await mkdir(artifacts, { recursive: true });
  await put("analyzer-policy.json", { analyzers: Object.fromEntries(EXTERNAL_ANALYZER_CANDIDATES.map(candidate => [candidate.id, "skip"])) });
  const run_id = randomUUID();
  await put("run-consent.json", { schema_version: "audit-run-consent/v1", run_id, repository_root: root, decisions: {} });
  const preflight = (overrides = {}) => put("functional-preflight.json", {
    contract_version: "audit-functional-preflight/v1",
    run_id, repository_root: root,
    source_inspection: { available: true, evidence: "Synthetic source inspection." },
    relationship_inspection: { available: false, evidence: "Synthetic missing relationship inspection." },
    decision: "degraded", operator_approved_degraded: true, limitation, ...overrides,
  });
  const confirmed_at = new Date().toISOString();
  const checkpoint = design_review => put("intent_checkpoint.json", {
    schema_version: "intent-checkpoint/v1", confirmed_at, confirmed_by: "host",
    scope_summary: "Fixture", intent_summary: "Comprehensive repository review",
    design_review: { answered_at: confirmed_at, ...design_review },
  });
  const next = async () => {
    await cmdNextStep([process.execPath, "audit-code.mjs", "next-step", "--root", root, "--timeout", "30000"]);
    const step = JSON.parse(await readFile(join(artifacts, "steps", "current-step.json"), "utf8"));
    return { ...step, prompt: await readFile(step.prompt_path, "utf8") };
  };
  const preparedIntent = async () => {
    let step = await next();
    const displayedRequest = () => JSON.parse(step.prompt.match(/\{\n\s+"input_sha256"[^]*?\n\}/)[0]);
    if (step.step_kind === "analyzer_selection") {
      const request = displayedRequest();
      for (const row of request.decisions) Object.assign(row, { action: "omit", reason: "Synthetic fixture" });
      await writeFile(step.artifact_paths.analyzer_selection, JSON.stringify(request));
      step = await next();
    }
    if (step.step_kind === "analyzer_calibration") {
      const request = displayedRequest();
      for (const row of request.decisions) Object.assign(row, {
        reason: "Synthetic fixture", coverage: "No external analyzer coverage",
      });
      await writeFile(step.artifact_paths.analyzer_calibration, JSON.stringify(request));
      step = await next();
    }
    if (step.step_kind === "critical_flow_fallback") {
      const [submission] = step.access.write_paths;
      await writeFile(submission, JSON.stringify({ flows: [] }));
      step = await next();
    }
    return step;
  };
  return { root, artifacts, preflight, checkpoint, next, preparedIntent };
}

test("degraded offers only shallow, retains the limitation and honors confirmed shallow", async t => {
  const { artifacts, preflight, checkpoint, next, preparedIntent } = await fixture(t);
  await preflight();
  const step = await preparedIntent();
  assert.equal(step.step_kind, "confirm_intent");
  assert.equal(step.status, "ready");
  assert.match(step.prompt, /shallow only/);
  assert.ok(step.prompt.includes(limitation));
  assert.doesNotMatch(step.prompt, /\*\*deep\*\*|approved shallow or deep/);
  assert.ok((await readFile(join(artifacts, AGENT_FEEDBACK_FILENAME), "utf8")).includes(limitation));
  await checkpoint({ conceptual_depth: "shallow" });
  const after = await next();
  assert.equal(after.status, "ready");
  assert.equal(after.step_kind, "design_review_parallel");
  assert.ok(after.artifact_paths.conceptual_prompt);
  assert.equal(after.artifact_paths.conceptual_round_manifest, undefined);
});

test("incompatible degraded checkpoints are blocked, not rewritten; valid ready evidence lifts the limit", async t => {
  const { root, artifacts, preflight, checkpoint, next, preparedIntent } = await fixture(t);
  await preflight();
  for (const dials of [
    { conceptual_depth: "deep" },
    { perspectives: [{ name: "Fixture", lens: "Synthetic review perspective" }] },
    { conceptual_depth: "shallow", perspectives: 3 },
    { conceptual_depth: "shallow", perspectives: [{ name: "Fixture", lens: "Synthetic review perspective" }] },
  ]) {
    await checkpoint(dials);
    const checkpointPath = join(artifacts, "intent_checkpoint.json");
    const before = await readFile(checkpointPath, "utf8");
    const step = await next();
    assert.equal(step.step_kind, "confirm_intent");
    assert.equal(step.status, "blocked");
    assert.match(step.prompt, /approved shallow review only/);
    assert.equal(await readFile(checkpointPath, "utf8"), before);
    await assert.rejects(requireFunctionalPreflight(root, artifacts), /approved shallow review only/);
  }
  await preflight({ decision: "ready" });
  assert.equal((await next()).step_kind, "functional_preflight");
  await preflight({
    decision: "ready", operator_approved_degraded: false,
    relationship_inspection: { available: true, evidence: "Synthetic working relationship inspection." },
  });
  await rm(join(artifacts, "intent_checkpoint.json"));
  const ready = await preparedIntent();
  assert.equal(ready.step_kind, "confirm_intent");
  assert.match(ready.prompt, /\*\*deep\*\* - fan out/);
  await checkpoint({ conceptual_depth: "deep", ceiling: { rung: "shallow" } });
  const after = await next();
  assert.equal(after.status, "ready");
  assert.equal(after.step_kind, "design_review_parallel");
  assert.ok(after.artifact_paths.conceptual_round_manifest);
});

test("stopped and mismatched reports do not authorize semantic work", async t => {
  const { root, artifacts, preflight, checkpoint, next } = await fixture(t);
  await checkpoint({ conceptual_depth: "shallow" });
  for (const [overrides, expected] of [
    [{ decision: "stop" }, /operator stopped/],
    [{ run_id: randomUUID() }, /another run or repository/],
    [{ repository_root: join(root, "wrong") }, /another run or repository/],
  ]) {
    await preflight(overrides);
    const step = await next();
    assert.equal(step.step_kind, "functional_preflight");
    assert.match(step.progress.summary, expected);
    await assert.rejects(requireFunctionalPreflight(root, artifacts), expected);
  }
});
