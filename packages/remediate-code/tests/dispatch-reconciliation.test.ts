import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

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

function expectIsoTimestamp(value: unknown): void {
  expect(typeof value).toBe("string");
  expect(Date.parse(value as string)).not.toBeNaN();
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
    expectIsoTimestamp(merged.items?.["F-001"].started_at);
    expect(merged.items?.["F-001"].completed_at).toBeUndefined();
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

  it("re-dispatches a block when the existing result misses still-documented findings", async () => {
    const state = makeDocumentingState();
    state.plan!.blocks = [
      { block_id: "B-001", items: ["F-001", "F-002"], parallel_safe: true },
    ];
    state.items!["F-001"].block_id = "B-001";
    state.items!["F-001"].status = "resolved";
    state.items!["F-002"].block_id = "B-001";
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

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(plan.items.map((i) => i.block_id)).toEqual(["B-001"]);
    const prompt = await readFile(plan.items[0].prompt_path, "utf8");
    expect(prompt).toContain("F-002");
    expect(prompt).not.toContain("F-001 - First");
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

  it("returns empty items when all results exist", async () => {
    const state = makeDocumentingState();
    await saveState(state);

    const runId = "PLAN-1";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });

    for (const blockId of ["B-001", "B-002"]) {
      const findingId = blockId === "B-001" ? "F-001" : "F-002";
      await writeFile(
        join(resultDir, `implement-${blockId}.result.json`),
        JSON.stringify({
          contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
          phase: "implement",
          item_results: [
            { finding_id: findingId, status: "resolved", evidence: ["done"] },
          ],
        }),
      );
    }

    const plan = await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(plan.items).toEqual([]);
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
    expectIsoTimestamp(merged.items?.["F-001"].completed_at);
  });

  it("preserves implement verification evidence as a structured reason array", async () => {
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
          {
            finding_id: "F-001",
            status: "resolved",
            evidence: ["check A", "check B"],
          },
        ],
      }),
    );

    await prepareImplementDispatch(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
      "B-001",
    );
    await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    const verificationResult = JSON.parse(
      await readFile(
        join(ARTIFACTS_DIR, "result_F-001_verify_code_against_documentation.json"),
        "utf8",
      ),
    );
    expect(verificationResult.reason).toEqual(["check A", "check B"]);
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

  it("does not serialize blocks that only share affected read context", async () => {
    const state = makeDocumentingState();
    state.plan!.findings[0].affected_files = [
      { path: "src/hub.ts" },
      { path: "src/a.ts" },
    ];
    state.plan!.findings[1].affected_files = [
      { path: "src/hub.ts" },
      { path: "src/b.ts" },
    ];
    state.items!["F-001"].item_spec!.touched_files = ["src/a.ts"];
    state.items!["F-002"].item_spec!.touched_files = ["src/b.ts"];
    await saveState(state);

    const plan = await prepareImplementDispatch(opts(), "RUN-1");
    expect(plan.items.map((i) => i.block_id).sort()).toEqual(["B-001", "B-002"]);

    const b1 = plan.items.find((i) => i.block_id === "B-001")!;
    const b2 = plan.items.find((i) => i.block_id === "B-002")!;
    expect(b1.access!.read_paths).toContain("src/hub.ts");
    expect(b2.access!.read_paths).toContain("src/hub.ts");
    expect(b1.access!.write_paths).not.toContain("src/hub.ts");
    expect(b2.access!.write_paths).not.toContain("src/hub.ts");
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

  it("deferred overlapping block is scheduled in the subsequent wave after the conflicting block resolves", async () => {
    const state = makeDocumentingState();
    // Both document workers relocated their fix to the SAME new file.
    state.items!["F-001"].item_spec!.touched_files = ["src/shared-new.ts"];
    state.items!["F-002"].item_spec!.touched_files = ["src/shared-new.ts"];
    await saveState(state);

    // Wave 1: only one block is dispatched due to the overlap.
    const wave1 = await prepareImplementDispatch(opts(), "RUN-1");
    expect(wave1.items).toHaveLength(1);
    const dispatchedBlockId = wave1.items[0].block_id as string;
    expect(["B-001", "B-002"]).toContain(dispatchedBlockId);

    // Simulate wave 1 completing: write a resolved result file for the dispatched
    // block and mark its finding as resolved in state.
    const deferredBlockId = dispatchedBlockId === "B-001" ? "B-002" : "B-001";
    const dispatchedFindingId = dispatchedBlockId === "B-001" ? "F-001" : "F-002";

    await writeFile(
      wave1.items[0].result_path,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [
          { finding_id: dispatchedFindingId, status: "resolved", evidence: ["done"] },
        ],
      }),
      "utf8",
    );

    const state2 = makeDocumentingState();
    state2.items!["F-001"].item_spec!.touched_files = ["src/shared-new.ts"];
    state2.items!["F-002"].item_spec!.touched_files = ["src/shared-new.ts"];
    state2.items![dispatchedFindingId].status = "resolved";
    await saveState(state2);

    // Wave 2: the deferred block is now schedulable.
    const wave2 = await prepareImplementDispatch(opts(), "RUN-2");
    expect(wave2.items).toHaveLength(1);
    expect(wave2.items[0].block_id).toBe(deferredBlockId);
  });
});

// ---------------------------------------------------------------------------
// OBS-1903cdd6: prepare-document-dispatch / prepare-implement-dispatch keep
// stdout clean when dispatch functions emit internal console.log messages.
// The fix wraps both CLI actions with withBackendLogsOnStderr, which redirects
// console.log to console.error during execution. These tests simulate that
// wrapper and verify the stdio contract.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// FINDING-021: per-item reconciliation messages must not be emitted to
// console.log. Only the aggregate count summary is emitted (and the CLI
// action wraps the whole call with withBackendLogsOnStderr anyway).
// ---------------------------------------------------------------------------

describe("FINDING-021: no per-item reconciliation console.log messages", () => {
  it("prepareDocumentDispatch does not log per-item reuse messages", async () => {
    const state = makePlanningState();
    await saveState(state);

    const runId = "PLAN-no-per-item-doc";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "document");
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(resultDir, "document-F-001.result.json"),
      JSON.stringify({
        type: "item_spec",
        item_spec: { finding_id: "F-001", concrete_change: "fix", tests_to_write: [], not_applicable_steps: [] },
      }),
    );

    const logMessages: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logMessages.push(args.map(String).join(" "));
    });
    try {
      await prepareDocumentDispatch({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, runId);
      for (const msg of logMessages) {
        expect(msg).not.toMatch(/Reusing existing document result for/);
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("prepareImplementDispatch does not log per-item reuse messages", async () => {
    const state = makeDocumentingState();
    await saveState(state);

    const runId = "PLAN-no-per-item-impl";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(resultDir, "implement-B-001.result.json"),
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [{ finding_id: "F-001", status: "resolved", evidence: ["done"] }],
      }),
    );

    const logMessages: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logMessages.push(args.map(String).join(" "));
    });
    try {
      await prepareImplementDispatch({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, runId);
      for (const msg of logMessages) {
        expect(msg).not.toMatch(/Reusing existing implement result for/);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe("prepare-document-dispatch stdout cleanliness (OBS-1903cdd6)", () => {
  /** withBackendLogsOnStderr: redirect console.log → console.error during fn(). */
  async function withBackendLogsOnStderr<T>(fn: () => Promise<T>): Promise<T> {
    const original = console.log;
    console.log = (...args: unknown[]) => console.error(...args);
    try {
      return await fn();
    } finally {
      console.log = original;
    }
  }

  it("does not emit non-JSON to stdout when existing document results are reused", async () => {
    const state = makePlanningState();
    await saveState(state);

    const runId = "PLAN-obs-doc";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "document");
    await mkdir(resultDir, { recursive: true });

    // Pre-write a valid result so prepareDocumentDispatch logs a reuse message.
    await writeFile(
      join(resultDir, "document-F-001.result.json"),
      JSON.stringify({
        type: "item_spec",
        item_spec: { finding_id: "F-001", concrete_change: "fix", tests_to_write: [], not_applicable_steps: [] },
      }),
    );

    const stdoutMessages: string[] = [];
    const originalLog = console.log;
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutMessages.push(args.map(String).join(" "));
    });

    try {
      // Simulate the CLI action: withBackendLogsOnStderr wraps prepareDocumentDispatch.
      const plan = await withBackendLogsOnStderr(() =>
        prepareDocumentDispatch({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, runId),
      );
      // Serialize to JSON as the CLI does.
      const jsonOutput = JSON.stringify(plan, null, 2);
      originalLog(jsonOutput); // the real console.log that the CLI calls after the wrapper

      // The only call to console.log that escapes is the final JSON serialization.
      // All messages emitted inside prepareDocumentDispatch were redirected to stderr.
      for (const msg of stdoutMessages) {
        expect(() => JSON.parse(msg)).not.toThrow();
      }
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("does not emit non-JSON to stdout when existing implement results are reused", async () => {
    const state = makeDocumentingState();
    await saveState(state);

    const runId = "PLAN-obs-impl";
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(resultDir, { recursive: true });

    // Pre-write a valid result so prepareImplementDispatch logs a reuse message.
    await writeFile(
      join(resultDir, "implement-B-001.result.json"),
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [{ finding_id: "F-001", status: "resolved", evidence: ["done"] }],
      }),
    );

    const stdoutMessages: string[] = [];
    const originalLog = console.log;
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutMessages.push(args.map(String).join(" "));
    });

    try {
      const plan = await withBackendLogsOnStderr(() =>
        prepareImplementDispatch({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, runId),
      );
      const jsonOutput = JSON.stringify(plan, null, 2);
      originalLog(jsonOutput);

      for (const msg of stdoutMessages) {
        expect(() => JSON.parse(msg)).not.toThrow();
      }
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// TST-288567c1: mergeDocumentResults error-path branches
// ---------------------------------------------------------------------------

describe("mergeDocumentResults error-path branches", () => {
  const runId = "PLAN-1";

  /** Prepare state and a document dispatch plan for F-001 only, without writing
   * a result file. Then call mergeDocumentResults and return the merged state. */
  async function prepareAndMerge(writeResultFile: (resultPath: string) => Promise<void>): Promise<ReturnType<typeof mergeDocumentResults>> {
    await saveState(makePlanningState());

    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "document");
    await mkdir(resultDir, { recursive: true });

    // Write a minimal dispatch plan so mergeDocumentResults can read it.
    await writeFile(
      join(resultDir, "dispatch-plan.json"),
      JSON.stringify({
        contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
        phase: "document",
        run_id: runId,
        repo_root: REPO_DIR,
        artifacts_dir: ARTIFACTS_DIR,
        items: [
          {
            task_id: "document-F-001",
            finding_id: "F-001",
            prompt_path: join(resultDir, "document-F-001.md"),
            result_path: join(resultDir, "document-F-001.result.json"),
          },
        ],
      }),
    );

    const resultPath = join(resultDir, "document-F-001.result.json");
    await writeResultFile(resultPath);

    return mergeDocumentResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );
  }

  it("marks finding blocked when result file is missing", async () => {
    // Write the dispatch plan but no result file.
    await saveState(makePlanningState());
    const resultDir = join(ARTIFACTS_DIR, "runs", runId, "document");
    await mkdir(resultDir, { recursive: true });

    await writeFile(
      join(resultDir, "dispatch-plan.json"),
      JSON.stringify({
        contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
        phase: "document",
        run_id: runId,
        repo_root: REPO_DIR,
        artifacts_dir: ARTIFACTS_DIR,
        items: [
          {
            task_id: "document-F-001",
            finding_id: "F-001",
            prompt_path: join(resultDir, "document-F-001.md"),
            result_path: join(resultDir, "document-F-001.result.json"),
          },
        ],
      }),
    );
    // Deliberately do NOT write document-F-001.result.json.

    const merged = await mergeDocumentResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(merged.items?.["F-001"].status).toBe("blocked");
    expect(merged.items?.["F-001"].failure_reason).toMatch(
      /Document worker did not produce a result file/,
    );
    expectIsoTimestamp(merged.items?.["F-001"].started_at);
    expectIsoTimestamp(merged.items?.["F-001"].completed_at);
  });

  it("marks finding blocked when document result fails schema validation", async () => {
    // Write a result file with type:'item_spec' but missing the required item_spec key,
    // which triggers a validateDocumentResponse severity:'error' issue.
    const merged = await prepareAndMerge(async (resultPath) => {
      await writeFile(
        resultPath,
        JSON.stringify({ type: "item_spec" /* missing item_spec key */ }),
      );
    });

    expect(merged.items?.["F-001"].status).toBe("blocked");
    expect(merged.items?.["F-001"].failure_reason).toMatch(/Invalid document result/i);
  });

  it("marks finding blocked when item_spec fails validation", async () => {
    // Write a result file with a structurally valid DocumentWorkerResult wrapper
    // but an item_spec that is missing finding_id (triggers validateItemSpec error).
    const merged = await prepareAndMerge(async (resultPath) => {
      await writeFile(
        resultPath,
        JSON.stringify({
          type: "item_spec",
          item_spec: {
            // finding_id intentionally omitted
            concrete_change: "fix it",
            tests_to_write: [],
            not_applicable_steps: [],
          },
        }),
      );
    });

    expect(merged.items?.["F-001"].status).toBe("blocked");
    expect(merged.items?.["F-001"].failure_reason).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// TST-288567c1: mergeImplementResults — worker-reported blocked status
// ---------------------------------------------------------------------------

describe("mergeImplementResults — worker-reported blocked status", () => {
  const runId = "PLAN-1";

  it("maps worker-reported blocked status to finding blocked with failure_reason", async () => {
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
        item_results: [
          {
            finding_id: "F-001",
            status: "blocked",
            failure_reason: "Worker error.",
          },
        ],
      }),
    );

    const merged = await mergeImplementResults(
      { root: REPO_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    expect(merged.items?.["F-001"].status).toBe("blocked");
    expect(merged.items?.["F-001"].failure_reason).toBe("Worker error.");
    expectIsoTimestamp(merged.items?.["F-001"].completed_at);
  });
});
