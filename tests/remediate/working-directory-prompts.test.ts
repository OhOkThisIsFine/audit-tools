/**
 * FINDING-008: Generated prompts must be explicit about the repository root
 * and must tell workers to set the shell/tool workdir explicitly, rather than
 * relying on leaked cwd state from prior Bash or PowerShell calls.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import {
  prepareImplementDispatch,
} from "../../src/remediate/steps/dispatch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-workdir-prompts");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

function makeImplementingState(): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-WD",
      findings: [
        {
          id: "F-001",
          title: "First",
          category: "correctness",
          severity: "high",
          confidence: "high",
          lens: "correctness",
          summary: "Fix first.",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["evidence"],
        },
      ],
      blocks: [
        { block_id: "B-001", items: ["F-001"], parallel_safe: true },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-001": {
        finding_id: "F-001",
        status: "pending",
        block_id: "B-001",
        item_spec: {
          finding_id: "F-001",
          concrete_change: "fix it",
          no_change: false,
          touched_files: ["src/a.ts"],
          tests_to_write: [{ name: "test1", assertions: ["passes"] }],
          not_applicable_steps: [],
        },
      },
    },
    closing_plan: { action: "none" },
  } as RemediationState;
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("implement worker prompts — workdir explicitness (FINDING-008)", () => {
  it("includes the repository root in the implement worker prompt", async () => {
    const state = makeImplementingState();
    await saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-WD",
    );

    expect(plan.items).toHaveLength(1);
    const { readFileSync } = await import("node:fs");
    const prompt = readFileSync(plan.items[0].prompt_path, "utf8");

    expect(prompt).toMatch(/Repository root:/i);
    expect(prompt).toContain(REPO_DIR.replace(/\\/g, "/"));
  });

  it("tells implement workers to set workdir to the repository root", async () => {
    const state = makeImplementingState();
    await saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-WD",
    );

    const { readFileSync } = await import("node:fs");
    const prompt = readFileSync(plan.items[0].prompt_path, "utf8");

    // Must explicitly tell the worker to set workdir, NOT rely on cwd state.
    expect(prompt).toMatch(/workdir|working.?dir/i);
    expect(prompt).not.toMatch(/current working directory/i);
  });

  it("implement worker prompt does not instruct workers to use `cd`", async () => {
    const state = makeImplementingState();
    await saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-WD",
    );

    const { readFileSync } = await import("node:fs");
    const prompt = readFileSync(plan.items[0].prompt_path, "utf8");

    expect(prompt).not.toMatch(/\bcd\s+["'`]?\//);
  });
});

describe("dispatch plan — slash-safe host-facing paths (FINDING-004 + FINDING-008)", () => {
  it("implement dispatch plan repo_root and artifacts_dir use forward slashes", async () => {
    const state = makeImplementingState();
    await saveState(state);

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-WD",
    );

    expect(plan.repo_root).not.toContain("\\");
    expect(plan.artifacts_dir).not.toContain("\\");
  });
});

describe("writeCurrentStep — slash-safe step contract JSON (FINDING-004)", () => {
  it("step contract JSON exposes prompt_path without backslashes", async () => {
    const { writeCurrentStep } = await import("../../src/remediate/steps/stepWriter.js");
    const step = await writeCurrentStep({
      stepKind: "collect_starting_point",
      status: "blocked",
      runId: "RUN-1",
      // Simulate Windows-style absolute paths.
      repoRoot: "C:\\Code\\my-repo",
      artifactsDir: ARTIFACTS_DIR,
      prompt: "Test prompt.",
      allowedCommands: [],
      stopCondition: "Stop after done.",
    });

    expect(step.repo_root).not.toContain("\\");
    expect(step.repo_root).toBe("C:/Code/my-repo");
    expect(step.prompt_path).not.toContain("\\");
    expect(step.artifacts_dir).not.toContain("\\");
  });

  it("step contract JSON exposes artifact_paths without backslashes", async () => {
    const { writeCurrentStep } = await import("../../src/remediate/steps/stepWriter.js");
    const step = await writeCurrentStep({
      stepKind: "collect_starting_point",
      status: "blocked",
      runId: "RUN-1",
      repoRoot: REPO_DIR,
      artifactsDir: ARTIFACTS_DIR,
      prompt: "Test prompt.",
      allowedCommands: [],
      stopCondition: "Stop after done.",
      artifactPaths: {
        source_manifest: "C:\\Code\\my-repo\\.audit-tools\\remediation\\intake\\source-manifest.json",
      },
    });

    for (const value of Object.values(step.artifact_paths)) {
      expect(value).not.toContain("\\");
    }
  });
});
