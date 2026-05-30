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

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-close");
const REPO_DIR = join(__dirname, ".test-close-repo");

const BASE_OPTIONS = { root: REPO_DIR, artifactsDir: TEST_DIR };

function makeState(
  overrides: Partial<RemediationState> = {},
): RemediationState {
  return {
    status: "closing",
    plan: {
      plan_id: "P1",
      findings: [],
      blocks: [],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {},
    closing_plan: { action: "none" },
    ...overrides,
  } as any;
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await rm(REPO_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
  await mkdir(REPO_DIR, { recursive: true });
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
    writeFileSync(join(GIT_DIR, ".env"), "SECRET=x");
    writeFileSync(join(GIT_DIR, ".env.local"), "SECRET=y");

    const files = collectStagingFiles(GIT_DIR);
    expect(files).toContain("initial.txt");
    expect(files).toContain("new-file.ts");
    expect(files.some((f) => f.includes(".remediation-artifacts"))).toBe(false);
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".env.local");
  });

  it("returns empty array when no files changed", () => {
    const files = collectStagingFiles(GIT_DIR);
    expect(files).toEqual([]);
  });
});
