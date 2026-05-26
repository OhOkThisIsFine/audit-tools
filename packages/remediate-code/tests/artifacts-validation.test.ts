import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore, type RemediationState } from "../src/state/store.js";
import { validateArtifacts } from "../src/validation/artifacts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-artifact-validation");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".remediation-artifacts");

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
  blocks: [{ block_id: "B-001", items: ["F-001"], parallel_safe: true }],
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
