import { beforeEach, afterEach, expect, test } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildAuditFindingsReport, buildAuditReportModel } from "../../src/audit/reporting/synthesis.js";
import type { AuditFindingsReport } from "audit-tools/shared";
import { createNextStepHarness, makePlanningState } from "./helpers/nextStepHarness.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";

const harness = createNextStepHarness(".test-intake-finding-selection");
const { REPO_DIR, ARTIFACTS_DIR } = harness;
const sourcePath = (): string => join(REPO_DIR, "audit-findings.json");
let report: AuditFindingsReport;

beforeEach(async () => {
  await harness.resetTestRepo();
  await writeFile(join(REPO_DIR, "package.json"), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  for (const file of ["alpha", "beta", "gamma"]) await writeFile(join(REPO_DIR, "src", `${file}.ts`), `export const ${file} = 1;\n`);
  report = buildAuditFindingsReport(buildAuditReportModel({ results: [{
    task_id: "task", unit_id: "unit", pass_id: "pass", lens: "correctness", file_coverage: [],
    findings: ["alpha", "beta", "gamma"].map((name, index) => ({
      id: name, title: `${name} unique failure`, category: name, lens: index === 1 ? "security" : "correctness",
      severity: index === 0 ? "high" as const : "low" as const, confidence: "high" as const,
      summary: `${name} requires repair`, affected_files: [{ path: `src/${name}.ts`, line_start: 1, line_end: 1 }],
      evidence: [`export const ${name} = 1;`],
    })),
  }] }), null);
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
async function projected(): Promise<AuditFindingsReport> {
  return JSON.parse(await readFile(join(ARTIFACTS_DIR, "intake", "selected-audit-findings.json"), "utf8"));
}

function id(name: string): string { return report.findings.find((finding) => finding.category === name)!.id; }

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
  expect(await readFile(sourcePath(), "utf8")).toBe(before);
  const resumed = await decideNextStep({ root: REPO_DIR, input: sourcePath() });
  expect(resumed.step_kind).toBe("synthesize_intake");
  expect((await projected()).findings.map((finding) => finding.id)).toEqual(selected.findings.map((finding) => finding.id));
}, 40000);

test("unknown IDs refuse even when severity would select valid findings", () => {
  const result = cli("--severity", "high", "--finding-id", "UNKNOWN-ID");
  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toMatch(/unknown.*finding|finding.*unknown/i);
}, 40000);

test("an empty validated selection produces explicit no-work before synthesis", async () => {
  const result = cli("--severity", "critical");
  expect(result.status, result.stderr).toBe(0);
  const step = JSON.parse(await readFile(join(ARTIFACTS_DIR, "steps", "current-step.json"), "utf8"));
  expect(step.step_kind).toBe("zero_documentable_findings");
  expect(step.status).toBe("complete");
  expect((await projected()).findings).toEqual([]);
}, 40000);

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
  expect(filter.droppedByCheckpoint).toContain(id("beta"));
  expect(filter.originals.map((finding: { id: string }) => finding.id).sort()).toEqual([id("alpha"), id("beta")].sort());
}, 40000);


for (const change of ["selectors", "source"] as const) {
  test(`${change} drift conflicts with an active selection without overwriting it`, async () => {
    expect(cli("--severity", "high").status).toBe(0);
    await harness.saveState(makePlanningState());
    const before = await readFile(join(ARTIFACTS_DIR, "intake", "selected-audit-findings.json"), "utf8");
    if (change === "source") await writeFile(sourcePath(), JSON.stringify(report) + "\n");
    const step = await decideNextStep({ root: REPO_DIR, ...(change === "selectors" ? { severity: ["low"] } : {}) });
    expect(step.step_kind).toBe("input_conflict");
    expect(await readFile(join(ARTIFACTS_DIR, "intake", "selected-audit-findings.json"), "utf8")).toBe(before);
  }, 40000);
}

test("unknown severities refuse even alongside a valid explicit finding", () => {
  const result = cli("--severity", "urgent", "--finding-id", id("alpha"));
  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toMatch(/severity|enum/i);
}, 40000);

test("selecting every finding preserves original narrative", async () => {
  const result = cli("--severity", "high", "--severity", "low");
  expect(result.status, result.stderr).toBe(0);
  const selected = await projected();
  expect(selected.top_risks).toEqual(report.top_risks);
  expect(selected.executive_summary).toEqual(report.executive_summary);
}, 40000);


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
  expect(filter.droppedByCheckpoint).toContain(id("beta"));
}, 40000);


test("source drift while intake synthesis is in flight preserves the earlier selected report", async () => {
  expect(cli("--severity", "high").status).toBe(0);
  const selectedPath = join(ARTIFACTS_DIR, "intake", "selected-audit-findings.json");
  const before = await readFile(selectedPath, "utf8");
  await writeFile(sourcePath(), JSON.stringify(report) + "\n");
  const step = await decideNextStep({ root: REPO_DIR });
  expect(step.step_kind).toBe("input_conflict");
  expect(await readFile(selectedPath, "utf8")).toBe(before);
  expect(await readFile(step.prompt_path, "utf8")).toContain("A bare resume cannot accept changed source evidence");
}, 40000);
