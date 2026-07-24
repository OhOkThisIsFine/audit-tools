import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DISPATCH_PROMPT_HANDOFF_NOTE } from "audit-tools/shared";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import {
  prepareImplementDispatch,
} from "../../src/remediate/steps/dispatch.js";
import { decideNextStep } from "../../src/remediate/steps/nextStep.js";
import { scratchDir } from "../helpers/scratch.js";

// Regression: the canonical next-step wave path must inject the
// "match the surrounding code" house-style block into implement
// worker prompts.

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-dispatch-conventions");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

const CONVENTIONS_MARKER = "REPOSITORY CONVENTIONS (match the surrounding code):";

function makePlanningState(): RemediationState {
  return {
    status: "planning",
    plan: {
      plan_id: "PLAN-1",
      findings: [
        {
          id: "F-001",
          title: "Missing input validation",
          category: "security",
          severity: "high",
          confidence: "high",
          lens: "security",
          summary: "Validate the request body.",
          affected_files: [{ path: "src/a.ts" }],
          evidence: ["no validation"],
          theme_id: "THEME-1",
          contract_goal_id: "G1",
          contract_obligation_ids: ["O-1"],
          verification_obligation_ids: ["VO-1"],
          targeted_commands: ["npm test -- auth"],
        },
        {
          id: "F-002",
          title: "Unhandled rejection",
          category: "correctness",
          severity: "low",
          confidence: "medium",
          lens: "correctness",
          summary: "Await the promise.",
          affected_files: [{ path: "src/b.ts" }],
          evidence: ["floating promise"],
        },
      ],
      blocks: [
        { block_id: "B-001", items: ["F-001"], parallel_safe: true },
        { block_id: "B-002", items: ["F-002"], parallel_safe: true },
      ],
      themes: [
        {
          theme_id: "THEME-1",
          title: "Validate external inputs",
          root_cause: "Inputs cross trust boundaries unchecked.",
          finding_ids: ["F-001"],
          suggested_fix_pattern: "Add a zod schema at each boundary.",
        },
      ],
      project_type: "typescript-node",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
      "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
    },
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

function makeImplementingState(): RemediationState {
  const state = makePlanningState();
  state.status = "implementing";
  for (const id of ["F-001", "F-002"]) {
    state.items![id].status = "pending";
    state.items![id].item_spec = {
      finding_id: id,
      concrete_change: "fix it",
      tests_to_write: [{ name: `test-${id}`, assertions: ["passes"] }],
      not_applicable_steps: [],
    };
  }
  return state;
}

async function acknowledgeResume(): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "confirm_resume_ack.json"),
    JSON.stringify({ choice: "resume" }),
    "utf8",
  );
}

async function writeIntentCheckpoint(): Promise<void> {
  await writeFile(
    join(ARTIFACTS_DIR, "intent_checkpoint.json"),
    JSON.stringify({
      schema_version: "intent-checkpoint/v1",
      confirmed_at: new Date().toISOString(),
      scope_summary: "Test scope",
      intent_summary: "Test intent",
      confirmed_by: "host",
    }),
    "utf8",
  );
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(join(REPO_DIR, "src"), { recursive: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
  // A package.json + source file make detectRepoConventions return a non-empty
  // block (esm module style, prettier/eslint/vitest, a sampled snippet).
  await writeFile(
    join(REPO_DIR, "package.json"),
    JSON.stringify({
      name: "fixture",
      type: "module",
      devDependencies: { prettier: "^3", eslint: "^9", vitest: "^2" },
    }),
  );
  await writeFile(
    join(REPO_DIR, "src", "a.ts"),
    "export function a(): void {\n  return;\n}\n",
  );
});

afterEach(async () => {
  delete process.env.REMEDIATE_ROLLING_ENGINE;
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("dispatch prompts carry house style", () => {
  it("implement prompts include repo conventions", async () => {
    await saveState(makeImplementingState());

    await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-1",
    );

    const implDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    const prompt = await readFile(join(implDir, "implement-B-001.md"), "utf8");
    expect(prompt).toContain(CONVENTIONS_MARKER);
    // Repository root is normalized to forward slashes in host-facing prompts (FINDING-004).
    expect(prompt).toContain(`Repository root: ${REPO_DIR.replace(/\\/g, "/")}`);
    expect(prompt).toMatch(/Set the shell\/tool workdir to the repository root/i);
    // Contract goal/obligation ids + provenance-only targeted_commands are
    // worker-irrelevant decoration; the implement prompt no longer re-inlines the
    // Contract Pipeline Traceability section (the runnable per-node commands are
    // emitted separately as the build-free subset).
    expect(prompt).not.toContain("Contract goal: G1");
    expect(prompt).not.toContain("Satisfies obligations: O-1");
    expect(prompt).not.toContain("Verification obligations: VO-1");
  });

  it("implement prompts include attributable verification and PowerShell JSON guidance", async () => {
    await saveState(makeImplementingState());

    await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-1",
    );

    const implDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    const prompt = await readFile(join(implDir, "implement-B-001.md"), "utf8");
    expect(prompt).toMatch(/Run changed or newly created tests by name when possible/i);
    expect(prompt).toMatch(/record the focused\s+command and result/i);
    expect(prompt).toMatch(/broad or full-suite\s+command fails in a dirty worktree/i);
    expect(prompt).toMatch(/focused test for this block fails/i);
    expect(prompt).toMatch(/If targeted commands are listed under an item/i);
    expect(prompt).toMatch(/include each command and result in that item's evidence/i);
    expect(prompt).toMatch(/do not pipe an inline foreach statement directly into ConvertTo-Json/i);
    expect(prompt).toMatch(/Assign the foreach output to a variable first/i);
  });
});

describe("dispatch prompts invite opt-in agent reflections", () => {
  const FEEDBACK_PATH = `${ARTIFACTS_DIR.replace(/\\/g, "/")}/agent-feedback.jsonl`;

  it("implement prompts carry the invitation keyed by block id", async () => {
    await saveState(makeImplementingState());

    await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      "PLAN-1",
    );

    const implDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    const prompt = await readFile(join(implDir, "implement-B-001.md"), "utf8");
    expect(prompt).toContain("## Optional process feedback");
    expect(prompt).toContain(FEEDBACK_PATH);
    expect(prompt).toContain('"task_id": "B-001"');
  });
});

describe("dispatch step prompts carry DISPATCH_PROMPT_HANDOFF_NOTE", () => {
  it("dispatch_implement step prompt includes DISPATCH_PROMPT_HANDOFF_NOTE", async () => {
    await saveState(makeImplementingState());
    await acknowledgeResume();
    await writeIntentCheckpoint();
    // G2: dispatch.rolling_engine is unrepresentable on disk; pin the wave opt-out via
    // the sanctioned env override (cleaned up in afterEach).
    process.env.REMEDIATE_ROLLING_ENGINE = "false";

    const step = await decideNextStep({
      root: REPO_DIR,
      hostCanDispatchSubagents: true,
    });

    expect(step.step_kind).toBe("dispatch_implement");
    const prompt = await readFile(step.prompt_path, "utf8");
    expect(prompt).toContain(DISPATCH_PROMPT_HANDOFF_NOTE);
  });
});
