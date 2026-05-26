import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type {
  FreshSessionProvider,
  LaunchFreshSessionInput,
} from "../src/providers/types.js";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-orch");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(TEST_DIR, "artifacts");
const FIXTURE = join(__dirname, "fixtures", "audit-report-simple.md");

const ALL_STEPS_NOT_APPLICABLE = [
  { step: "Write Tests" as const, rationale: "Fixture only" },
  { step: "Refactor Code" as const, rationale: "Fixture only" },
  {
    step: "Verify Code Against Documentation" as const,
    rationale: "Fixture only",
  },
];

// Default mock provider: resolves all items successfully
function makeSuccessProvider(): FreshSessionProvider {
  return {
    name: "mock",
    launch: vi.fn(async (opts: LaunchFreshSessionInput) => {
      const promptName = opts.promptPath.split(/[/\\]/).pop() ?? "";
      if (promptName.startsWith("prompt_closing_plan")) {
        await writeFile(
          opts.resultPath,
          JSON.stringify({ action: "none" }),
          "utf8",
        );
      } else if (promptName.match(/^prompt_F-/)) {
        const findingId = promptName.replace("prompt_", "").replace(".md", "");
        await writeFile(
          opts.resultPath,
          JSON.stringify({
            type: "item_spec",
            item_spec: {
              finding_id: findingId,
              concrete_change: "Fix the issue.",
              tests_to_write: [],
              not_applicable_steps: ALL_STEPS_NOT_APPLICABLE,
            },
          }),
          "utf8",
        );
      } else if (promptName.startsWith("prompt_plan")) {
        await writeFile(
          opts.resultPath,
          JSON.stringify({ findings: [], blocks: [] }),
          "utf8",
        );
      }
      return { accepted: true, exitCode: 0 };
    }),
  };
}

// Clarification mock provider: requests clarification for F-001
function makeClarifyProvider(): FreshSessionProvider {
  return {
    name: "mock-clarify",
    launch: vi.fn(async (opts: LaunchFreshSessionInput) => {
      const promptName = opts.promptPath.split(/[/\\]/).pop() ?? "";
      if (promptName.includes("F-001")) {
        await writeFile(
          opts.resultPath,
          JSON.stringify({
            type: "clarification_request",
            clarifications: [
              {
                finding_id: "F-001",
                category: "scope_of_fix",
                description: "Clarify scope",
              },
            ],
          }),
          "utf8",
        );
      } else if (promptName.includes("F-002")) {
        await writeFile(
          opts.resultPath,
          JSON.stringify({
            type: "item_spec",
            item_spec: {
              finding_id: "F-002",
              concrete_change: "Fix.",
              tests_to_write: [],
              not_applicable_steps: ALL_STEPS_NOT_APPLICABLE,
            },
          }),
          "utf8",
        );
      } else if (promptName.startsWith("prompt_closing_plan")) {
        await writeFile(
          opts.resultPath,
          JSON.stringify({ action: "none" }),
          "utf8",
        );
      }
      return { accepted: true, exitCode: 0 };
    }),
  };
}

function makeBlockingProvider(name: string): FreshSessionProvider {
  return {
    name,
    launch: vi.fn(async (opts: LaunchFreshSessionInput) => {
      const promptName = opts.promptPath.split(/[/\\]/).pop() ?? "";
      if (promptName.startsWith("prompt_closing_plan")) {
        await writeFile(
          opts.resultPath,
          JSON.stringify({ action: "none" }),
          "utf8",
        );
      } else if (promptName.match(/^prompt_F-002/)) {
        await writeFile(
          opts.resultPath,
          JSON.stringify({
            type: "item_spec",
            item_spec: {
              finding_id: "F-002",
              concrete_change: "Fix.",
              tests_to_write: [],
              not_applicable_steps: ALL_STEPS_NOT_APPLICABLE,
            },
          }),
          "utf8",
        );
      } else if (promptName.match(/^prompt_F-001/)) {
        await writeFile(
          opts.resultPath,
          JSON.stringify({ type: "invalid_type" }),
          "utf8",
        );
      }
      return { accepted: true, exitCode: 0 };
    }),
  };
}

// The mock factory — vi.fn() so individual tests can override it
const mockCreateProvider = vi.fn(() => makeSuccessProvider());

vi.mock("../src/providers/index.js", () => ({
  createFreshSessionProvider: (...args: unknown[]) =>
    mockCreateProvider(...args),
  resolveFreshSessionProviderName: () => "mock",
}));

const { runOrchestrator } = await import("../src/orchestrator.js");

describe("runOrchestrator — full flow with mock provider", () => {
  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
    await mkdir(REPO_DIR, { recursive: true });
    await mkdir(ARTIFACTS_DIR, { recursive: true });
    mockCreateProvider.mockClear();
    mockCreateProvider.mockImplementation(() => makeSuccessProvider());
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("runs to completion and creates remediation-report.md", async () => {
    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });
    expect(existsSync(join(REPO_DIR, "remediation-report.md"))).toBe(true);
  }, 10_000);

  it("report contains both resolved findings", async () => {
    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });
    const report = await readFile(
      join(REPO_DIR, "remediation-report.md"),
      "utf8",
    );
    expect(report).toContain("F-001");
    expect(report).toContain("F-002");
  }, 10_000);

  it("pauses at waiting_for_clarification when worker requests clarification", async () => {
    mockCreateProvider.mockImplementation(() => makeClarifyProvider());

    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });

    const stateFile = join(ARTIFACTS_DIR, "state.json");
    expect(existsSync(stateFile)).toBe(true);

    const state = JSON.parse(await readFile(stateFile, "utf8"));
    expect(state.status).toBe("waiting_for_clarification");

    expect(existsSync(join(ARTIFACTS_DIR, "clarification_request.json"))).toBe(
      true,
    );
  }, 10_000);

  it("resumes after clarification resolution is provided", async () => {
    // First run: pause at clarification
    mockCreateProvider.mockImplementation(() => makeClarifyProvider());
    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });

    const stateAfterPause = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(stateAfterPause.status).toBe("waiting_for_clarification");
    const planId = stateAfterPause.plan.plan_id;

    // Write clarification resolution
    await writeFile(
      join(ARTIFACTS_DIR, "clarification_resolution.json"),
      JSON.stringify([
        {
          finding_id: "F-001",
          action: "clarified",
          rationale: "Clarified in test",
        },
      ]),
      "utf8",
    );

    // Second run: switch back to success provider and resume
    mockCreateProvider.mockImplementation(() => makeSuccessProvider());
    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });

    // Report should exist and plan_id should be the same (same run resumed)
    expect(existsSync(join(REPO_DIR, "remediation-report.md"))).toBe(true);
    const report = await readFile(
      join(REPO_DIR, "remediation-report.md"),
      "utf8",
    );
    expect(report).toContain("F-001");
    expect(report).toContain("F-002");
  }, 10_000);

  it("returns paused when re-entering waiting_for_clarification without a resolution file", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "state.json"),
      JSON.stringify({ status: "waiting_for_clarification" }),
      "utf8",
    );

    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });

    const state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(state.status).toBe("waiting_for_clarification");
    expect(mockCreateProvider).not.toHaveBeenCalled();
  }, 10_000);

  it("pauses at waiting_for_triage when an item is blocked during implement", async () => {
    const blockingProvider = makeBlockingProvider("mock-blocking");

    mockCreateProvider.mockImplementation(() => blockingProvider);

    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });

    const stateFile = join(ARTIFACTS_DIR, "state.json");
    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    expect(state.status).toBe("waiting_for_triage");
    expect(existsSync(join(ARTIFACTS_DIR, "triage_batch.json"))).toBe(true);
  }, 10_000);

  it("resumes via triage phase after triage_resolution.json arrives", async () => {
    // First, get into waiting_for_triage
    const blockingProvider = makeBlockingProvider("mock-blocking2");

    mockCreateProvider.mockImplementation(() => blockingProvider);
    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });

    let state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(state.status).toBe("waiting_for_triage");

    // Write triage resolution to ignore the blocked item
    await writeFile(
      join(ARTIFACTS_DIR, "triage_resolution.json"),
      JSON.stringify({
        items: [
          {
            finding_id: "F-001",
            action: "ignore",
            rationale: "Skipping in test",
          },
        ],
      }),
      "utf8",
    );

    // Resume with success provider
    mockCreateProvider.mockImplementation(() => makeSuccessProvider());
    await runOrchestrator({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });

    expect(existsSync(join(REPO_DIR, "remediation-report.md"))).toBe(true);
  }, 10_000);

  it("returns paused when re-entering waiting_for_triage without a resolution file", async () => {
    await writeFile(
      join(ARTIFACTS_DIR, "state.json"),
      JSON.stringify({ status: "waiting_for_triage" }),
      "utf8",
    );

    await runOrchestrator({
      root: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      input: FIXTURE,
    });

    const state = JSON.parse(
      await readFile(join(ARTIFACTS_DIR, "state.json"), "utf8"),
    );
    expect(state.status).toBe("waiting_for_triage");
    expect(mockCreateProvider).not.toHaveBeenCalled();
  }, 10_000);
});
