import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runClosePhase, collectStagingFiles } from "../src/phases/close.js";
import { readFile, rm, mkdir, writeFile as writeFileAsync } from "node:fs/promises";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { RunLogger } from "@audit-tools/shared";
import type { RemediationState } from "../src/state/store.js";
import { makeState as makeBaseState } from "./test-helpers.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-close");
const REPO_DIR = join(__dirname, ".test-close-repo");

const BASE_OPTIONS = { root: REPO_DIR, artifactsDir: TEST_DIR };

function makeState(overrides: Record<string, unknown> = {}): RemediationState {
  return makeBaseState({
    status: "closing",
    plan: {
      plan_id: "P1",
      findings: [],
      blocks: [],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    closing_plan: { action: "none" },
    ...overrides,
  });
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await rm(REPO_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  await mkdir(REPO_DIR, { recursive: true });
  // REPO_DIR lives inside the audit-tools working tree, so an un-init'd dir would
  // make git traverse up to the parent repo and report its (many) uncommitted
  // files — corrupting collectStagingFiles. Initialize an isolated, clean repo so
  // the no-files-to-stage cases genuinely see an empty staging set.
  execSync("git init", { cwd: REPO_DIR });
  execSync("git config user.email test@test.com", { cwd: REPO_DIR });
  execSync("git config user.name Test", { cwd: REPO_DIR });
  writeFileSync(join(REPO_DIR, "initial.txt"), "hello");
  execSync("git add . && git commit -m init", { cwd: REPO_DIR });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await rm(REPO_DIR, { recursive: true, force: true });
});

describe("runClosePhase", () => {
  it("throws when plan is missing", async () => {
    const state: RemediationState = { status: "closing" };
    await expect(runClosePhase(state, BASE_OPTIONS)).rejects.toThrow(
      /missing plan/,
    );
  });

  it("returns complete status and writes report files", async () => {
    const state = makeState({
      items: {
        F1: {
          finding_id: "F1",
          status: "resolved",
          block_id: "B1",
          last_successful_step: "Verify Code Against Documentation",
        },
      },
    });

    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");

    const { existsSync } = await import("node:fs");
    expect(existsSync(join(REPO_DIR, "remediation-report.md"))).toBe(true);
  });

  it("writes run metadata, structured verification evidence, and vacuous combined test details", async () => {
    const startedAt = "2026-06-05T12:00:00.000Z";
    const state = makeState({
      started_at: startedAt,
      step_count: 7,
      plan: {
        plan_id: "P1",
        findings: [
          {
            id: "F1",
            title: "Finding One",
            category: "correctness",
            severity: "high",
            confidence: "high",
            lens: "correctness",
            summary: "",
            affected_files: [{ path: "src/a.ts" }],
          },
        ],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      } as any,
      items: {
        F1: {
          finding_id: "F1",
          status: "resolved",
          block_id: "B1",
          last_successful_step: "Verify Code Against Documentation",
        },
      },
    });
    await writeFileAsync(
      join(TEST_DIR, "result_F1_verify_code_against_documentation.json"),
      JSON.stringify({
        finding_id: "F1",
        passed: true,
        reason: ["check A", "check B"],
      }),
    );

    await runClosePhase(state, BASE_OPTIONS);

    const jsonReport = JSON.parse(
      await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
    );
    expect(jsonReport.started_at).toBe(startedAt);
    expect(Date.parse(jsonReport.ended_at)).not.toBeNaN();
    expect(new Date(jsonReport.ended_at).getTime()).toBeGreaterThanOrEqual(
      new Date(startedAt).getTime(),
    );
    expect(jsonReport.step_count).toBe(7);
    expect(jsonReport.resolved[0].verification_evidence).toEqual([
      "check A",
      "check B",
    ]);
    expect(jsonReport.combined_test_result).toEqual({
      passed: true,
      duration_ms: 0,
    });

    const markdown = await readFile(join(REPO_DIR, "remediation-report.md"), "utf8");
    expect(markdown).toContain("  - *Verification*: check A");
    expect(markdown).toContain("  - *Verification*: check B");
    expect(markdown).not.toContain("check A\ncheck B");
  });

  it("transitions to triage when test_command fails", async () => {
    const state = makeState({
      plan: {
        plan_id: "P1",
        findings: [],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
        test_command: 'node -e "process.exit(1)"',
      },
      items: {
        F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
      },
    });

    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("triage");
    expect(state.items!.F1.status).toBe("blocked");
  });

  it("preserves quoted arguments in test_command", async () => {
    const state = makeState({
      plan: {
        plan_id: "P1",
        findings: [],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
        test_command:
          'node -e "if (process.argv[1] !== \'hello world\') process.exit(1)" "hello world"',
      },
      items: {
        F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
      },
    });

    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");

    const jsonReport = JSON.parse(
      await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
    );
    expect(jsonReport.combined_test_result.passed).toBe(true);
    expect(jsonReport.combined_test_result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(jsonReport.combined_test_result.suite_name).toBe(
      state.plan!.test_command,
    );
    expect(jsonReport.combined_test_result.failure_summary).toBeUndefined();
  });

  it("emits a run-log line per outcome plus an artifact-write line", async () => {
    const state = makeState({
      plan: {
        plan_id: "P1",
        findings: [
          {
            id: "F1",
            title: "Finding 1",
            category: "security",
            severity: "low",
            confidence: "low",
            lens: "security",
            summary: "",
            affected_files: [{ path: "src/a.ts" }],
          },
        ],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
      } as any,
      items: {
        F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
      },
    });

    // Log outside the artifacts dir: runClosePhase deletes artifactsDir on
    // completion (the run-log normally lives there and is ephemeral by design),
    // so we assert emission via a path that survives cleanup.
    const logPath = join(REPO_DIR, "run.log.jsonl");
    const runLogger = new RunLogger(logPath, { enabled: true });

    await runClosePhase(state, BASE_OPTIONS, runLogger);

    const lines = (await readFile(logPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    const outcomeLines = lines.filter((l) => l.kind === "outcome");
    expect(outcomeLines).toHaveLength(1);
    expect(outcomeLines[0].note).toContain("F1");
    expect(outcomeLines[0].note).toContain("security");
    expect(outcomeLines[0].note).toContain("resolved");

    const artifactLine = lines.find(
      (l) => l.kind === "artifact_write" && l.artifact === "remediation-outcomes.json",
    );
    expect(artifactLine).toBeDefined();
    expect(artifactLine.note).toContain("1 outcome");
  });

  it("does not require a run logger (optional argument)", async () => {
    const state = makeState({
      items: { F1: { finding_id: "F1", status: "resolved", block_id: "B1" } },
    });
    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");
  });

  it("records failing closing commands instead of reporting success", async () => {
    const state = makeState({
      closing_plan: {
        action: "custom",
        custom_command: [process.execPath, "-e", "process.exit(7)"],
      },
    });

    const next = await runClosePhase(state, BASE_OPTIONS);
    const jsonReport = JSON.parse(
      await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
    );

    expect(next.status).toBe("complete");
    expect(jsonReport.closing_result.status).toBe("failed");
    expect(jsonReport.closing_result.commands[0].exit_code).toBe(7);
  });

  it("combined test failure with no re-blockable items warns and includes failure in markdown report", async () => {
    // All items are in non-resolved statuses, so blockResolvedItemsOnCombinedFailure
    // returns false. The run must still complete with status 'complete' and the
    // markdown report must contain a '## Combined Test Suite Failure' section.
    const state = makeState({
      plan: {
        plan_id: "P1",
        findings: [],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
        test_command: `${process.execPath} -e "console.error('combined failed'); process.exit(1)"`,
      },
      items: {
        F1: {
          finding_id: "F1",
          status: "blocked",
          block_id: "B1",
          failure_reason: "Some prior failure",
        },
        F2: {
          finding_id: "F2",
          status: "deemed_inappropriate",
          block_id: "B1",
          failure_reason: "Not applicable",
        },
      },
    });

    const warnMessages: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(" "));
    };

    let next: ReturnType<typeof makeState>;
    try {
      next = await runClosePhase(state, BASE_OPTIONS);
    } finally {
      console.warn = originalWarn;
    }

    expect(next.status).toBe("complete");

    const { existsSync, readFileSync } = await import("node:fs");
    const reportPath = join(REPO_DIR, "remediation-report.md");
    expect(existsSync(reportPath)).toBe(true);

    const reportContent = readFileSync(reportPath, "utf8");
    expect(reportContent).toContain("## Combined Test Suite Failure");

    const jsonReport = JSON.parse(
      readFileSync(join(REPO_DIR, "remediation-report.json"), "utf8"),
    );
    expect(jsonReport.combined_test_result.passed).toBe(false);
    expect(jsonReport.combined_test_result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(jsonReport.combined_test_result.suite_name).toBe(
      state.plan!.test_command,
    );
    expect(jsonReport.combined_test_result.failure_summary).toEqual(
      expect.any(String),
    );
    expect(jsonReport.combined_test_result.failure_summary.length).toBeGreaterThan(0);
    expect(jsonReport.combined_test_result.output).toBeUndefined();

    const warnEmitted = warnMessages.some((msg) =>
      msg.includes("Combined test suite failed") && msg.includes("no resolved items"),
    );
    expect(warnEmitted).toBe(true);
  });

  // MNT-a01af494: executeClosingAction must return 'success' (not 'failed' or
  // 'skipped') when no commands were run because there were no files to stage.
  // stageAndCommit returns true vacuously; commands.every(isSuccess) on [] is
  // vacuously true → status 'success'.
  describe("executeClosingAction returns success when stageAndCommit finds no files", () => {
    // REPO_DIR is not a git repo, so collectStagingFiles always returns [].
    it("status is 'success' and commands is empty when action is 'commit' and no files to stage", async () => {
      const state = makeState({ closing_plan: { action: "commit" } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });

    it("status is 'success' when action is 'push' and no files to stage", async () => {
      const state = makeState({ closing_plan: { action: "push" } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });

    it("status is 'success' when action is 'open-pr' and no files to stage", async () => {
      const state = makeState({ closing_plan: { action: "open-pr" } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });

    it("status is 'success' when action is 'custom' and custom_command is undefined", async () => {
      const state = makeState({ closing_plan: { action: "custom" } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });

    it("status is 'success' when action is 'custom' and custom_command is empty array", async () => {
      const state = makeState({ closing_plan: { action: "custom", custom_command: [] } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });
  });

  // MNT-a01af494: new tests for the stageAndCommit empty-tree fix.
  describe("executeClosingAction: stageAndCommit vacuous-success (MNT-a01af494)", () => {
    it("returns status 'success' when action is 'commit' and collectStagingFiles returns []", async () => {
      // REPO_DIR is not a git repo, so collectStagingFiles always returns [].
      const warnMessages: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnMessages.push(args.map(String).join(" "));
      };
      let jsonReport: Record<string, unknown>;
      try {
        const state = makeState({ closing_plan: { action: "commit" } });
        await runClosePhase(state, BASE_OPTIONS);
        jsonReport = JSON.parse(
          await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
        ) as Record<string, unknown>;
      } finally {
        console.warn = originalWarn;
      }
      const closingResult = jsonReport.closing_result as Record<string, unknown>;
      expect(closingResult.status).toBe("success");
      expect((closingResult.commands as unknown[]).length).toBe(0);
      expect(warnMessages.some((m) => m.includes("No modified files"))).toBe(true);
    });

    it("returns status 'success' when action is 'push' and collectStagingFiles returns []", async () => {
      const state = makeState({ closing_plan: { action: "push" } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
      );
      const closingResult = jsonReport.closing_result;
      expect(closingResult.status).toBe("success");
      // stageAndCommit short-circuits: no git push attempted either
      expect(closingResult.commands).toHaveLength(0);
    });

    it("returns status 'failed' when a git command fails (files present)", async () => {
      // Ensure collectStagingFiles returns at least one file by writing into
      // the REPO_DIR (not a git repo, so stagedAndUntracked returns [] —
      // simulate with a custom closing action that fails instead).
      const state = makeState({
        closing_plan: {
          action: "custom",
          custom_command: [process.execPath, "-e", "process.exit(1)"],
        },
      });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(REPO_DIR, "remediation-report.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("failed");
    });
  });

  it("buildRemediationReportMarkdown: combined test failure section only present when passed=false", async () => {
    // Passing test command — no failure section should appear.
    const state = makeState({
      plan: {
        plan_id: "P1",
        findings: [],
        blocks: [],
        project_type: "unknown",
        candidate_closing_actions: ["none"],
        // Use bare `node` (PATH-resolved): process.execPath is an absolute path
        // that contains a space on Windows ("C:\Program Files\nodejs\node.exe"),
        // which cmd.exe mis-parses under shell:true, making the suite spuriously
        // "fail" and routing the run to triage. The sibling tests use `node`.
        test_command: 'node -e "process.exit(0)"',
      },
      items: {
        F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
      },
    });

    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");

    const { readFileSync } = await import("node:fs");
    const reportContent = readFileSync(join(REPO_DIR, "remediation-report.md"), "utf8");
    expect(reportContent).not.toContain("## Combined Test Suite Failure");
  });
});

describe("collectStagingFiles", () => {
  const GIT_DIR = join(__dirname, ".test-close-git");

  beforeEach(async () => {
    await rm(GIT_DIR, { recursive: true, force: true });
    await mkdir(GIT_DIR, { recursive: true });
    execSync("git init", { cwd: GIT_DIR });
    execSync("git config user.email test@test.com", { cwd: GIT_DIR });
    execSync("git config user.name Test", { cwd: GIT_DIR });
    writeFileSync(join(GIT_DIR, "initial.txt"), "hello");
    execSync("git add . && git commit -m init", { cwd: GIT_DIR });
  });

  afterEach(async () => {
    await rm(GIT_DIR, { recursive: true, force: true });
  });

  it("includes modified files but excludes .remediation-artifacts and .env", () => {
    writeFileSync(join(GIT_DIR, "initial.txt"), "modified");
    writeFileSync(join(GIT_DIR, "new-file.ts"), "code");
    mkdirSync(join(GIT_DIR, ".remediation-artifacts"), { recursive: true });
    writeFileSync(join(GIT_DIR, ".remediation-artifacts", "state.json"), "{}");
    mkdirSync(join(GIT_DIR, ".audit-artifacts"), { recursive: true });
    writeFileSync(join(GIT_DIR, ".audit-artifacts", "audit-findings.json"), "{}");
    writeFileSync(join(GIT_DIR, ".env"), "SECRET=x");
    writeFileSync(join(GIT_DIR, ".env.local"), "SECRET=y");

    const files = collectStagingFiles(GIT_DIR);
    expect(files).toContain("initial.txt");
    expect(files).toContain("new-file.ts");
    expect(files.some((f) => f.includes(".remediation-artifacts"))).toBe(false);
    expect(files.some((f) => f.includes(".audit-artifacts"))).toBe(false);
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".env.local");
  });

  it("returns empty array when no files changed", () => {
    const files = collectStagingFiles(GIT_DIR);
    expect(files).toEqual([]);
  });
});
