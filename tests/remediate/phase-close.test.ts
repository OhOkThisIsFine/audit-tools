import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runClosePhase, collectStagingFiles, buildOutcomeCoverageLedger, executeClosingAction } from "../../src/remediate/phases/close.js";
import { remediationBaseBranchPath } from "../../src/remediate/steps/dispatch.js";
import { readFile, rm, mkdir, writeFile as writeFileAsync } from "node:fs/promises";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSyncHidden as execSync } from "../helpers/spawn.mjs";
import { RunLogger } from "audit-tools/shared";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { makeState as makeBaseState } from "./test-helpers.js";
import { validateVerificationReport } from "../../src/remediate/validation/contractPipeline.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, ".test-close-repo");
const TEST_DIR = join(REPO_DIR, ".audit-tools", "remediation");
const OUTPUT_DIR = join(REPO_DIR, ".audit-tools");

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
  await rm(REPO_DIR, { recursive: true, force: true });
  await mkdir(TEST_DIR, { recursive: true });
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
    expect(existsSync(join(OUTPUT_DIR, "remediation-report.md"))).toBe(true);
    expect(existsSync(join(OUTPUT_DIR, "remediation-state.complete.json"))).toBe(true);
    const completeState = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-state.complete.json"), "utf8"),
    );
    expect(completeState.status).toBe("complete");
    expect(completeState.items.F1.status).toBe("resolved");
  });

  it("writes run metadata, structured verification evidence, and vacuous combined test details", async () => {
    const startedAt = "2026-06-05T12:00:00.000Z";
    const state = makeState({
      started_at: startedAt,
      step_count: 7,
      plan: {
        plan_id: "P1",
        goal_id: "G1",
        source: "contract_pipeline",
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
            evidence: ["contract task evidence"],
            contract_goal_id: "G1",
            contract_obligation_ids: ["O-1"],
            verification_obligation_ids: ["VO-1"],
            targeted_commands: ["npm test -- auth"],
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

    const outcomesJson = JSON.parse(
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
    );
    expect(outcomesJson.started_at).toBe(startedAt);
    expect(Date.parse(outcomesJson.ended_at)).not.toBeNaN();
    expect(new Date(outcomesJson.ended_at).getTime()).toBeGreaterThanOrEqual(
      new Date(startedAt).getTime(),
    );
    expect(outcomesJson.step_count).toBe(7);
    expect(outcomesJson.combined_test_result).toEqual({
      passed: true,
      duration_ms: 0,
    });

    const markdown = await readFile(join(OUTPUT_DIR, "remediation-report.md"), "utf8");
    expect(markdown).toContain("  - *Verification*: check A");
    expect(markdown).toContain("  - *Verification*: check B");
    expect(markdown).not.toContain("check A\ncheck B");

    const verificationReport = JSON.parse(
      await readFile(join(OUTPUT_DIR, "verification_report.json"), "utf8"),
    );
    expect(verificationReport.goal_id).toBe("G1");
    const traces = verificationReport.findings[0].traces;
    expect(traces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trace_id: "F1:contract-goal",
          kind: "requirement",
          evidence: ["goal_id=G1"],
          status: "passed",
        }),
        expect.objectContaining({
          trace_id: "F1:contract-obligations",
          kind: "requirement",
          evidence: ["O-1"],
          status: "passed",
        }),
        expect.objectContaining({
          trace_id: "F1:verification-obligations",
          kind: "invariant",
          evidence: ["VO-1"],
          status: "passed",
        }),
        expect.objectContaining({
          trace_id: "F1:targeted-command-1",
          kind: "command",
          evidence: ["planned command: npm test -- auth"],
          status: "passed",
        }),
      ]),
    );
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

  // N-R16: reblockRetryableIgnoredItems is removed — ignored items with
  // retry/deferred rationale must NOT be re-blocked at close. Settled user
  // decisions are never silently reinterpreted.
  it("does not re-block ignored items with retry/deferred rationale (reblockRetryableIgnoredItems removed)", async () => {
    const state = makeState({
      closing_plan: { action: "none", pre_authorized: true },
      items: {
        F1: {
          finding_id: "F1",
          status: "ignored",
          block_id: "B1",
          failure_reason:
            "Deferred - needs its own focused block and should be retried in a dedicated pass.",
          completed_at: "2026-06-05T12:01:00.000Z",
        },
      },
    });

    const next = await runClosePhase(state, BASE_OPTIONS);
    // Must complete, not triage — ignored items stay ignored.
    expect(next.status).toBe("complete");
    expect(state.items!.F1.status).toBe("ignored");
    // TST-12d5b949: the load-bearing guarantee is that the settled user decision
    // is NOT reinterpreted — the original rationale survives close verbatim and
    // the item is not flipped back to a retry/blocked state. (The prior
    // `/Retry requested/` regex pinned nothing: the removed
    // reblockRetryableIgnoredItems never wrote that exact phrase.)
    expect(state.items!.F1.failure_reason).toBe(
      "Deferred - needs its own focused block and should be retried in a dedicated pass.",
    );
    expect(state.items!.F1.status).not.toBe("blocked");
    expect(state.items!.F1.status).not.toBe("pending");
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
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
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
      await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
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
    const reportPath = join(OUTPUT_DIR, "remediation-report.md");
    expect(existsSync(reportPath)).toBe(true);

    const reportContent = readFileSync(reportPath, "utf8");
    expect(reportContent).toContain("## Combined Test Suite Failure");

    const jsonReport = JSON.parse(
      readFileSync(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
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
  // N-R16: pre_authorized: true is required to skip the confirmation preview.
  describe("executeClosingAction returns success when stageAndCommit finds no files", () => {
    // REPO_DIR is a clean git repo with no uncommitted changes, so collectStagingFiles returns [].
    it("status is 'success' and commands is empty when action is 'commit' and no files to stage", async () => {
      const state = makeState({ closing_plan: { action: "commit", pre_authorized: true } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });

    it("status is 'success' when action is 'push' and no files to stage", async () => {
      const state = makeState({ closing_plan: { action: "push", pre_authorized: true } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });

    it("status is 'success' when action is 'open-pr' and no files to stage", async () => {
      const state = makeState({ closing_plan: { action: "open-pr", pre_authorized: true } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });

    it("status is 'success' when action is 'custom' and custom_command is undefined", async () => {
      const state = makeState({ closing_plan: { action: "custom" } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });

    it("status is 'success' when action is 'custom' and custom_command is empty array", async () => {
      const state = makeState({ closing_plan: { action: "custom", custom_command: [] } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("success");
      expect(jsonReport.closing_result.commands).toHaveLength(0);
    });
  });

  // MNT-a01af494: new tests for the stageAndCommit empty-tree fix.
  // N-R16: pre_authorized: true is required to skip the confirmation preview.
  describe("executeClosingAction: stageAndCommit vacuous-success (MNT-a01af494)", () => {
    it("returns status 'success' when action is 'commit' and collectStagingFiles returns []", async () => {
      // REPO_DIR is a clean git repo with no uncommitted changes, so collectStagingFiles returns [].
      const warnMessages: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnMessages.push(args.map(String).join(" "));
      };
      let jsonReport: Record<string, unknown>;
      try {
        const state = makeState({ closing_plan: { action: "commit", pre_authorized: true } });
        await runClosePhase(state, BASE_OPTIONS);
        jsonReport = JSON.parse(
          await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
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
      const state = makeState({ closing_plan: { action: "push", pre_authorized: true } });
      await runClosePhase(state, BASE_OPTIONS);
      const jsonReport = JSON.parse(
        await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
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
        await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("failed");
    });
  });

  describe("B5: merge-to-base closing action", () => {
    function currentBranch(): string {
      return execSync("git rev-parse --abbrev-ref HEAD", { cwd: REPO_DIR })
        .toString()
        .trim();
    }
    function setupRemediationBranch(): { base: string } {
      const base = currentBranch();
      execSync("git checkout -b remediation/P1", { cwd: REPO_DIR });
      writeFileSync(join(REPO_DIR, "fix.txt"), "remediation work");
      execSync("git add . && git commit -m fix", { cwd: REPO_DIR });
      return { base };
    }

    it("clean run: --no-ff merges into the recorded base and leaves HEAD on base", () => {
      const { base } = setupRemediationBranch();
      writeFileSync(remediationBaseBranchPath(TEST_DIR), JSON.stringify({ base_branch: base }));
      // End-of-run state: checked out on the remediation branch.
      const result = executeClosingAction(
        makeState({ closing_plan: { action: "merge-to-base", pre_authorized: true } }),
        BASE_OPTIONS,
      );
      expect(result.status).toBe("success");
      expect(currentBranch()).toBe(base);
      // The fix landed on base as one revertable merge commit.
      expect(existsSync(join(REPO_DIR, "fix.txt"))).toBe(true);
      const merges = execSync("git log --merges --oneline", { cwd: REPO_DIR }).toString().trim();
      expect(merges).toContain("Merge remediation run P1");
    });

    it("no recorded base: skips, leaves everything untouched, tells host to merge manually", () => {
      setupRemediationBranch();
      // No sidecar written.
      const result = executeClosingAction(
        makeState({ closing_plan: { action: "merge-to-base", pre_authorized: true } }),
        BASE_OPTIONS,
      );
      expect(result.status).toBe("skipped");
      expect(currentBranch()).toBe("remediation/P1");
      expect(result.commands[0]?.stderr).toContain("manually");
    });

    it("conflict: aborts, restores the remediation branch, base left exactly as it was", () => {
      const base = currentBranch();
      // Diverge: base and remediation both edit the same line.
      writeFileSync(join(REPO_DIR, "shared.txt"), "orig");
      execSync("git add . && git commit -m orig", { cwd: REPO_DIR });
      execSync("git checkout -b remediation/P1", { cwd: REPO_DIR });
      writeFileSync(join(REPO_DIR, "shared.txt"), "remediation");
      execSync("git add . && git commit -m rem", { cwd: REPO_DIR });
      execSync(`git checkout ${base}`, { cwd: REPO_DIR });
      writeFileSync(join(REPO_DIR, "shared.txt"), "base-moved");
      execSync("git add . && git commit -m base", { cwd: REPO_DIR });
      execSync("git checkout remediation/P1", { cwd: REPO_DIR });
      writeFileSync(remediationBaseBranchPath(TEST_DIR), JSON.stringify({ base_branch: base }));

      const result = executeClosingAction(
        makeState({ closing_plan: { action: "merge-to-base", pre_authorized: true } }),
        BASE_OPTIONS,
      );
      expect(result.status).toBe("failed");
      // Restored onto the remediation branch; base's content is unchanged.
      expect(currentBranch()).toBe("remediation/P1");
      execSync(`git checkout ${base}`, { cwd: REPO_DIR });
      expect(readFileSync(join(REPO_DIR, "shared.txt")).toString()).toBe("base-moved");
    });
  });

  it("aggregates worker reflections from agent-feedback.jsonl into a Process Feedback section", async () => {
    await writeFileAsync(
      join(TEST_DIR, "agent-feedback.jsonl"),
      JSON.stringify({
        task_id: "B-001",
        instruction_clarity: "ambiguous",
        severity: "medium",
        tool_friction: ["result path collided across waves"],
      }) +
        "\n" +
        "worker crashed mid-line{\n",
    );
    const state = makeState({
      items: { F1: { finding_id: "F1", status: "resolved", block_id: "B1" } },
    });

    const next = await runClosePhase(state, BASE_OPTIONS);
    expect(next.status).toBe("complete");

    const report = await readFile(join(OUTPUT_DIR, "remediation-report.md"), "utf8");
    expect(report).toContain("## Process Feedback");
    expect(report).toContain("- result path collided across waves");
    expect(report).toContain("Instruction clarity: ambiguous: 1");
  });

  it("omits the Process Feedback section when no reflections were appended", async () => {
    const state = makeState({
      items: { F1: { finding_id: "F1", status: "resolved", block_id: "B1" } },
    });
    await runClosePhase(state, BASE_OPTIONS);
    const report = await readFile(join(OUTPUT_DIR, "remediation-report.md"), "utf8");
    expect(report).not.toContain("## Process Feedback");
  });

  // ── N-R16 tests ─────────────────────────────────────────────────────────────

  describe("closing action preview (N-R16)", () => {
    it("prompts for confirmation when not pre-authorized: returns state with closing_action_preview when action is 'commit'", async () => {
      const state = makeState({
        closing_plan: { action: "commit" },
        items: {
          F1: {
            finding_id: "F1",
            status: "resolved",
            block_id: "B1",
          },
        },
        plan: {
          plan_id: "P1",
          findings: [
            {
              id: "F1",
              title: "Fix the bug",
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
          candidate_closing_actions: ["commit"],
        } as any,
      });

      const next = await runClosePhase(state, BASE_OPTIONS);

      // Should return preview, not complete.
      expect(next.status).toBe("closing");
      expect(next.closing_plan!.closing_action_preview).toBeDefined();
      const preview = next.closing_plan!.closing_action_preview!;
      // File list from collectStagingFiles (clean repo → []).
      expect(Array.isArray(preview.files)).toBe(true);
      // Commit message is generated from the finding title, not hardcoded.
      expect(typeof preview.commit_message).toBe("string");
      expect(preview.commit_message).toContain("Fix the bug");
      expect(preview.commit_message).not.toBe("Auto-remediation complete");
    });

    it("proceeds directly to git commands when pre_authorized is true", async () => {
      // With pre_authorized=true and no files to stage, runClosePhase should
      // skip the preview and execute the closing action (vacuous success → complete).
      const state = makeState({
        closing_plan: { action: "commit", pre_authorized: true },
      });

      const next = await runClosePhase(state, BASE_OPTIONS);
      expect(next.status).toBe("complete");
      expect(next.closing_plan!.closing_action_preview).toBeUndefined();
    });

    it("does not generate a preview for action='none'", async () => {
      const state = makeState({
        closing_plan: { action: "none" },
      });
      const next = await runClosePhase(state, BASE_OPTIONS);
      expect(next.status).toBe("complete");
      expect(next.closing_plan!.closing_action_preview).toBeUndefined();
    });

    it("uses generated commit message (not hardcoded) when executing after pre_authorized=true", async () => {
      // Write a file so there's something to stage and commit.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(REPO_DIR, "changed.ts"), "// changed");

      const state = makeState({
        closing_plan: { action: "commit", pre_authorized: true },
        plan: {
          plan_id: "P1",
          findings: [
            {
              id: "F1",
              title: "My specific fix title",
              category: "correctness",
              severity: "high",
              confidence: "high",
              lens: "correctness",
              summary: "",
              affected_files: [{ path: "changed.ts" }],
            },
          ],
          blocks: [],
          project_type: "unknown",
          candidate_closing_actions: ["commit"],
        } as any,
        items: {
          F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
        },
      });

      const next = await runClosePhase(state, BASE_OPTIONS);
      expect(next.status).toBe("complete");

      // Check that the git log shows the generated message, not "Auto-remediation complete".
      const logMsg = execSync("git log -1 --format=%s", { cwd: REPO_DIR }).toString().trim();
      expect(logMsg).toContain("My specific fix title");
      expect(logMsg).not.toBe("Auto-remediation complete");
    });
  });

  describe("e2e failure → triage (N-R16)", () => {
    it("transitions to triage when e2e_command exits non-zero (never throws)", async () => {
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
        plan: {
          plan_id: "P1",
          findings: [],
          blocks: [],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
          // Use bare 'node' to avoid Windows path-with-spaces issues under shell:true.
          e2e_command: 'node -e "process.exit(1)"',
        },
        items: {
          F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
        },
      });

      let result: Awaited<ReturnType<typeof runClosePhase>> | undefined;
      let threw = false;
      try {
        result = await runClosePhase(state, BASE_OPTIONS);
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).toBeDefined();
      expect(result!.status).toBe("triage");
      // At least one item should be re-blocked with e2e failure info.
      const blockedItems = Object.values(result!.items ?? {}).filter(
        (i) => i.status === "blocked",
      );
      expect(blockedItems.length).toBeGreaterThan(0);
    });

    it("passes when e2e_command exits zero", async () => {
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
        plan: {
          plan_id: "P1",
          findings: [],
          blocks: [],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
          // Use bare 'node' (PATH-resolved) to avoid Windows path-with-spaces
          // issues under shell:true (process.execPath may have spaces).
          e2e_command: 'node -e "process.exit(0)"',
        },
        items: {
          F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
        },
      });

      const next = await runClosePhase(state, BASE_OPTIONS);
      expect(next.status).toBe("complete");
    });
  });

  describe("selective re-block on combined failure (N-R16)", () => {
    it("re-blocks only the item whose touched_files overlap the failing test path", async () => {
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
        plan: {
          plan_id: "P1",
          findings: [],
          blocks: [],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
          // Emit a failure that mentions src/auth.ts specifically.
          // Use bare 'node' to avoid Windows path-with-spaces issues under shell:true.
          test_command: 'node -e "process.stderr.write(\'FAIL src/auth.ts\\n\'); process.exit(1)"',
        },
        items: {
          F1: {
            finding_id: "F1",
            status: "resolved",
            block_id: "B1",
            item_spec: {
              finding_id: "F1",
              concrete_change: "fix auth",
              tests_to_write: [],
              not_applicable_steps: [],
              touched_files: ["src/auth.ts"],
            } as any,
          },
          F2: {
            finding_id: "F2",
            status: "resolved",
            block_id: "B2",
            item_spec: {
              finding_id: "F2",
              concrete_change: "fix util",
              tests_to_write: [],
              not_applicable_steps: [],
              touched_files: ["src/util.ts"],
            } as any,
          },
        },
      });

      const next = await runClosePhase(state, BASE_OPTIONS);
      expect(next.status).toBe("triage");
      // Only F1 (auth.ts overlap) should be blocked.
      expect(state.items!.F1.status).toBe("blocked");
      // F2 (util.ts — no overlap) should remain resolved.
      expect(state.items!.F2.status).toBe("resolved");
    });

    it("falls back to re-blocking all resolved items when no touched_files overlap found", async () => {
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
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
          F2: { finding_id: "F2", status: "resolved", block_id: "B2" },
        },
      });

      const next = await runClosePhase(state, BASE_OPTIONS);
      expect(next.status).toBe("triage");
      expect(state.items!.F1.status).toBe("blocked");
      expect(state.items!.F2.status).toBe("blocked");
      // Fallback note should be in failure_reason.
      expect(state.items!.F1.failure_reason).toMatch(/falling back/i);
    });
  });

  describe("overall_status excludes ignored and inappropriate items (N-R16)", () => {
    it("overall_status='passed' when resolved items pass but some are ignored", async () => {
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
        items: {
          F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
          F2: {
            finding_id: "F2",
            status: "ignored",
            block_id: "B2",
            failure_reason: "User chose to ignore",
          },
        },
      });

      await runClosePhase(state, BASE_OPTIONS);

      const { readFileSync } = await import("node:fs");
      const report = JSON.parse(
        readFileSync(join(OUTPUT_DIR, "verification_report.json"), "utf8"),
      );
      expect(report.overall_status).toBe("passed");
      const f2trace = report.findings.find(
        (f: { finding_id: string }) => f.finding_id === "F2",
      );
      expect(f2trace.overall_status).toBe("skipped");
      expect(
        validateVerificationReport(report).filter((i) => i.severity === "error"),
      ).toHaveLength(0);
    });

    it("overall_status='passed' when resolved items pass but some are deemed_inappropriate", async () => {
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
        items: {
          F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
          F3: {
            finding_id: "F3",
            status: "deemed_inappropriate",
            block_id: "B3",
            failure_reason: "Not applicable to this codebase",
          },
        },
      });

      await runClosePhase(state, BASE_OPTIONS);

      const { readFileSync } = await import("node:fs");
      const report = JSON.parse(
        readFileSync(join(OUTPUT_DIR, "verification_report.json"), "utf8"),
      );
      expect(report.overall_status).toBe("passed");
      const f3trace = report.findings.find(
        (f: { finding_id: string }) => f.finding_id === "F3",
      );
      expect(f3trace.overall_status).toBe("skipped");
      expect(
        validateVerificationReport(report).filter((i) => i.severity === "error"),
      ).toHaveLength(0);
    });

    it("overall_status='passed' when ALL items are skipped (ignored/inappropriate) and no resolved items remain", async () => {
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
        items: {
          F2: {
            finding_id: "F2",
            status: "ignored",
            block_id: "B2",
            failure_reason: "User chose to ignore",
          },
          F3: {
            finding_id: "F3",
            status: "deemed_inappropriate",
            block_id: "B3",
            failure_reason: "Not applicable to this codebase",
          },
        },
      });

      await runClosePhase(state, BASE_OPTIONS);

      const { readFileSync } = await import("node:fs");
      const report = JSON.parse(
        readFileSync(join(OUTPUT_DIR, "verification_report.json"), "utf8"),
      );
      // No non-skipped findings to fail the verdict, and the (trivially
      // passing, empty) combined test suite passed — report-level status
      // stays the strict "passed"|"failed" (never "skipped" itself).
      expect(report.overall_status).toBe("passed");
      expect(
        report.findings.every((f: { overall_status: string }) => f.overall_status === "skipped"),
      ).toBe(true);
      expect(
        validateVerificationReport(report).filter((i) => i.severity === "error"),
      ).toHaveLength(0);
    });
  });

  describe("artifacts preserved when close is not fully green (N-R16)", () => {
    it("preserves artifacts directory when closing action fails", async () => {
      const state = makeState({
        closing_plan: {
          action: "custom",
          custom_command: [process.execPath, "-e", "process.exit(7)"],
          pre_authorized: true,
        },
      });

      await runClosePhase(state, BASE_OPTIONS);

      const { existsSync } = await import("node:fs");
      // Artifacts dir should be preserved because closing action failed.
      expect(existsSync(TEST_DIR)).toBe(true);
    });

    it("preserves artifacts directory when combined test suite fails", async () => {
      // All items are non-resolved (blocked), so test failure can't re-block
      // anyone → run completes with test failure recorded (no triage).
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
        plan: {
          plan_id: "P1",
          findings: [],
          blocks: [],
          project_type: "unknown",
          candidate_closing_actions: ["none"],
          test_command: 'node -e "process.exit(1)"',
        },
        items: {
          F1: {
            finding_id: "F1",
            status: "blocked",
            block_id: "B1",
            failure_reason: "prior failure",
          },
        },
      });

      const originalWarn = console.warn;
      console.warn = () => {};
      try {
        await runClosePhase(state, BASE_OPTIONS);
      } finally {
        console.warn = originalWarn;
      }

      const { existsSync } = await import("node:fs");
      // Artifacts dir preserved (combined test failed).
      expect(existsSync(TEST_DIR)).toBe(true);
    });

    // CP-NODE-4: a skipped NON-none close (e.g. merge-to-base with no recorded
    // base) did NOT genuinely complete — the run never landed. fullyGreen must be
    // false so the (gitignored, unrecoverable) artifacts dir is preserved, not
    // deleted as if the run succeeded.
    it("preserves artifacts directory when merge-to-base is skipped (no recorded base)", async () => {
      // Put HEAD on the remediation branch with a committed fix, but write NO
      // base-branch sidecar → executeClosingAction returns status 'skipped'.
      execSync("git checkout -b remediation/P1", { cwd: REPO_DIR });
      writeFileSync(join(REPO_DIR, "fix.txt"), "remediation work");
      execSync("git add . && git commit -m fix", { cwd: REPO_DIR });

      const state = makeState({
        closing_plan: { action: "merge-to-base", pre_authorized: true },
        items: {
          F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
        },
      });

      const next = await runClosePhase(state, BASE_OPTIONS);
      expect(next.status).toBe("complete");

      const jsonReport = JSON.parse(
        await readFile(join(OUTPUT_DIR, "remediation-outcomes.json"), "utf8"),
      );
      expect(jsonReport.closing_result.status).toBe("skipped");
      // Artifacts dir preserved: the skipped merge means the run is NOT green.
      expect(existsSync(TEST_DIR)).toBe(true);
    });

    it("deletes artifacts directory on fully-green close", async () => {
      const state = makeState({
        closing_plan: { action: "none", pre_authorized: true },
        items: {
          F1: { finding_id: "F1", status: "resolved", block_id: "B1" },
        },
      });

      await runClosePhase(state, BASE_OPTIONS);

      const { existsSync } = await import("node:fs");
      // On fully-green close (action=none/skipped, no test failure), artifacts deleted.
      expect(existsSync(TEST_DIR)).toBe(false);
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
    const reportContent = readFileSync(join(OUTPUT_DIR, "remediation-report.md"), "utf8");
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

  it("includes modified files but excludes .audit-tools/remediation and .env", () => {
    writeFileSync(join(GIT_DIR, "initial.txt"), "modified");
    writeFileSync(join(GIT_DIR, "new-file.ts"), "code");
    mkdirSync(join(GIT_DIR, ".audit-tools/remediation"), { recursive: true });
    writeFileSync(join(GIT_DIR, ".audit-tools/remediation", "state.json"), "{}");
    mkdirSync(join(GIT_DIR, ".audit-tools/audit"), { recursive: true });
    writeFileSync(join(GIT_DIR, ".audit-tools/audit", "audit-findings.json"), "{}");
    writeFileSync(join(GIT_DIR, ".env"), "SECRET=x");
    writeFileSync(join(GIT_DIR, ".env.local"), "SECRET=y");

    const files = collectStagingFiles(GIT_DIR);
    expect(files).toContain("initial.txt");
    expect(files).toContain("new-file.ts");
    expect(files.some((f) => f.includes(".audit-tools/remediation"))).toBe(false);
    expect(files.some((f) => f.includes(".audit-tools/audit"))).toBe(false);
    expect(files).not.toContain(".env");
    expect(files).not.toContain(".env.local");
  });

  it("returns empty array when no files changed", () => {
    const files = collectStagingFiles(GIT_DIR);
    expect(files).toEqual([]);
  });
});

describe("buildOutcomeCoverageLedger — review-gate declines (1c-2)", () => {
  const OUTCOME_DIR = join(__dirname, ".test-close-outcome");
  const OUTCOME_ARTIFACTS = join(OUTCOME_DIR, ".audit-tools", "remediation");
  const AUDIT_PATH = join(OUTCOME_DIR, "audit-findings.json");

  beforeEach(async () => {
    await rm(OUTCOME_DIR, { recursive: true, force: true });
    await mkdir(join(OUTCOME_ARTIFACTS, "intake"), { recursive: true });
    // The intake source manifest still points at the UNFILTERED original report
    // (the gate only swaps the filtered copy into the pipeline's sourcePaths), so
    // close-time payload recovery can find the declined finding.
    await writeFileAsync(
      AUDIT_PATH,
      JSON.stringify({
        contract_version: "audit-tools/audit-findings/v1alpha1",
        findings: [
          {
            id: "ARC-001",
            title: "Module boundaries leak persistence concerns",
            category: "architecture",
            severity: "medium",
            confidence: "medium",
            lens: "architecture",
            summary: "The store layer reaches across module seams.",
            affected_files: [{ path: "src/store.ts" }],
            evidence: ["src/store.ts:1 evidence"],
          },
        ],
        work_blocks: [],
      }),
      "utf8",
    );
    await writeFileAsync(
      join(OUTCOME_ARTIFACTS, "intake", "source-manifest.json"),
      JSON.stringify({
        schema_version: "remediate-code-intake-source-manifest/v1alpha1",
        created_from: "input",
        sources: [{ type: "structured_audit", path: AUDIT_PATH, label: "audit" }],
      }),
      "utf8",
    );
  });

  afterEach(async () => {
    await rm(OUTCOME_DIR, { recursive: true, force: true });
  });

  it("enriches a declined_by_review entry with the review_gate drop_reason and recovered payload", async () => {
    const state = makeState({
      plan: { plan_id: "P1", findings: [], blocks: [], project_type: "unknown", candidate_closing_actions: ["none"] },
      plan_coverage: {
        contract_version: "remediate-code-coverage/v1alpha1",
        plan_id: "P1",
        source_finding_count: 0,
        planned_count: 0,
        folded_count: 0,
        dropped_count: 0,
        checkpoint_dropped_count: 0,
        phantom_dropped_count: 0,
        declined_review_count: 1,
        entries: [
          {
            finding_id: "ARC-001",
            disposition: "declined_by_review",
            rationale: "Disapproved by the user at the review gate (review-necessity: strategic).",
          },
        ],
      },
    });

    const outcome = await buildOutcomeCoverageLedger(state, {
      root: OUTCOME_DIR,
      artifactsDir: OUTCOME_ARTIFACTS,
    } as any);

    expect(outcome).toBeDefined();
    const entry = outcome!.entries.find((e) => e.finding_id === "ARC-001")!;
    expect(entry.drop_reason).toBe("review_gate");
    expect(entry.disposition).toBe("declined_by_review");
    // The full Finding payload is recovered from the unfiltered intake source.
    expect(entry.finding).toBeDefined();
    expect(entry.finding!.title).toBe("Module boundaries leak persistence concerns");
    expect(entry.rationale).toMatch(/review gate/i);
  });
});
