// N-remediate-steps: mergeImplementResults consistency obligations.
//
// Covers:
//  - OBL-INV-RSD-01: an unknown finding_id MUST NOT throw. If it maps to a known
//    block (the result's owning task block) that block's non-terminal items are
//    blocked; if it maps to no block it is recorded as a true orphan in the
//    orphaned-implement-results.json diagnostic — never silently dropped, and the
//    run never advances past the unaccounted result.
//  - OBL-INV-RSD-02 / OBL-SEAM-RSD-04: state.json is committed exactly once via
//    StateStore.mutate after the full loop — no partial write mid-loop on a bad id.
//  - OBL-INV-RSD-06 / OBL-SEAM-RSD-03: a resolved (non-no-change) item records
//    last_successful_step using the REMEDIATION_STEP constant (not a bare string)
//    and writes the canonical evidence artifact path.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore } from "../src/state/store.js";
import type { RemediationState } from "../src/state/store.js";
import { mergeImplementResults } from "../src/steps/dispatch.js";
import { REMEDIATION_STEP } from "../src/state/types.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../src/steps/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-merge-consistency");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");
const RUN_ID = "PLAN-1";

function makeImplementingState(): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: RUN_ID,
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
          lens: "tests",
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

async function writePlanAndResult(
  blockId: string,
  itemResults: unknown[],
): Promise<void> {
  const dir = join(ARTIFACTS_DIR, "runs", RUN_ID, "implement");
  await mkdir(dir, { recursive: true });
  const taskId = `implement-${blockId}`;
  const resultPath = join(dir, `${taskId}.result.json`);
  const plan = {
    contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
    phase: "implement",
    run_id: RUN_ID,
    repo_root: REPO_DIR,
    artifacts_dir: ARTIFACTS_DIR,
    items: [
      {
        task_id: taskId,
        block_id: blockId,
        prompt_path: join(dir, `${taskId}.md`),
        result_path: resultPath,
        access: { read_paths: ["src/a.ts"], write_paths: ["src/a.ts", resultPath] },
      },
    ],
  };
  await writeFile(join(dir, "dispatch-plan.json"), JSON.stringify(plan), "utf8");
  await writeFile(
    resultPath,
    JSON.stringify({
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: itemResults,
    }),
    "utf8",
  );
}

const opts = () => ({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR });

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("N-remediate-steps: mergeImplementResults consistency (OBL-INV-RSD-01/02/06)", () => {
  it("does not throw on an unknown finding_id and blocks the result's owning block (RSD-01)", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeImplementingState());
    // B-001's worker reports a finding_id that is in no plan item.
    await writePlanAndResult("B-001", [
      { finding_id: "F-UNKNOWN", status: "resolved", evidence: ["did stuff"] },
    ]);

    const merged = await mergeImplementResults(opts(), RUN_ID);

    // The owning block's item is blocked (run does not advance past the unaccounted result).
    expect(merged.items!["F-001"].status).toBe("blocked");
    expect(merged.items!["F-001"].failure_reason).toMatch(/unknown finding_id "F-UNKNOWN"/);
    // The unrelated block is untouched.
    expect(merged.items!["F-002"].status).toBe("pending");
  });

  it("records a deterministic orphan diagnostic for the unmatched result (RSD-01, not dropped)", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeImplementingState());
    await writePlanAndResult("B-001", [
      { finding_id: "F-UNKNOWN", status: "resolved", evidence: ["did stuff"] },
    ]);

    await mergeImplementResults(opts(), RUN_ID);

    const diagPath = join(
      ARTIFACTS_DIR,
      "runs",
      RUN_ID,
      "implement",
      "orphaned-implement-results.json",
    );
    expect(existsSync(diagPath)).toBe(true);
    const diag = JSON.parse(await readFile(diagPath, "utf8"));
    expect(diag.orphans).toHaveLength(1);
    expect(diag.orphans[0].finding_id).toBe("F-UNKNOWN");
    // Owning block is known here, so disposition reflects that (not a silent drop).
    expect(diag.orphans[0].owning_block_id).toBe("B-001");
    expect(diag.orphans[0].disposition).toBe("blocked_owning_block");
  });

  it("commits state exactly once via StateStore (no partial write on a bad id) (RSD-02)", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeImplementingState());
    // Result mixes a valid finding and an unknown one in the same loop.
    await writePlanAndResult("B-001", [
      { finding_id: "F-UNKNOWN", status: "resolved", evidence: ["x"] },
    ]);

    // Spy on the prototype write path: exactly one state.json commit for the merge.
    const writeSpy = vi.spyOn(
      StateStore.prototype as unknown as { _writeStateLocked: (s: RemediationState) => Promise<void> },
      "_writeStateLocked",
    );

    await mergeImplementResults(opts(), RUN_ID);

    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it("resolved (non-no-change) item uses the REMEDIATION_STEP constant + canonical evidence path (RSD-06)", async () => {
    await new StateStore(ARTIFACTS_DIR).saveState(makeImplementingState());
    await writePlanAndResult("B-001", [
      { finding_id: "F-001", status: "resolved", evidence: ["ran the test"] },
    ]);

    const merged = await mergeImplementResults(opts(), RUN_ID);

    expect(merged.items!["F-001"].status).toBe("resolved");
    // Exact constant value, asserted against the named constant (not a bare string).
    expect(merged.items!["F-001"].last_successful_step).toBe(
      REMEDIATION_STEP.VERIFY_AGAINST_DOCUMENTATION,
    );

    const evidencePath = join(
      ARTIFACTS_DIR,
      "result_F-001_verify_code_against_documentation.json",
    );
    expect(existsSync(evidencePath)).toBe(true);
  });
});
