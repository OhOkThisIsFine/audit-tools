import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";
import {
  mergeDocumentResults,
  mergeImplementResults,
  prepareDocumentDispatch,
  prepareImplementDispatch,
} from "../src/steps/dispatch.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../src/steps/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-dispatch-reconcile");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".remediation-artifacts");

function makePlanningState(): RemediationState {
  return {
    status: "planning",
    plan: {
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
          evidence: ["evidence"],
        },
        {
          id: "F-002",
          title: "Second",
          category: "tests",
          severity: "low",
          confidence: "medium",
          lens: "style",
          summary: "Fix second.",
          affected_files: [{ path: "src/b.ts" }],
          evidence: ["evidence"],
        },
      ],
      blocks: [
        { block_id: "B-001", items: ["F-001"], parallel_safe: true },
        { block_id: "B-002", items: ["F-002"], parallel_safe: true },
      ],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      "F-001": { finding_id: "F-001", status: "pending", block_id: "B-001" },
      "F-002": { finding_id: "F-002", status: "pending", block_id: "B-002" },
    },
    closing_plan: { action: "none" },
  } as RemediationState;
}

function makeDocumentingState(): RemediationState {
  const state = makePlanningState();
  state.status = "documenting";
  state.items!["F-001"].status = "documented";
  state.items!["F-001"].item_spec = {
    finding_id: "F-001",
    concrete_change: "fix it",
    tests_to_write: [{ name: "test1", assertions: ["passes"] }],
    not_applicable_steps: [],
  };
  state.items!["F-002"].status = "documented";
  state.items!["F-002"].item_spec = {
    finding_id: "F-002",
    concrete_change: "fix it too",
    tests_to_write: [{ name: "test2", assertions: ["passes"] }],
    not_applicable_steps: [],
  };
  return state;
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

describe("prepareDocumentDispatch reconciliation", () => {
  it("skips items with existing valid result files", async () => {
    const state = makePlanningState();
    await saveState(state);

    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "document");
    await mkdir(resultDir, { recursive: true });

    const validResult = {
      type: "item_spec",
      item_spec: {
        finding_id: "F-001",
        concrete_change: "fix it",
        tests_to_write: [{ name: "test1", assertions: ["passes"] }],
        not_applicable_steps: [],
      },
    };
    await writeFile(
      join(resultDir, "document-F-001.result.json"),
      JSON.stringify(validResult),
    );

    const plan = await prepareDocumentDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(plan.items.map((i) => i.finding_id)).toEqual(["F-002"]);
  });

  it("re-dispatches items with corrupt result files", async () => {
    const state = makePlanningState();
    await saveState(state);

    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "document");
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(resultDir, "document-F-001.result.json"),
      "not valid json{{{",
    );

    const plan = await prepareDocumentDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(plan.items.map((i) => i.finding_id)).toEqual(["F-001", "F-002"]);
  });

  it("returns empty items when all results exist", async () => {
    const state = makePlanningState();
    await saveState(state);

    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "document");
    await mkdir(resultDir, { recursive: true });

    for (const id of ["F-001", "F-002"]) {
      await writeFile(
        join(resultDir, `document-${id}.result.json`),
        JSON.stringify({
          type: "item_spec",
          item_spec: {
            finding_id: id,
            concrete_change: "fix",
            tests_to_write: [],
            not_applicable_steps: [],
          },
        }),
      );
    }

    const plan = await prepareDocumentDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(plan.items).toEqual([]);
  });

  it("merges valid existing result files even when they were skipped from dispatch", async () => {
    const state = makePlanningState();
    await saveState(state);

    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "document");
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(resultDir, "document-F-001.result.json"),
      JSON.stringify({
        type: "item_spec",
        item_spec: {
          finding_id: "F-001",
          concrete_change: "fix",
          tests_to_write: [],
          not_applicable_steps: [],
        },
      }),
    );

    await prepareDocumentDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
      "F-001",
    );
    const merged = await mergeDocumentResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(merged.items?.["F-001"]).toMatchObject({
      status: "documented",
      item_spec: { finding_id: "F-001" },
    });
  });
});

describe("prepareImplementDispatch reconciliation", () => {
  it("skips blocks with existing valid result files", async () => {
    const state = makeDocumentingState();
    await saveState(state);

    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });

    const validResult = {
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [
        { finding_id: "F-001", status: "resolved", evidence: ["done"] },
      ],
    };
    await writeFile(
      join(resultDir, "implement-B-001.result.json"),
      JSON.stringify(validResult),
    );

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(plan.items.map((i) => i.block_id)).toEqual(["B-002"]);
  });

  it("re-dispatches blocks with invalid result files", async () => {
    const state = makeDocumentingState();
    await saveState(state);

    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(resultDir, "implement-B-001.result.json"),
      JSON.stringify({ contract_version: "wrong", phase: "implement", item_results: [] }),
    );

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(plan.items.map((i) => i.block_id)).toEqual(["B-001", "B-002"]);
  });

  it("merges valid existing result files even when they were skipped from implementation dispatch", async () => {
    const state = makeDocumentingState();
    await saveState(state);

    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(resultDir, "implement-B-001.result.json"),
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          { finding_id: "F-001", status: "resolved", evidence: ["done"] },
        ],
      }),
    );

    await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
      "B-001",
    );
    const merged = await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(merged.items?.["F-001"]).toMatchObject({
      status: "resolved",
      last_successful_step: "Verify Code Against Documentation",
    });
  });
});

describe("mergeImplementResults per-item validation", () => {
  const runId = "PLAN-1";

  // Write an implement dispatch-plan referencing block B-001 plus a result file
  // with the given (malformed) item_results payload, then run mergeImplementResults.
  // validateImplementWorkerResult is module-private, so this drives it through
  // the public merge path. The contract_version/phase are valid so the per-item
  // checks are what reject the input.
  async function mergeWithItemResults(itemResults: unknown): Promise<void> {
    await saveState(makeDocumentingState());

    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });
    const resultPath = join(resultDir, "implement-B-001.result.json");

    await writeFile(
      join(resultDir, "dispatch-plan.json"),
      JSON.stringify({
        contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
        phase: "implement",
        run_id: runId,
        repo_root: REPO_DIR,
        artifacts_dir: ARTIFACTS_DIR,
        items: [
          {
            task_id: "implement-B-001",
            block_id: "B-001",
            prompt_path: join(resultDir, "implement-B-001.md"),
            result_path: resultPath,
          },
        ],
      }),
    );

    await writeFile(
      resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: itemResults,
      }),
    );

    await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );
  }

  it("throws when item_results is not an array", async () => {
    await expect(mergeWithItemResults({} as unknown)).rejects.toThrow(
      /item_results must be an array/,
    );
  });

  it("throws when an item_results entry is not an object", async () => {
    await expect(mergeWithItemResults(["not-an-object"])).rejects.toThrow(
      /item_results\[0\] must be an object/,
    );
  });

  it("throws when an entry's finding_id is not a string", async () => {
    await expect(
      mergeWithItemResults([{ finding_id: 123, status: "resolved" }]),
    ).rejects.toThrow(/finding_id must be a string/);
  });

  it("throws when an entry's status is neither resolved nor blocked", async () => {
    await expect(
      mergeWithItemResults([{ finding_id: "F-001", status: "maybe" }]),
    ).rejects.toThrow(/status must be resolved or blocked/);
  });
});
