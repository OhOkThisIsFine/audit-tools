import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { createNextStepHarness } from "./helpers/nextStepHarness.js";
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
let guidance: string;

beforeEach(async () => {
  await harness.resetTestRepo();
  // Frozen outputs from the 2026-10-19 public audit/remediation exercise. The
  // original fixture stays read-only; all CLI writes land in this test's repo.
  report = JSON.parse(await readFile(new URL("./fixtures/audit-findings-real-mixed.json", import.meta.url), "utf8"));
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
  }, 40000);
}

test("mixed review decline keeps guidance bound without restoring the original audit source", async () => {
  const result = cli("--input", inputPath, "--guidance-file", guidancePath);
  expect(result.status, result.stderr).toBe(0);
  const declinedId = report.findings[0]!.id;
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
