import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
import { buildQuestionAuditReportFixture } from "./helpers/questionAuditReportFixture.js";
import { intakeSummaryFixture } from "./helpers/intakeSummaryFixture.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { readPlanSource } from "../../src/remediate/contractPipeline/executionPlan.js";
import { intakePaths, type IntakeSourceManifest } from "../../src/remediate/intake.js";
import type { AuditFindingsReport } from "audit-tools/shared";

const harness = createNextStepHarness(".test-intake-mixed-audit-provenance");
const { REPO_DIR, ARTIFACTS_DIR } = harness;
const paths = intakePaths(ARTIFACTS_DIR);
const inputPath = join(REPO_DIR, "audit-findings.json");
const guidancePath = join(REPO_DIR, "guidance.md");
let report: AuditFindingsReport;
let archived: AuditFindingsReport;
let guidance: string;

beforeEach(async () => {
  await harness.resetTestRepo();
  // Keep the actual frozen report for archival refusal. For current intake,
  // rebuild synthetic question answers from its claims using the live producer.
  archived = JSON.parse(await readFile(new URL("./fixtures/audit-findings-real-mixed.json", import.meta.url), "utf8"));
  report = buildQuestionAuditReportFixture(
    archived.findings.map(finding => ({ ...finding, lens: "behavior" })),
    archived.audit_read,
  ).report;
  guidance = await readFile(new URL("./fixtures/audit-guidance-real-mixed.md", import.meta.url), "utf8");
  await writeFile(inputPath, JSON.stringify(report));
  await writeFile(guidancePath, guidance);
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  await writeFile(join(REPO_DIR, "src/discount.mjs"), "export function discountedTotal(subtotalCents, discountCents) {\n  return Math.max(0, subtotalCents + discountCents);\n}\n");
});
afterEach(async () => { await harness.cleanupTestRepo(); });

function cli(...flags: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx/esm", resolve("src/remediate/index.ts"), "next-step", "--root", REPO_DIR, ...flags], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30000,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.test.json") },
  });
}

async function readyMixedIntake(declinedFindingId?: string) {
  await writeFile(paths.summary, JSON.stringify(intakeSummaryFixture({
    source_type: "mixed", affected_files: [{ path: "src/discount.mjs" }],
    constraints: ["Keep the zero floor and change only src/discount.mjs."],
    ...(declinedFindingId ? { source_summary: "DECLINED-CLAIM: replace the discount formula with a lookup table." } : {}),
  })));
  await harness.writeIntentCheckpoint();
  let step = await decideNextStep({ root: REPO_DIR });
  if (declinedFindingId) expect(step.step_kind).toBe("collect_review_approval");
  if (step.step_kind === "collect_review_approval") {
    if (declinedFindingId) {
      await writeFile(join(ARTIFACTS_DIR, "review_resolution.json"), JSON.stringify({
        declined_findings: [{ finding_id: declinedFindingId, reason: "Outside this test's approved subset." }],
      }));
    } else await harness.approveReviewGate();
    step = await decideNextStep({ root: REPO_DIR });
  }
  expect(step.step_kind).toBe("contract_pipeline");
  return step;
}

test.each([
  ["v1alpha1", false], ["v1alpha1", true], ["v1alpha2", false], ["v1alpha2", true],
] as const)("public intake refuses a retired %s audit report with guidance=%s", async (version, withGuidance) => {
  await writeFile(inputPath, JSON.stringify(version === "v1alpha2" ? archived : { schema_version: "audit-findings/v1alpha1", findings: [] }));
  const result = cli("--input", inputPath, ...(withGuidance ? ["--guidance-file", guidancePath] : []));
  expect(result.status, result.stderr).toBe(0);
  const step = JSON.parse(result.stdout);
  expect(step.step_kind).toBe("collect_starting_point");
  expect(step.stop_condition).toContain(inputPath);
  expect(step.stop_condition).toMatch(/regenerate.*audit-tools\/audit-findings\/v2/i);
});

for (const selected of [false, true]) {
  test(`public mixed intake retains audit provenance and separate guidance${selected ? " with a finding selection" : ""}`, async () => {
    const result = cli("--input", inputPath, "--guidance-file", guidancePath, ...(selected ? ["--severity", "high"] : []));
    expect(result.status, result.stderr).toBe(0);
    const manifest: IntakeSourceManifest = JSON.parse(await readFile(paths.sourceManifest, "utf8"));
    expect(manifest.created_from).toBe("mixed");
    expect(manifest.sources.map(source => source.type)).toEqual(["structured_audit", "conversation"]);
    const step = await readyMixedIntake();
    const source = (await readPlanSource(ARTIFACTS_DIR))!;
    const expected = selected ? report.findings.filter(finding => finding.severity === "high") : report.findings;
    expect(source.findings).toEqual(expected);
    expect(source.audit_read).toEqual(report.audit_read);
    expect(source.request?.text).toContain(guidance.trim());
    expect(source.request?.text).not.toContain(report.contract_version);
    expect(source.request?.source_paths).toEqual([paths.conversationStart]);
    expect(source.request?.source_paths).not.toContain(inputPath);
    expect(source.sources.map(entry => entry.path)).toContain(paths.conversationStart);
    const prompt = await readFile(step.prompt_path, "utf8");
    for (const finding of expected) expect(prompt).toContain(finding.id);
    expect(JSON.parse(await readFile(inputPath, "utf8"))).toEqual(report);
    // Guidance remains part of the immutable source binding on a bare resume.
    await writeFile(paths.conversationStart, guidance + "\nA changed instruction.\n");
    const resumed = await decideNextStep({ root: REPO_DIR });
    expect(resumed.status).toBe("blocked");
    expect(await readFile(resumed.prompt_path, "utf8")).toContain("changed or disappeared");
  });
}

test("mixed review decline keeps guidance bound without restoring the original audit source", async () => {
  const result = cli("--input", inputPath, "--guidance-file", guidancePath);
  expect(result.status, result.stderr).toBe(0);
  const declinedId = report.findings.find(finding => finding.severity === "high")!.id;
  await readyMixedIntake(declinedId);
  const source = (await readPlanSource(ARTIFACTS_DIR))!;
  expect(source.findings).toEqual(report.findings.filter(finding => finding.id !== declinedId));
  expect(source.audit_read).toEqual(report.audit_read);
  expect(source.request?.text).toContain(guidance.trim());
  expect(source.request?.text).not.toContain(report.contract_version);
  expect(source.request?.text).not.toContain("DECLINED-CLAIM");
  expect(source.sources.map(entry => entry.path)).toEqual(expect.arrayContaining([
    paths.conversationStart, join(paths.dir, "plan/approved-findings.json"),
  ]));
  expect(source.sources.map(entry => entry.path)).not.toContain(inputPath);
  expect(source.sources.map(entry => entry.path)).not.toContain(paths.brief);
});

test("plain guidance stays a request without importing a stale default audit", async () => {
  await writeFile(join(REPO_DIR, ".audit-tools/audit-findings.json"), JSON.stringify(report));
  const result = cli("--guidance-file", guidancePath);
  expect(result.status, result.stderr).toBe(0);
  const manifest: IntakeSourceManifest = JSON.parse(await readFile(paths.sourceManifest, "utf8"));
  expect(manifest.sources.map(source => source.type)).toEqual(["conversation"]);
  await readyMixedIntake();
  const source = (await readPlanSource(ARTIFACTS_DIR))!;
  expect(source.findings).toEqual([]);
  expect(source.audit_read).toBeNull();
  expect(source.request?.text).toContain(guidance.trim());
});

test("malformed JSON with guidance stays a document instead of acquiring audit provenance", async () => {
  await writeFile(inputPath, '{"findings": [');
  const result = cli("--input", inputPath, "--guidance-file", guidancePath);
  expect(result.status, result.stderr).toBe(0);
  const manifest: IntakeSourceManifest = JSON.parse(await readFile(paths.sourceManifest, "utf8"));
  expect(manifest.sources.map(source => source.type)).toEqual(["document", "conversation"]);
});
