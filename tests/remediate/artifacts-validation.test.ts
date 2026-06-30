import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore, type RemediationState } from "../../src/remediate/state/store.js";
import { validateArtifacts, validateImplementWorkerResult } from "../../src/remediate/validation/artifacts.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-artifact-validation");
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

  it("catches malformed implement worker results referenced by a dispatch plan", async () => {
    await saveState();
    const runDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    const promptPath = join(runDir, "implement-B-001.md");
    const resultPath = join(runDir, "implement-B-001.result.json");
    await mkdir(runDir, { recursive: true });
    await writeFile(promptPath, "# Implement\n", "utf8");
    await writeJson(join(runDir, "dispatch-plan.json"), {
      contract_version: "remediate-code-dispatch-plan/v1alpha1",
      phase: "implement",
      run_id: "PLAN-1",
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      items: [
        {
          task_id: "implement-B-001",
          block_id: "B-001",
          prompt_path: promptPath,
          result_path: resultPath,
        },
      ],
    });
    await writeJson(resultPath, {
      contract_version: "wrong",
      phase: "implement",
      item_results: [{ finding_id: 7, status: "done" }],
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.status).toBe("error");
    expect(result.issues.join("\n")).toMatch(/implement worker result/i);
    expect(result.issues.join("\n")).toMatch(/unsupported contract_version/i);
  });

  it("catches stale worker results that no dispatch plan references", async () => {
    await saveState();
    const stalePath = join(
      ARTIFACTS_DIR,
      "runs",
      "PLAN-1",
      "document",
      "stale.result.json",
    );
    await writeJson(stalePath, {
      type: "item_spec",
      item_spec: {
        finding_id: "F-001",
        concrete_change: "Stale draft.",
        tests_to_write: [],
        not_applicable_steps: [],
      },
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.status).toBe("error");
    expect(result.issues.join("\n")).toMatch(/Stale worker result/);
    expect(result.issues.join("\n")).toContain(stalePath);
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

  it("does not report issues for a well-formed current-step object", async () => {
    const { REMEDIATION_STEP_CONTRACT_VERSION } = await import("../../src/remediate/steps/types.js");
    await saveState();
    const promptPath = join(ARTIFACTS_DIR, "steps", "current-prompt.md");
    await mkdir(join(ARTIFACTS_DIR, "steps"), { recursive: true });
    await writeFile(promptPath, "# prompt\n", "utf8");
    await writeJson(join(ARTIFACTS_DIR, "steps", "current-step.json"), {
      contract_version: REMEDIATION_STEP_CONTRACT_VERSION,
      step_kind: "implement",
      status: "ready",
      prompt_path: promptPath,
      run_id: "run-1",
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      stop_condition: "done",
      allowed_commands: ["npm test"],
      artifact_paths: {},
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    // current-step issues shouldn't appear in the output
    const stepIssues = result.issues.filter((i) => i.includes("current-step.json"));
    expect(stepIssues).toHaveLength(0);
  });
});

describe("validateImplementWorkerResult (exported, ValidationIssue[] return style)", () => {
  it("is exported from artifacts.ts and importable", () => {
    expect(typeof validateImplementWorkerResult).toBe("function");
  });

  it("returns issues when item_results array is missing", () => {
    const issues = validateImplementWorkerResult(
      { contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION, phase: "implement" },
      "test-path",
    );
    const errorIssues = issues.filter((i) => i.severity === "error");
    expect(errorIssues.length).toBeGreaterThan(0);
    expect(errorIssues.map((i) => i.message).join(" ")).toMatch(/item_results/i);
  });

  it("returns issues when phase is not implement", () => {
    const issues = validateImplementWorkerResult(
      {
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "document",
        item_results: [],
      },
      "test-path",
    );
    const errorIssues = issues.filter((i) => i.severity === "error");
    expect(errorIssues.map((i) => i.message).join(" ")).toMatch(/phase/i);
  });

  it("returns empty issues for a well-formed implement worker result", () => {
    const issues = validateImplementWorkerResult(
      {
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [{ finding_id: "F-001", status: "resolved", evidence: ["done"] }],
      },
      "test-path",
    );
    const errorIssues = issues.filter((i) => i.severity === "error");
    expect(errorIssues).toHaveLength(0);
  });
});

describe("validateDispatchPlan (ValidationIssue[] return style)", () => {
  it("reports issues when contract_version is wrong", async () => {
    await saveState();
    const runDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    await mkdir(runDir, { recursive: true });
    await writeJson(join(runDir, "dispatch-plan.json"), {
      contract_version: "wrong-version",
      phase: "implement",
      run_id: "PLAN-1",
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      items: [],
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.issues.join("\n")).toMatch(/contract_version/i);
  });

  it("reports issues when items array is missing", async () => {
    const { REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION } = await import("../../src/remediate/steps/types.js");
    await saveState();
    const runDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    await mkdir(runDir, { recursive: true });
    await writeJson(join(runDir, "dispatch-plan.json"), {
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "implement",
      run_id: "PLAN-1",
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      // items deliberately omitted
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.issues.join("\n")).toMatch(/items/i);
  });

  it("does not report plan-level issues for a valid dispatch plan with no items", async () => {
    const { REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION } = await import("../../src/remediate/steps/types.js");
    await saveState();
    const runDir = join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement");
    await mkdir(runDir, { recursive: true });
    await writeJson(join(runDir, "dispatch-plan.json"), {
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "implement",
      run_id: "PLAN-1",
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      items: [],
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    // no contract_version / items / phase issues expected
    const planErrors = result.issues.filter(
      (i) => i.includes("contract_version") || i.includes(".items must") || i.includes(".phase must"),
    );
    expect(planErrors).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Regression: COR-acd27a4f — document phase items must have finding_id;
  // the validator previously only checked block_id for implement phase.
  // -------------------------------------------------------------------------
  it("reports finding_id missing on document dispatch plan item", async () => {
    const { REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION } = await import("../../src/remediate/steps/types.js");
    await saveState();
    const runDir = join(ARTIFACTS_DIR, "runs", "DOC-1", "document");
    await mkdir(runDir, { recursive: true });
    await writeJson(join(runDir, "dispatch-plan.json"), {
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "document",
      run_id: "DOC-1",
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      items: [
        {
          task_id: "TASK-1",
          // finding_id deliberately omitted — should trigger an error
          prompt_path: join(runDir, "doc-TASK-1.md"),
          result_path: join(runDir, "doc-TASK-1.result.json"),
        },
      ],
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    expect(result.issues.join("\n")).toMatch(/finding_id/i);
  });

  it("does not report finding_id missing on document item that has finding_id", async () => {
    const { REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION } = await import("../../src/remediate/steps/types.js");
    await saveState();
    const runDir = join(ARTIFACTS_DIR, "runs", "DOC-2", "document");
    const promptPath = join(runDir, "doc-TASK-2.md");
    await mkdir(runDir, { recursive: true });
    await writeFile(promptPath, "# Document\n", "utf8");
    await writeJson(join(runDir, "dispatch-plan.json"), {
      contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
      phase: "document",
      run_id: "DOC-2",
      repo_root: REPO_DIR,
      artifacts_dir: ARTIFACTS_DIR,
      items: [
        {
          task_id: "TASK-2",
          finding_id: "F-001",
          prompt_path: promptPath,
          result_path: join(runDir, "doc-TASK-2.result.json"),
        },
      ],
    });

    const result = await validateArtifacts(ARTIFACTS_DIR, REPO_DIR);

    const findingIdErrors = result.issues.filter((i) => i.includes("finding_id"));
    expect(findingIdErrors).toHaveLength(0);
  });
});
