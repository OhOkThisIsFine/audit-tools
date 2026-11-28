import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionPlanPaths, readPlanSource } from "../dist/remediate/contractPipeline/executionPlan.js";
import { buildNextContractPipelineStep, readApprovedExecutionPlan, writePathASeedFromFindings } from "../dist/remediate/steps/contractPipeline.js";

const example = id => ({
  id, claim: `Claim ${id}`, reproduction_steps: ["Inspect the fixture"],
  expected: "expected", actual: "actual", requirement_ids: ["REQ-fixture"], unit_ids: ["UNIT-fixture"],
});
const writeJson = (path, value) => writeFile(path, JSON.stringify(value));
const readJson = async path => JSON.parse(await readFile(path, "utf8"));

async function judgeFixture(t, acceptedIds, currentIds) {
  const root = await mkdtemp(join(tmpdir(), "audit-judge-counterexamples-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, ".audit-tools");
  const paths = executionPlanPaths(artifactsDir);
  const sourcePath = join(root, "report.json");
  const report = { findings: [] };
  await writeJson(sourcePath, report);
  await writeFile(join(root, "fixture.txt"), "fixture\n");
  await writePathASeedFromFindings(artifactsDir, sourcePath, report);
  const { plan_id } = await readPlanSource(artifactsDir);
  await writeJson(paths.history, {
    counterexamples: [example("closed"), ...acceptedIds.map(example)], accepted_ids: acceptedIds, repair_rounds: 0,
  });
  await writeJson(paths.submission, { base_revision_sha256: null, plan: {
    plan_id, objective: "Review a fixture plan", non_goals: [], source_dispositions: [],
    requirements: [{ id: "REQ-fixture", description: "Fixture behavior", source_finding_ids: [], change_kind: "addition",
      assertions: [{ kind: "positive", description: "Fixture is inspectable", scope_paths: ["fixture.txt"] }] }],
    units: [{ id: "UNIT-fixture", title: "Fixture", description: "Inspect fixture", source_finding_ids: [],
      requirement_ids: ["REQ-fixture"], dependencies: [], read_paths: ["fixture.txt"], allowed_files: [],
      required_tests: [], addresses_counterexample_ids: acceptedIds }],
  } });

  const next = () => buildNextContractPipelineStep({ root, artifactsDir, runId: "judge-fixture" });
  const prompt = async step => readFile((await step).prompt_path, "utf8");
  const submit = async (role, result, mode = "independent") => {
    const files = paths.review(role);
    const { prompt_sha256 } = await readJson(files.request);
    await writeJson(files.submission, { contract_version: "review-submission/v1", prompt_sha256,
      review: { mode, reason: "Synthetic review binding fixture" }, result });
  };
  assert.match(await prompt(next()), /^# Executable plan critique/u);
  await submit("critique", { verdict: "approved", issues: [] });
  assert.match(await prompt(next()), /^# Executable plan critic/u);
  await submit("critic", { counterexamples: currentIds.map(id => ({ ...example(id), claim: `Current critic claim ${id}` })) });
  const judgePrompt = await prompt(next());
  assert.match(judgePrompt, /^# Executable plan judge/u);
  const classifications = ids => ({ verdict: "approved",
    classifications: ids.map(counterexample_id => ({ counterexample_id,
      classification: acceptedIds.includes(counterexample_id) ? "repaired" : "invalid", rationale: "Synthetic fixture outcome" })),
    requirement_assessments: [{ requirement_id: "REQ-fixture", verdict: "satisfied", evidence: ["Fixture evidence"] }],
    disposition_assessments: [],
  });
  return { artifactsDir, judgePrompt, next, prompt, submit, classifications };
}

test("native judge prompt and validation use the deduplicated active IDs, not closed history", async t => {
  const { artifactsDir, judgePrompt, next, prompt, submit, classifications } =
    await judgeFixture(t, ["carried", "repeated"], ["current", "repeated"]);
  const activeLine = judgePrompt.match(/^Required counterexample classification IDs: (.+)\.$/mu);
  const active = JSON.parse(activeLine[1]);
  assert.deepEqual(active, ["carried", "repeated", "current"]);
  assert.match(judgePrompt, /^Historical counterexamples \(reference only; do not classify\): .*"id":"closed"/mu);
  for (const ids of [["current", "repeated"], ["carried", "repeated", "repeated"],
    [...active, "unrelated"], ["carried", "repeated", "closed"]]) {
    await submit("judge", classifications(ids));
    assert.match(await prompt(next()), /Refused response:\s+Judge must classify every current\/previously accepted counterexample exactly once/u);
    assert.equal(await readApprovedExecutionPlan(artifactsDir), undefined);
  }
  await submit("judge", classifications(active), "degraded");
  assert.match(await prompt(next()), /requires an independent context/u);
  await submit("judge", classifications(active));
  assert.equal(await next(), null);
  assert.deepEqual((await readApprovedExecutionPlan(artifactsDir)).history.accepted_ids, []);
});

test("native judge explicitly requests an empty classifications array when only closed history remains", async t => {
  const { artifactsDir, judgePrompt, next, submit, classifications } = await judgeFixture(t, [], []);
  assert.match(judgePrompt, /^Required counterexample classification IDs: \[\]\.\nNo IDs are required; return classifications: \[\]\./mu);
  assert.match(judgePrompt, /^Historical counterexamples \(reference only; do not classify\): .*"id":"closed"/mu);
  await submit("judge", classifications([]));
  assert.equal(await next(), null);
  assert.deepEqual((await readApprovedExecutionPlan(artifactsDir)).history.counterexamples.map(entry => entry.id), ["closed"]);
});

test("native judge uses the current critic record when historical IDs recur", async t => {
  const { judgePrompt, next, submit, classifications } = await judgeFixture(t, ["carried", "repeated"], ["closed", "repeated"]);
  assert.match(judgePrompt, /^Required counterexample classification IDs: \["carried","repeated","closed"\]\./mu);
  assert.match(judgePrompt, /Use the current critic review for any ID it reports/u);
  assert.match(judgePrompt, /^Active counterexamples carried from earlier reviews: .*"id":"carried"/mu);
  assert.match(judgePrompt, /^Historical counterexamples \(reference only; do not classify\): \[\]\./mu);
  assert.doesNotMatch(judgePrompt, /"id":"(?:closed|repeated)"/u);
  await submit("judge", classifications(["carried", "repeated", "closed"]));
  assert.equal(await next(), null);
});
