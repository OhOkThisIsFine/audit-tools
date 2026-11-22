import { beforeEach, afterEach, expect, test } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildQuestionAuditFindingsReport } from "../../src/audit/reporting/questionReport.js";
import type { QuestionAuditFindingsReport } from "../../src/shared/types/questionReviewReport.js";
import { QuestionAuditFindingsReportSchema } from "../../src/shared/types/questionReviewReport.js";
import { REVIEW_QUESTION_CONTRACT_VERSION, type ReviewAcceptedAnswer, type ReviewDependency, type ReviewFindingClaim, type ReviewPlan } from "../../src/shared/types/reviewQuestion.js";
import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

const harness = createNextStepHarness(".test-intake-finding-selection");
const { REPO_DIR, ARTIFACTS_DIR } = harness;
const sourcePath = (): string => join(REPO_DIR, "audit-findings.json");
let report: QuestionAuditFindingsReport;

beforeEach(async () => {
  await harness.resetTestRepo();
  await writeFile(join(REPO_DIR, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  for (const file of ["alpha", "beta", "gamma"]) await writeFile(join(REPO_DIR, "src", `${file}.ts`), `export const ${file} = 1;\n`);
  const schema_version = REVIEW_QUESTION_CONTRACT_VERSION;
  const snapshot_id = "snapshot-a";
  const plan: ReviewPlan = {
    schema_version, snapshot_id, inventory: [], omissions: [], lens_decisions: [], questions: [],
  };
  const accepted: ReviewAcceptedAnswer[] = [];
  const dependenciesByQuestion = new Map<string, ReviewDependency[]>();
  for (const [index, name] of ["alpha", "beta", "gamma"].entries()) {
    const identity = { schema_version, snapshot_id, question_id: `question-${name}`, revision_id: `revision-${name}` } as const;
    const source = { path: `src/${name}.ts`, start_line: 1, end_line: 1 };
    const dependency = { kind: "source" as const, key: source.path, fingerprint: name };
    dependenciesByQuestion.set(identity.question_id, [dependency]);
    const observation_id = `observation-${name}`;
    plan.inventory.push({
      inventory_item_id: name, kind: "operation", title: name, scope: "in_scope", source_refs: [source], contract_refs: [],
    });
    plan.questions.push({
      ...identity, lens: index === 1 ? "security" : "behavior", inventory_item_ids: [name],
      expected_outcome: "Declared behavior", requested_parts: [{ part_id: "repair", expectation: "Retain declared behavior" }],
      source_dependencies: [], evidence_dependencies: [], plan_status: "active",
    });
    const claim: ReviewFindingClaim = {
      schema_version, question_id: identity.question_id, revision_id: identity.revision_id,
      finding_id: name, kind: "confirmed_defect", severity: index === 0 ? "high" : "low", confidence: "high",
      claim: `${name} unique failure`, consequence: `${name} requires repair`, next_step: "Fix the behavior",
      evidence_ids: [], source_refs: [source], observation_ids: [observation_id], verification: [],
    };
    accepted.push({
      schema_version, dependency_bindings: [dependency], accepted_at: "2026-11-21T00:00:00Z",
      submission: {
        ...identity, submission_id: `answer-${name}`, assignment_id: `assignment-${name}`,
        inspected_sources: [source], evidence_ids: [], limitations: [],
        answer: {
          outcome: "findings",
          observations: [{
            ...identity, observation_id, part_id: "repair", kind: "source_confirmed",
            statement: "The declared path does not meet the contract.", source_refs: [source], evidence_refs: [],
          }],
          parts: [{ part_id: "repair", outcome: "findings", observation_ids: [observation_id] }],
          findings: [claim, ...(index === 0 ? [{ ...claim, finding_id: "optional-improvement", kind: "design_opportunity" as const }] : [])],
        },
      },
    });
  }
  report = QuestionAuditFindingsReportSchema.parse(buildQuestionAuditFindingsReport({
    plan, accepted, auditRead: null, evidence: [], dependenciesByQuestion,
  }));
  report.top_risks = [...report.findings.map((finding) => `${finding.id}: ${finding.title}`), "Unbound whole-report risk"];
  report.executive_summary = "Whole-report conclusions";
  await writeFile(sourcePath(), JSON.stringify(report));
});
afterEach(async () => { await harness.cleanupTestRepo(); });

function cli(...flags: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", resolve("src/remediate/index.ts"), "next-step", "--root", REPO_DIR, "--input", sourcePath(), ...flags], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30000,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.test.json") },
  });
}
async function projected(): Promise<QuestionAuditFindingsReport> {
  return JSON.parse(await readFile(join(ARTIFACTS_DIR, "intake", "selected-audit-findings.json"), "utf8"));
}

function id(name: string): string { return report.findings.find((finding) => finding.question_review_sources?.[0]?.finding_id === name)!.id; }

test("--input severity and explicit finding IDs form a union with intact canonical topology", async () => {
  const before = await readFile(sourcePath(), "utf8");
  const result = cli("--severity", "high", "--finding-id", id("beta"));
  expect(result.status, result.stderr).toBe(0);
  const selected = await projected();
  expect(selected.findings.map((finding) => finding.id).sort()).toEqual([id("alpha"), id("beta")].sort());
  expect(selected.coherence_trace.components.flat().sort()).toEqual([id("alpha"), id("beta")].sort());
  expect(selected.work_blocks.flatMap((block) => block.finding_ids).sort()).toEqual([id("alpha"), id("beta")].sort());
  expect(selected.top_risks).toEqual(report.top_risks!.filter((risk) => risk.includes(id("alpha")) || risk.includes(id("beta"))));
  expect(selected.executive_summary).toBeUndefined();
  expect(selected.question_review.findings.find((row) => row.canonical_finding_id === id("gamma"))?.actionable).toBe(false);
  expect(selected.question_review.findings.find((row) => row.sources.some(source => source.finding_id === "optional-improvement"))).toEqual(
    report.question_review.findings.find((row) => row.sources.some(source => source.finding_id === "optional-improvement")),
  );
  expect(selected.findings.map((item) => item.question_review_sources)).toEqual(
    report.findings.filter((item) => item.id === id("alpha") || item.id === id("beta")).map((item) => item.question_review_sources),
  );
  expect(await readFile(sourcePath(), "utf8")).toBe(before);
  const resumed = await decideNextStep({ root: REPO_DIR, input: sourcePath() });
  expect(resumed.step_kind).toBe("synthesize_intake");
  expect((await projected()).findings.map((finding) => finding.id)).toEqual(selected.findings.map((finding) => finding.id));
});

test("unknown IDs refuse even when severity would select valid findings", () => {
  const result = cli("--severity", "high", "--finding-id", "UNKNOWN-ID");
  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toMatch(/unknown.*finding|finding.*unknown/i);
});

test("an empty validated selection produces explicit no-work before synthesis", async () => {
  const result = cli("--severity", "critical");
  expect(result.status, result.stderr).toBe(0);
  const step = JSON.parse(await readFile(join(ARTIFACTS_DIR, "steps", "current-step.json"), "utf8"));
  expect(step.step_kind).toBe("zero_documentable_findings");
  expect(step.status).toBe("complete");
  expect((await projected()).findings).toEqual([]);
});

test("other scope exclusions still intersect a selected explicit ID", async () => {
  expect(cli("--severity", "high", "--finding-id", id("beta")).status).toBe(0);
  await writeFile(join(ARTIFACTS_DIR, "intake", "intake-summary.json"), JSON.stringify(intakeSummaryFixture({ source_type: "structured_audit", affected_files: [] })));
  await harness.writeIntentCheckpoint();
  const checkpointPath = join(ARTIFACTS_DIR, "intent_checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  checkpoint.must_not_touch = ["src/beta.ts"];
  await writeFile(checkpointPath, JSON.stringify(checkpoint));
  const first = await decideNextStep({ root: REPO_DIR, input: sourcePath() });
  if (first.step_kind === "collect_review_approval") {
    await writeFile(join(ARTIFACTS_DIR, "review_resolution.json"), "{}");
    await decideNextStep({ root: REPO_DIR, input: sourcePath() });
  }
  const filter = JSON.parse(await readFile(join(ARTIFACTS_DIR, "review_filter_dispositions.json"), "utf8"));
  expect(filter.droppedNoEvidence).toEqual([]);
  expect(report.findings.find(finding => finding.id === id("alpha"))?.evidence).toEqual([
    "src/alpha.ts:1-1: The declared path does not meet the contract.",
  ]);
  expect(filter.droppedByCheckpoint).toContain(id("beta"));
  expect(filter.originals.map((finding: { id: string }) => finding.id).sort()).toEqual([id("alpha"), id("beta")].sort());
});


for (const change of ["selectors", "source"] as const) {
  test(`${change} drift conflicts with an active selection without overwriting it`, async () => {
    expect(cli("--severity", "high").status).toBe(0);
    await harness.saveState(makePlanningState());
    const before = await readFile(join(ARTIFACTS_DIR, "intake", "selected-audit-findings.json"), "utf8");
    if (change === "source") await writeFile(sourcePath(), JSON.stringify(report) + "\n");
    const step = await decideNextStep({ root: REPO_DIR, ...(change === "selectors" ? { severity: ["low"] } : {}) });
    expect(step.step_kind).toBe("input_conflict");
    expect(await readFile(join(ARTIFACTS_DIR, "intake", "selected-audit-findings.json"), "utf8")).toBe(before);
  });
}

test("unknown severities refuse even alongside a valid explicit finding", () => {
  const result = cli("--severity", "urgent", "--finding-id", id("alpha"));
  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toMatch(/severity|enum/i);
});

test("selecting every finding preserves original narrative", async () => {
  const result = cli("--severity", "high", "--severity", "low");
  expect(result.status, result.stderr).toBe(0);
  const selected = await projected();
  expect(selected.top_risks).toEqual(report.top_risks);
  expect(selected.executive_summary).toEqual(report.executive_summary);
});


test("a later explicitly confirmed severity filter can narrow the native union", async () => {
  expect(cli("--severity", "high", "--finding-id", id("beta")).status).toBe(0);
  await writeFile(join(ARTIFACTS_DIR, "intake", "intake-summary.json"), JSON.stringify(intakeSummaryFixture({ source_type: "structured_audit", affected_files: [] })));
  const confirmation = await decideNextStep({ root: REPO_DIR, input: sourcePath() });
  expect(confirmation.step_kind).toBe("confirm_intent");
  const prompt = await readFile(confirmation.prompt_path, "utf8");
  expect(prompt).toContain("UNION");
  expect(prompt).toContain(id("beta"));
  expect(prompt).toContain("Do not copy the native severity list alone");
  await harness.writeIntentCheckpoint();
  const checkpointPath = join(ARTIFACTS_DIR, "intent_checkpoint.json");
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  checkpoint.filters = { severity: ["high"] };
  await writeFile(checkpointPath, JSON.stringify(checkpoint));
  const first = await decideNextStep({ root: REPO_DIR, input: sourcePath() });
  if (first.step_kind === "collect_review_approval") {
    await writeFile(join(ARTIFACTS_DIR, "review_resolution.json"), "{}");
    await decideNextStep({ root: REPO_DIR, input: sourcePath() });
  }
  const filter = JSON.parse(await readFile(join(ARTIFACTS_DIR, "review_filter_dispositions.json"), "utf8"));
  expect(filter.droppedNoEvidence).toEqual([]);
  expect(report.findings.find(finding => finding.id === id("alpha"))?.evidence).toEqual([
    "src/alpha.ts:1-1: The declared path does not meet the contract.",
  ]);
  expect(filter.droppedByCheckpoint).toContain(id("beta"));
});


test("source drift while intake synthesis is in flight preserves the earlier selected report", async () => {
  expect(cli("--severity", "high").status).toBe(0);
  const selectedPath = join(ARTIFACTS_DIR, "intake", "selected-audit-findings.json");
  const before = await readFile(selectedPath, "utf8");
  await writeFile(sourcePath(), JSON.stringify(report) + "\n");
  const step = await decideNextStep({ root: REPO_DIR });
  expect(step.step_kind).toBe("input_conflict");
  expect(await readFile(selectedPath, "utf8")).toBe(before);
  expect(await readFile(step.prompt_path, "utf8")).toContain("A bare resume cannot accept changed source evidence");
});
