import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

describe("host-dispatch backlog fixes — dependencies, skip, access", () => {
  const opts = () => ({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });

  it("recomputes block access from the documented item_spec touched_files", async () => {
    const state = makeDocumentingState();
    state.items!["F-001"].item_spec!.touched_files = ["src/relocated.ts", "src/a.ts"];
    await saveState(state);

    const plan = await prepareImplementDispatch(opts(), "RUN-1");
    const b1 = plan.items.find((i) => i.block_id === "B-001")!;
    expect(b1.access!.write_paths).toContain("src/relocated.ts");
    expect(b1.access!.write_paths).toContain("src/a.ts");
  });

  it("defers a dependent block until its dependency resolves (separate waves)", async () => {
    const state = makeDocumentingState();
    state.plan!.blocks[1].dependencies = ["B-001"];
    state.plan!.blocks[1].parallel_safe = false;
    await saveState(state);

    const wave1 = await prepareImplementDispatch(opts(), "RUN-1");
    const w1 = wave1.items.map((i) => i.block_id);
    expect(w1).toContain("B-001");
    expect(w1).not.toContain("B-002");

    state.items!["F-001"].status = "resolved";
    await saveState(state);
    const wave2 = await prepareImplementDispatch(opts(), "RUN-2");
    expect(wave2.items.map((i) => i.block_id)).toContain("B-002");
  });

  it("excludes a skipped item from its block's implement prompt", async () => {
    const state = makeDocumentingState();
    state.plan!.blocks = [
      { block_id: "B-001", items: ["F-001", "F-002"], parallel_safe: true },
    ];
    state.items!["F-001"].block_id = "B-001";
    state.items!["F-002"].block_id = "B-001";
    state.items!["F-002"].status = "deemed_inappropriate";
    await saveState(state);

    const plan = await prepareImplementDispatch(opts(), "RUN-1");
    const b1 = plan.items.find((i) => i.block_id === "B-001")!;
    const prompt = await readFile(b1.prompt_path, "utf8");
    expect(prompt).toContain("F-001");
    expect(prompt).not.toContain("F-002");
  });

  it("merge does not resurrect a deemed_inappropriate (skipped) item", async () => {
    const state = makeDocumentingState();
    state.items!["F-002"].status = "deemed_inappropriate";
    await saveState(state);

    const plan = await prepareImplementDispatch(opts(), "RUN-1");
    const b1 = plan.items.find((i) => i.block_id === "B-001")!;
    expect(plan.items.map((i) => i.block_id)).not.toContain("B-002");

    await writeFile(
      b1.result_path,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          { finding_id: "F-001", status: "resolved", evidence: ["done"] },
          { finding_id: "F-002", status: "resolved", evidence: ["sneaky"] },
        ],
      }),
      "utf8",
    );
    const merged = await mergeImplementResults(opts(), "RUN-1");
    expect(merged.items!["F-002"].status).toBe("deemed_inappropriate");
    expect(merged.items!["F-001"].status).toBe("resolved");
  });

  it("pulls test files that reference a block's source into its access", async () => {
    const state = makeDocumentingState();
    state.plan!.findings[0].affected_files = [{ path: "src/widget.ts" }];
    await saveState(state);
    await mkdir(join(REPO_DIR, "src"), { recursive: true });
    await writeFile(
      join(REPO_DIR, "src", "widget.test.ts"),
      `import { Widget } from "./widget.js";\ntest("widget", () => new Widget());\n`,
      "utf8",
    );

    const plan = await prepareImplementDispatch(opts(), "RUN-1");
    const b1 = plan.items.find((i) => i.block_id === "B-001")!;
    expect(
      b1.access!.write_paths.some((p) => p.endsWith("widget.test.ts")),
    ).toBe(true);
  });

  it("a missing worker result does not flip a skipped item to blocked", async () => {
    const state = makeDocumentingState();
    state.plan!.blocks = [
      { block_id: "B-001", items: ["F-001", "F-002"], parallel_safe: true },
    ];
    state.items!["F-001"].block_id = "B-001";
    state.items!["F-002"].block_id = "B-001";
    state.items!["F-002"].status = "deemed_inappropriate";
    await saveState(state);

    await prepareImplementDispatch(opts(), "RUN-1");
    // No result file is written for B-001.
    const merged = await mergeImplementResults(opts(), "RUN-1");
    expect(merged.items!["F-001"].status).toBe("blocked"); // awaited the result
    expect(merged.items!["F-002"].status).toBe("deemed_inappropriate"); // not flipped
  });

  it("defers a block whose touched_files overlap another block in the same wave", async () => {
    const state = makeDocumentingState();
    // Both document workers relocated their fix to the SAME new file.
    state.items!["F-001"].item_spec!.touched_files = ["src/shared-new.ts"];
    state.items!["F-002"].item_spec!.touched_files = ["src/shared-new.ts"];
    await saveState(state);

    const plan = await prepareImplementDispatch(opts(), "RUN-1");
    const blocks = plan.items.map((i) => i.block_id);
    expect(blocks).toHaveLength(1); // one deferred to a later wave
    expect(["B-001", "B-002"]).toContain(blocks[0]);
  });
});
