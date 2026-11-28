import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executionPlanIssues, executionPlanPaths, readPlanSource } from "../dist/remediate/contractPipeline/executionPlan.js";
import { buildNextContractPipelineStep, writePathASeedFromFindings } from "../dist/remediate/steps/contractPipeline.js";
import { renderPlanAuthorPrompt } from "../dist/remediate/steps/contractPipelinePrompts.js";
import { QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION } from "../dist/shared/types/questionReviewReport.js";

const suggestion = "Design option: reorganize the display, or replace its layout entirely.";
const guidance = "Keep the layout; group the existing display options without changing their values.";
const finding = {
  id: "F-confirmed", title: "Fix a label", category: "correctness", severity: "low",
  confidence: "high", lens: "behavior", summary: `One label is wrong. ${suggestion}`, affected_files: [],
};

async function fixture(t, mixed) {
  const root = await mkdtemp(join(tmpdir(), "audit-mixed-guidance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactsDir = join(root, ".audit-tools");
  const reportPath = join(root, "audit-findings.json");
  const guidancePath = join(root, "operator-guidance.md");
  const report = { contract_version: QUESTION_AUDIT_FINDINGS_CONTRACT_VERSION, findings: [finding] };
  await writeFile(reportPath, JSON.stringify(report));
  if (mixed) await writeFile(guidancePath, guidance);
  await writeFile(join(root, "display.txt"), "fixture display\n");
  await writePathASeedFromFindings(artifactsDir, reportPath, report, mixed ? [guidancePath] : []);
  const source = await readPlanSource(artifactsDir);
  const makeUnit = (id, description, findingIds) => ({
    id, title: description, description, source_finding_ids: findingIds,
    requirement_ids: [`REQ-${id}`], dependencies: [], read_paths: ["display.txt"],
    allowed_files: ["display.txt"], required_tests: [], affected_interfaces: [], addresses_counterexample_ids: [],
  });
  const units = [makeUnit("fix", "Correct the label", [finding.id]), makeUnit("design", guidance, [])];
  const plan = {
    plan_id: source.plan_id, objective: "Fix the label and group the display options", non_goals: [],
    units, source_dispositions: [], requirements: units.map(unit => ({
      id: unit.requirement_ids[0], description: unit.description, source_finding_ids: unit.source_finding_ids,
      change_kind: "behavior_change", assertions: [
        { kind: "positive", description: unit.description, scope_paths: ["display.txt"] },
        { kind: "negative", description: "Preserve option values", scope_paths: ["display.txt"] },
      ],
    })),
  };
  const paths = executionPlanPaths(artifactsDir);
  const prompt = reason => renderPlanAuthorPrompt({
    root, source, sourcePath: paths.source, planPath: paths.canonical, outputPath: paths.submission,
    history: { counterexamples: [], accepted_ids: [], repair_rounds: 0 }, reason,
  });
  return { root, artifactsDir, paths, source, plan, reportPath, guidancePath, prompt };
}

test("mixed guidance preserves findings and routes separate scope through the existing owner decision", async t => {
  const { root, artifactsDir, paths, source, plan, reportPath, guidancePath, prompt } = await fixture(t, true);
  assert.equal(source.question_report, true);
  assert.deepEqual(source.findings, [finding]);
  assert.deepEqual(new Set(source.sources.map(entry => entry.path)), new Set([reportPath, guidancePath]));
  assert.deepEqual(source.request.source_paths, [guidancePath]);
  assert.equal(source.request.text, guidance);
  assert.deepEqual(executionPlanIssues(root, source, plan), []);
  assert.match(prompt(), /This is mixed input[\s\S]*operator approval before execution/u);
  await writeFile(paths.submission, JSON.stringify({ base_revision_sha256: null, plan }));
  const options = { root, artifactsDir, runId: "mixed-fixture" };
  const decision = await buildNextContractPipelineStep(options);
  assert.equal(decision.status, "blocked");
  assert.match(await readFile(decision.prompt_path, "utf8"), /Confirm the requested change plan[\s\S]*approved_unit_ids/u);
  const { revision_sha256 } = JSON.parse(await readFile(paths.canonical, "utf8"));
  await writeFile(paths.ownerDecision, JSON.stringify({
    revision_sha256, confirmed_by: "host", approved_unit_ids: ["fix", "design"], declined_units: [],
  }));
  const review = await buildNextContractPipelineStep(options);
  assert.match(await readFile(review.prompt_path, "utf8"), /^# Executable plan critique/u);
});

test("report prose and a broader plan objective do not lift the finding association requirement", async t => {
  const { root, source, plan, prompt } = await fixture(t, false);
  assert.equal(source.request, undefined);
  assert.match(source.findings[0].summary, /Design option:/u);
  const issues = executionPlanIssues(root, source, plan);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /Unit design has write scope without an approved confirmed finding/u);
  assert.match(issues[0], /explicitly start a new run:[\s\S]*--input <report-path> --guidance[\s\S]*--guidance-file/u);
  assert.match(issues[0], /Report suggestions alone do not authorize writes/u);
  assert.match(prompt(issues.join("\n")), /Do not attach a finding ID[\s\S]*report prose or topical relevance is not authorization/u);
  const loader = await readFile(new URL("../skills/remediate-code/remediate-code.prompt.md", import.meta.url), "utf8");
  assert.match(loader, /--input <report-path> --guidance[\s\S]*suggestion\s+in the report, even if relevant, is not permission to write/u);
});
