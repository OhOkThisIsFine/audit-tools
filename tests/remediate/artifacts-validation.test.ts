import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore, type RemediationState } from "../../src/remediate/state/store.js";
import { validateArtifacts } from "../../src/remediate/validation/artifacts.js";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-artifact-validation");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

const plan = {
  plan_id: "PLAN-1",
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
      evidence: ["src/a.ts:1 evidence"],
    },
  ],
  blocks: [
    {
      block_id: "B-001",
      items: ["F-001"],
      parallel_safe: true,
      touched_files: ["src/a.ts"],
    },
  ],
  project_type: "unknown",
  candidate_closing_actions: ["none"],
};

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function saveState(overrides: Partial<RemediationState> = {}): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState({
    status: "planning",
    plan,
    items: {
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
    },
    closing_plan: { action: "none" },
    ...overrides,
  } as RemediationState);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("validateArtifacts", () => {
  it("passes a minimal valid runtime state", async () => {
    await saveState();

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.status).toBe("ok");
    expect(result.issues).toEqual([]);
  });

});

describe("validateCurrentStep (ValidationIssue[] return style)", () => {
  it("returns issues when required string fields are missing", async () => {
    // Access via validateArtifacts integration: write a malformed current-step.json
    await saveState();
    await writeJson(join(ARTIFACTS_DIR, "steps", "current-step.json"), {
      // missing contract_version, step_kind, status, etc.
      not_a_step: true,
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.status).toBe("error");
    expect(result.issues.join("\n")).toMatch(/contract_version|step_kind|status/i);
  });

  /** A current-step object that is well-formed apart from `run_id`'s value. */
  async function writeWellFormedStep(runId: unknown): Promise<void> {
    const { REMEDIATION_STEP_CONTRACT_VERSION } = await import("../../src/remediate/steps/types.js");
    const promptPath = join(ARTIFACTS_DIR, "steps", "current-prompt.md");
    await mkdir(join(ARTIFACTS_DIR, "steps"), { recursive: true });
    await writeFile(promptPath, "# prompt\n", "utf8");
    await writeJson(join(ARTIFACTS_DIR, "steps", "current-step.json"), {
      contract_version: REMEDIATION_STEP_CONTRACT_VERSION,
      step_kind: "implement",
      status: "ready",
      prompt_path: promptPath,
      /** The nullable field under test — spelled explicitly, `undefined` included. */
      run_id: runId,
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      stop_condition: "done",
      allowed_commands: ["npm test"],
      artifact_paths: {},
    });
  }

  function stepIssuesOf(result: { issues: string[] }): string[] {
    return result.issues.filter((i) => i.includes("current-step.json"));
  }

  it("does not report issues for a well-formed current-step object", async () => {
    await saveState();
    await writeWellFormedStep("run-1");

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    // current-step issues shouldn't appear in the output
    expect(stepIssuesOf(result)).toHaveLength(0);
  });

  // `RemediationStep.run_id` is `string | null`: a planless complete run names
  // no run and writes `null` (the legacy `"run"` fallback key is gone). The
  // validator demanding a string rejected the tool's own just-written step, so
  // such a run reported itself broken for having told the truth.
  it("accepts a NULL run_id — the planless complete step the tool itself writes", async () => {
    await saveState();
    await writeWellFormedStep(null);

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(stepIssuesOf(result)).toHaveLength(0);
  });

  // The other half: nullability is not permissiveness. An ABSENT run_id is a
  // different answer from a null one and is still an issue.
  it("still reports an ABSENT run_id", async () => {
    await saveState();
    await writeWellFormedStep(undefined);

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(stepIssuesOf(result).join("\n")).toMatch(/run_id must be a string or null/);
  });
});
