import { test, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureConsole } from "./helpers/captureConsole.mjs";
import type { AuditFindingsReport } from "audit-tools/shared";
import { buildQuestionAuditFindingsReport } from "../../src/audit/reporting/questionReport.js";
import {
  FINDINGS_DRAW_COHERENCE_POLICY,
  buildContentCoherenceTrace,
} from "../../src/shared/decompose/contentCoherence.js";

const { runCli } = await import("../../src/audit/cli.js");
const {
  normalizeExistingFindingsReport,
  AUDIT_FINDINGS_CONTRACT_VERSION,
} = await import("../../src/audit/reporting/synthesis.js");

function makeReport(overrides: Partial<AuditFindingsReport> = {}): AuditFindingsReport {
  const findings: AuditFindingsReport["findings"] = [
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
  ];
  return {
    contract_version: "audit-tools/audit-findings/v0",
    audit_read: null,
    summary: {
      finding_count: 99,
      work_block_count: 99,
      severity_breakdown: { high: 99 },
      lens_breakdown: { security: 99 },
      audited_file_count: 7,
      excluded_file_count: 2,
      runtime_validation_status_breakdown: { pass: 1 },
    },
    findings,
    coherence_trace: buildContentCoherenceTrace(
      {
        items: findings.map((finding) => ({
          id: finding.id,
          file_paths: finding.affected_files.map((file) => file.path),
          unit_ids: ["unit-core"],
          tags: [finding.lens],
        })),
      },
      FINDINGS_DRAW_COHERENCE_POLICY,
    ),
    work_block_seams: [],
    work_blocks: [
      {
        id: "B-001",
        finding_ids: ["F-001", "F-002"],
        unit_ids: ["unit-core"],
        owned_files: ["src/api.ts", "src/core.ts"],
        role: "implementation",
        depends_on: [],
        max_severity: "high",
        rationale: "security",
        token_estimate: 2_100,
      },
    ],
    ...overrides,
  };
}

async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const tempRoot = await mkdtemp(join(tmpdir(), "resynthesize-test-"));
  try {
    return await fn(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runResynthesize(argv: string[]) {
  const result = await captureConsole(() => runCli(argv));
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
}

// ── normalizeExistingFindingsReport ───────────────────────────────────────────

test("normalizeExistingFindingsReport recomputes summary counts and stamps current contract version", () => {
  const report = makeReport();
  const normalized = normalizeExistingFindingsReport(report);

  expect(normalized.contract_version).toBe(AUDIT_FINDINGS_CONTRACT_VERSION);
  expect(normalized.summary.finding_count).toBe(2);
  expect(normalized.summary.work_block_count).toBe(1);
  expect(normalized.summary.severity_breakdown).toEqual({ high: 1, medium: 1 });
  expect(normalized.summary.lens_breakdown).toEqual({ security: 1, tests: 1 });
});

test("normalizeExistingFindingsReport preserves findings, work_blocks, and narrative fields unchanged", () => {
  const narrative: Partial<AuditFindingsReport> = {
    themes: [
      {
        theme_id: "T-001",
        title: "Input safety",
        root_cause: "No sanitization",
        finding_ids: ["F-001"],
        suggested_fix_pattern: "Validate and sanitize all user input at the boundary.",
      },
    ],
    executive_summary: "Fix injection risks first.",
    top_risks: ["unsanitized user input"],
  };
  const report = makeReport(narrative);
  const normalized = normalizeExistingFindingsReport(report);

  expect(normalized.findings).toEqual(report.findings);
  expect(normalized.work_blocks).toEqual(report.work_blocks);
  expect(normalized.themes).toEqual(narrative.themes);
  expect(normalized.executive_summary).toBe(narrative.executive_summary);
  expect(normalized.top_risks).toEqual(narrative.top_risks);
});

test("normalizeExistingFindingsReport preserves non-reconstructable upstream summary fields", () => {
  const report = makeReport();
  const normalized = normalizeExistingFindingsReport(report);

  expect(normalized.summary.audited_file_count).toBe(7);
  expect(normalized.summary.excluded_file_count).toBe(2);
  expect(normalized.summary.runtime_validation_status_breakdown).toEqual({ pass: 1 });
});

test("normalizeExistingFindingsReport is deterministic: calling twice yields the same result", () => {
  const report = makeReport();
  const first = normalizeExistingFindingsReport(report);
  const second = normalizeExistingFindingsReport(first);
  expect(first).toEqual(second);
});

// ── resynthesize CLI command ──────────────────────────────────────────────────

const makePlan = (snapshot_id = "current") => ({
  schema_version: "audit-tools/question-review/v1" as const, snapshot_id,
  questions: [], inventory: [], omissions: [], lens_decisions: [],
});
const currentReport = (plan = makePlan()) => buildQuestionAuditFindingsReport({
  plan, accepted: [], evidence: [], auditRead: null, dependenciesByQuestion: new Map(),
});

test("resynthesize refuses the archived default without rewriting its output pair", async () => {
  await withTempRoot(async (root) => {
    const auditToolsDir = join(root, ".audit-tools");
    await mkdir(auditToolsDir, { recursive: true });

    const inputPath = join(auditToolsDir, "audit-findings.json");
    const archived = JSON.stringify(makeReport(), null, 2);
    const markdown = join(auditToolsDir, "audit-report.md");
    await writeFile(inputPath, archived, "utf8");
    await writeFile(markdown, "archived report\n");

    const argv = [process.execPath, "cli.ts", "resynthesize", "--root", root];
    const { stdout, stderr, exitCode } = await runResynthesize(argv);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Archived reports are left unchanged");
    expect(stdout).toBe("");
    expect(await readFile(inputPath, "utf8")).toBe(archived);
    expect(await readFile(markdown, "utf8")).toBe("archived report\n");
  });
});

test("resynthesize preserves the promoted v2 pair after rollover removes its working plan", async () => {
  await withTempRoot(async (root) => {
    const auditToolsDir = join(root, ".audit-tools");
    await mkdir(auditToolsDir, { recursive: true });
    const bytes = JSON.stringify(currentReport(), null, 2) + "\n";
    const promoted = join(auditToolsDir, "audit-findings.json");
    const markdown = join(auditToolsDir, "audit-report.md");
    const preserved = "# Audit Report\n\n## Process Feedback\n\nOriginal run feedback.\n\n### Charter evidence coverage\n\n71 of 72 delivered.\n";
    await writeFile(promoted, bytes, "utf8");
    await writeFile(markdown, preserved, "utf8");
    await writeFile(join(auditToolsDir, "audit-agent-feedback.jsonl"), "A historical sidecar is not bound to this report.");
    const argv = [process.execPath, "cli.ts", "resynthesize", "--root", root];
    const { exitCode, stderr, stdout } = await runResynthesize(argv);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("No current review_plan.json owns the promoted report");
    expect(stdout).toBe("");
    expect(await readFile(promoted, "utf8")).toBe(bytes);
    expect(await readFile(markdown, "utf8")).toBe(preserved);
    // The artifact lock may create the directory; no work artifacts were written.
    expect(await readdir(join(auditToolsDir, "audit"))).toEqual([]);
  });
});

test.each(["archived", "same-version other run", "stale active run"] as const)(
  "resynthesize refuses %s without changing the current or explicit pair", async (mode) => {
    await withTempRoot(async root => {
      const dir = join(root, ".audit-tools");
      const active = join(dir, "audit");
      await mkdir(active, { recursive: true });
      const promoted = join(dir, "audit-findings.json");
      const markdown = join(dir, "audit-report.md");
      const explicit = join(root, "another-findings.json");
      const bytes = JSON.stringify(currentReport());
      const other = JSON.stringify(mode === "archived" ? makeReport() : currentReport(makePlan("other")));
      await writeFile(promoted, bytes);
      await writeFile(markdown, "current markdown");
      await writeFile(explicit, other);
      await writeFile(join(active, "review_plan.json"), JSON.stringify(makePlan(mode === "stale active run" ? "other" : "current")));
      await writeFile(join(active, "audit-findings.json"), mode === "stale active run" ? other : bytes);
      const argv = [process.execPath, "cli.ts", "resynthesize", "--root", root,
        ...(mode === "stale active run" ? [] : ["--input", explicit])];
      expect((await runResynthesize(argv)).exitCode).toBe(1);
      expect(await readFile(promoted, "utf8")).toBe(bytes);
      expect(await readFile(markdown, "utf8")).toBe("current markdown");
      expect(await readFile(explicit, "utf8")).toBe(other);
    });
  },
);

test("resynthesize permits an exact explicit copy of the active owned report", async () => {
  await withTempRoot(async root => {
    const dir = join(root, ".audit-tools");
    const active = join(dir, "audit");
    await mkdir(active, { recursive: true });
    const plan = makePlan();
    const report = currentReport(plan);
    const bytes = JSON.stringify(report);
    const promoted = join(dir, "audit-findings.json");
    const copy = join(root, "copy.json");
    await writeFile(promoted, bytes);
    await writeFile(copy, bytes);
    await writeFile(join(active, "review_plan.json"), JSON.stringify(plan));
    await writeFile(join(active, "audit-findings.json"), JSON.stringify(report, null, 2) + "\n");
    await writeFile(join(active, "agent-feedback.jsonl"), "not this audit's evidence");
    const result = await runResynthesize([process.execPath, "cli.ts", "resynthesize", "--root", root, "--input", copy]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await readFile(promoted, "utf8")).toBe(bytes);
    expect(await readFile(copy, "utf8")).toBe(bytes);
    const markdown = await readFile(join(dir, "audit-report.md"), "utf8");
    expect(markdown).toContain("Snapshot: current");
    expect(markdown).not.toContain("not this audit's evidence");
  });
});

test("resynthesize refreshes only the selected artifact tree's promoted Markdown", async () => {
  await withTempRoot(async root => {
    const defaultDir = join(root, ".audit-tools");
    const selectedDir = join(root, "selected-output");
    const active = join(selectedDir, "review");
    await mkdir(defaultDir);
    await mkdir(active, { recursive: true });
    const defaultMarkdown = join(defaultDir, "audit-report.md");
    const selectedMarkdown = join(selectedDir, "audit-report.md");
    const selectedFindings = join(selectedDir, "audit-findings.json");
    const workingFindings = join(active, "audit-findings.json");
    const plan = makePlan("selected");
    const bytes = JSON.stringify(currentReport(plan));
    await writeFile(defaultMarkdown, "default report");
    await writeFile(selectedMarkdown, "previous selected report");
    await writeFile(selectedFindings, bytes);
    await writeFile(workingFindings, bytes);
    await writeFile(join(active, "review_plan.json"), JSON.stringify(plan));

    const result = await runResynthesize([
      process.execPath, "cli.ts", "resynthesize", "--root", root, "--artifacts-dir", active,
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      source: selectedFindings, findings_output: selectedFindings, report_output: selectedMarkdown,
    });
    expect(await readFile(selectedMarkdown, "utf8")).toContain("Snapshot: selected");
    expect(await readFile(defaultMarkdown, "utf8")).toBe("default report");
    expect(await readFile(selectedFindings, "utf8")).toBe(bytes);
    expect(await readFile(workingFindings, "utf8")).toBe(bytes);
  });
});

test("resynthesize refuses a dangling --input rather than silently choosing a default", async () => {
  await withTempRoot(async (root) => {
    const auditToolsDir = join(root, ".audit-tools");
    await mkdir(auditToolsDir, { recursive: true });
    await writeFile(
      join(auditToolsDir, "audit-findings.json"),
      JSON.stringify(makeReport(), null, 2),
      "utf8",
    );

    // `--input` with no value, immediately followed by `--root`, must NOT
    // resolve the input path to the literal "--root" or silently substitute a default.
    // The explicit argument contract refuses it before loading any report.
    const argv = [process.execPath, "cli.ts", "resynthesize", "--input", "--root", root];
    const { stdout, exitCode, stderr } = await runResynthesize(argv);

    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/--input requires a value/);
    expect(stdout).toBe("");
  });
});

test("resynthesize exits with code 1 and names the missing file when audit-findings.json is absent", async () => {
  await withTempRoot(async (root) => {
    const argv = [process.execPath, "cli.ts", "resynthesize", "--root", root];
    const { exitCode, stderr } = await runResynthesize(argv);

    expect(exitCode, "Should exit 1 when audit-findings.json is missing").toBe(1);
    expect(stderr.includes("audit-findings.json"), `stderr should name the missing file, got: ${stderr}`).toBeTruthy();
  });
});
