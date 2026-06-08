import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureConsole } from "./helpers/captureConsole.mjs";

const { runCli } = await import("../src/cli.ts");
const {
  normalizeExistingFindingsReport,
  AUDIT_FINDINGS_CONTRACT_VERSION,
} = await import("../src/reporting/synthesis.ts");

function makeReport(overrides = {}) {
  return {
    contract_version: "audit-tools/audit-findings/v0",
    summary: {
      finding_count: 99,
      work_block_count: 99,
      severity_breakdown: { high: 99 },
      lens_breakdown: { security: 99 },
      audited_file_count: 7,
      excluded_file_count: 2,
      runtime_validation_status_breakdown: { pass: 1 },
    },
    findings: [
      {
        id: "F-001",
        title: "Injection risk",
        category: "security",
        severity: "high",
        confidence: "high",
        lens: "security",
        summary: "User input is unsanitized.",
        affected_files: [{ path: "src/api.ts" }],
        evidence: ["line 42"],
      },
      {
        id: "F-002",
        title: "Missing test",
        category: "tests",
        severity: "medium",
        confidence: "medium",
        lens: "tests",
        summary: "No tests for core path.",
        affected_files: [{ path: "src/core.ts" }],
        evidence: [],
      },
    ],
    work_blocks: [
      {
        block_id: "B-001",
        finding_ids: ["F-001", "F-002"],
        unit_ids: [],
        owned_files: [],
        depends_on: [],
        max_severity: "high",
        rationale: "security",
      },
    ],
    ...overrides,
  };
}

async function withTempRoot(fn) {
  const tempRoot = await mkdtemp(join(tmpdir(), "resynthesize-test-"));
  try {
    return await fn(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runResynthesize(argv) {
  const result = await captureConsole(() => runCli(argv));
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
}

// ── normalizeExistingFindingsReport ───────────────────────────────────────────

test("normalizeExistingFindingsReport recomputes summary counts and stamps current contract version", () => {
  const report = makeReport();
  const normalized = normalizeExistingFindingsReport(report);

  assert.equal(normalized.contract_version, AUDIT_FINDINGS_CONTRACT_VERSION);
  assert.equal(normalized.summary.finding_count, 2);
  assert.equal(normalized.summary.work_block_count, 1);
  assert.deepEqual(normalized.summary.severity_breakdown, { high: 1, medium: 1 });
  assert.deepEqual(normalized.summary.lens_breakdown, { security: 1, tests: 1 });
});

test("normalizeExistingFindingsReport preserves findings, work_blocks, and narrative fields unchanged", () => {
  const narrative = {
    themes: [{ theme_id: "T-001", title: "Input safety", root_cause: "No sanitization", finding_ids: ["F-001"] }],
    executive_summary: "Fix injection risks first.",
    top_risks: ["unsanitized user input"],
  };
  const report = makeReport(narrative);
  const normalized = normalizeExistingFindingsReport(report);

  assert.deepEqual(normalized.findings, report.findings);
  assert.deepEqual(normalized.work_blocks, report.work_blocks);
  assert.deepEqual(normalized.themes, narrative.themes);
  assert.equal(normalized.executive_summary, narrative.executive_summary);
  assert.deepEqual(normalized.top_risks, narrative.top_risks);
});

test("normalizeExistingFindingsReport preserves non-reconstructable upstream summary fields", () => {
  const report = makeReport();
  const normalized = normalizeExistingFindingsReport(report);

  assert.equal(normalized.summary.audited_file_count, 7);
  assert.equal(normalized.summary.excluded_file_count, 2);
  assert.deepEqual(
    normalized.summary.runtime_validation_status_breakdown,
    { pass: 1 },
  );
});

test("normalizeExistingFindingsReport is deterministic: calling twice yields the same result", () => {
  const report = makeReport();
  const first = normalizeExistingFindingsReport(report);
  const second = normalizeExistingFindingsReport(first);
  assert.deepEqual(first, second);
});

// ── resynthesize CLI command ──────────────────────────────────────────────────

test("resynthesize rewrites audit-findings.json and audit-report.md from promoted findings", async () => {
  await withTempRoot(async (root) => {
    const auditToolsDir = join(root, ".audit-tools");
    await mkdir(auditToolsDir, { recursive: true });

    const inputPath = join(auditToolsDir, "audit-findings.json");
    await writeFile(inputPath, JSON.stringify(makeReport(), null, 2), "utf8");

    const argv = [process.execPath, "cli.ts", "resynthesize", "--root", root];
    const { stdout, stderr, exitCode } = await runResynthesize(argv);

    assert.equal(exitCode, 0, `Unexpected exit code. stderr: ${stderr}`);

    const outputJson = JSON.parse(
      await readFile(join(auditToolsDir, "audit-findings.json"), "utf8"),
    );
    assert.equal(outputJson.contract_version, AUDIT_FINDINGS_CONTRACT_VERSION);
    assert.equal(outputJson.summary.finding_count, 2);
    assert.equal(outputJson.summary.work_block_count, 1);

    assert.ok(
      existsSync(join(auditToolsDir, "audit-report.md")),
      "audit-report.md should be written",
    );

    const parsed = JSON.parse(stdout);
    assert.ok("findings_output" in parsed, "stdout JSON should include findings_output");
    assert.ok("report_output" in parsed, "stdout JSON should include report_output");
    assert.equal(parsed.finding_count, 2);
    assert.equal(parsed.contract_version, AUDIT_FINDINGS_CONTRACT_VERSION);
  });
});

test("resynthesize does not require the .audit-tools/audit working directory", async () => {
  await withTempRoot(async (root) => {
    const auditToolsDir = join(root, ".audit-tools");
    await mkdir(auditToolsDir, { recursive: true });
    // Only the promoted findings file — no audit/ subdirectory.
    await writeFile(
      join(auditToolsDir, "audit-findings.json"),
      JSON.stringify(makeReport(), null, 2),
      "utf8",
    );

    const argv = [process.execPath, "cli.ts", "resynthesize", "--root", root];
    const { exitCode, stderr } = await runResynthesize(argv);
    assert.equal(exitCode, 0, `Unexpected exit code. stderr: ${stderr}`);
    assert.ok(!existsSync(join(root, ".audit-tools", "audit")), ".audit-tools/audit should not be created");
  });
});

test("resynthesize exits with code 1 and names the missing file when audit-findings.json is absent", async () => {
  await withTempRoot(async (root) => {
    const argv = [process.execPath, "cli.ts", "resynthesize", "--root", root];
    const { exitCode, stderr } = await runResynthesize(argv);

    assert.equal(exitCode, 1, "Should exit 1 when audit-findings.json is missing");
    assert.ok(
      stderr.includes("audit-findings.json"),
      `stderr should name the missing file, got: ${stderr}`,
    );
  });
});
