/**
 * CP-BLOCK-N-dispatch-seam — merge-side tolerance.
 *
 * Covers (OBL-DS-08..11):
 *  - `buildBlockAliasMap`: a known obligation id (and node/block aliases) of the
 *    task block maps back to the owning node's finding;
 *  - `collapseItemResults`: alias remap + multi-entry collapse (blocked
 *    dominates resolved; evidence unions); truly-unknown ids stay unresolved;
 *  - end-to-end `mergeImplementResults`: a worker that mislabels its finding_id
 *    as an obligation id still resolves the owning node; multiple entries for the
 *    same node collapse; an entry whose id matches nothing orphans the block.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { Finding, RemediationBlock } from "../../src/remediate/state/types.js";
import {
  prepareImplementDispatch,
  mergeImplementResults,
  buildBlockAliasMap,
  collapseItemResults,
  recordNodeAcceptOutcome,
} from "../../src/remediate/steps/dispatch.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../../src/remediate/steps/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = join(__dirname, ".test-dispatch-tolerance");
const REPO_DIR = join(TEST_DIR, "repo");
const ARTIFACTS_DIR = join(REPO_DIR, ".audit-tools/remediation");

function makeNodeFinding(): Finding {
  return {
    id: "N-x",
    title: "Node X",
    category: "correctness",
    severity: "high",
    confidence: "high",
    lens: "correctness",
    summary: "Do X.",
    affected_files: [{ path: "src/x.ts" }],
    evidence: ["e"],
    contract_obligation_ids: ["OBL-X-01", "OBL-X-02"],
    verification_obligation_ids: ["OBL-X-VERIFY"],
  } as Finding;
}

function makeNodeState(): RemediationState {
  const finding = makeNodeFinding();
  const block: RemediationBlock = {
    block_id: "CP-BLOCK-N-x",
    items: [finding.id],
    parallel_safe: true,
  };
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-1",
      findings: [finding],
      blocks: [block],
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: {
      [finding.id]: {
        finding_id: finding.id,
        status: "pending",
        block_id: block.block_id,
        item_spec: {
          finding_id: finding.id,
          concrete_change: "do x",
          tests_to_write: [{ name: "t", assertions: ["passes"] }],
          not_applicable_steps: [],
        },
      },
    },
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

async function saveState(state: RemediationState): Promise<void> {
  await new StateStore(ARTIFACTS_DIR).saveState(state);
}

/** Write a dispatch-plan + worker result for the single block, then merge. */
async function mergeWith(itemResults: unknown): Promise<RemediationState> {
  const runId = "PLAN-1";
  const resultDir = join(ARTIFACTS_DIR, "runs", runId, "implement");
  await mkdir(resultDir, { recursive: true });
  const resultPath = join(resultDir, "implement-CP-BLOCK-N-x.result.json");
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
          task_id: "implement-CP-BLOCK-N-x",
          block_id: "CP-BLOCK-N-x",
          prompt_path: join(resultDir, "implement-CP-BLOCK-N-x.md"),
          result_path: resultPath,
          access: { read_paths: ["src/x.ts"], write_paths: ["src/x.ts", resultPath] },
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
  return mergeImplementResults({ root: REPO_DIR, artifactsDir: ARTIFACTS_DIR }, runId);
}

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// buildBlockAliasMap
// ---------------------------------------------------------------------------

describe("buildBlockAliasMap", () => {
  it("maps obligation ids, the block id, and the prefixed node alias to the owning finding", () => {
    const state = makeNodeState();
    const block = state.plan!.blocks[0];
    const map = buildBlockAliasMap(block, state);
    expect(map.get("OBL-X-01")).toBe("N-x");
    expect(map.get("OBL-X-02")).toBe("N-x");
    expect(map.get("OBL-X-VERIFY")).toBe("N-x");
    expect(map.get("CP-BLOCK-N-x")).toBe("N-x");
    // The bare node id is the canonical finding id; it is not an alias entry.
    expect(map.has("N-x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collapseItemResults
// ---------------------------------------------------------------------------

describe("collapseItemResults", () => {
  const known = new Set(["N-x"]);
  function aliasMap(): Map<string, string> {
    return new Map([
      ["OBL-X-01", "N-x"],
      ["CP-BLOCK-N-x", "N-x"],
    ]);
  }

  it("remaps an obligation-id finding_id onto the owning node", () => {
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: "OBL-X-01", status: "resolved", evidence: ["done"] }],
      aliasMap(),
      known,
    );
    expect(unresolved).toHaveLength(0);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].finding_id).toBe("N-x");
    expect(collapsed[0].status).toBe("resolved");
  });

  it("collapses multiple entries for the same node; blocked dominates and evidence unions", () => {
    const { collapsed } = collapseItemResults(
      [
        { finding_id: "N-x", status: "resolved", evidence: ["a"] },
        { finding_id: "OBL-X-01", status: "blocked", failure_reason: "nope", evidence: ["b"] },
      ],
      aliasMap(),
      known,
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].finding_id).toBe("N-x");
    expect(collapsed[0].status).toBe("blocked");
    expect(collapsed[0].failure_reason).toBe("nope");
    expect(collapsed[0].evidence).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("leaves a truly-unknown id unresolved (not remapped, not dropped silently)", () => {
    const { collapsed, unresolved } = collapseItemResults(
      [{ finding_id: "TOTALLY-UNKNOWN", status: "resolved" }],
      aliasMap(),
      known,
    );
    expect(collapsed).toHaveLength(0);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].finding_id).toBe("TOTALLY-UNKNOWN");
  });
});

// ---------------------------------------------------------------------------
// End-to-end merge tolerance
// ---------------------------------------------------------------------------

describe("mergeImplementResults — tolerance end-to-end", () => {
  it("resolves the owning node when the worker mislabels finding_id as an obligation id", async () => {
    await saveState(makeNodeState());
    const merged = await mergeWith([
      { finding_id: "OBL-X-01", status: "resolved", evidence: ["check passed: vitest run -> 3 pass"] },
    ]);
    expect(merged.items!["N-x"].status).toBe("resolved");
    // No orphan diagnostic was emitted — the id was tolerantly remapped.
    expect(
      existsSync(
        join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement", "orphaned-implement-results.json"),
      ),
    ).toBe(false);
  });

  it("collapses multiple entries that resolve to the same node (blocked dominates)", async () => {
    await saveState(makeNodeState());
    const merged = await mergeWith([
      { finding_id: "N-x", status: "resolved", evidence: ["ok"] },
      { finding_id: "OBL-X-02", status: "blocked", failure_reason: "a facet failed" },
    ]);
    expect(merged.items!["N-x"].status).toBe("blocked");
    expect(merged.items!["N-x"].failure_reason).toBe("a facet failed");
  });

  it("orphans the block when the worker reports an id that is neither a finding nor a known alias", async () => {
    await saveState(makeNodeState());
    const merged = await mergeWith([
      { finding_id: "WRONG-9999", status: "resolved", evidence: ["x"] },
    ]);
    // The owning block's item is blocked so the run cannot advance past it.
    expect(merged.items!["N-x"].status).toBe("blocked");
    const orphanPath = join(
      ARTIFACTS_DIR,
      "runs",
      "PLAN-1",
      "implement",
      "orphaned-implement-results.json",
    );
    expect(existsSync(orphanPath)).toBe(true);
    const orphan = JSON.parse(await readFile(orphanPath, "utf8"));
    expect(orphan.orphans[0].finding_id).toBe("WRONG-9999");
    expect(orphan.orphans[0].owning_block_id).toBe("CP-BLOCK-N-x");
  });

  it("writes a per-node disposition artifact on merge (INV-DS-15)", async () => {
    await saveState(makeNodeState());
    await mergeWith([
      { finding_id: "N-x", status: "resolved", evidence: ["vitest run -> 3 pass, 0 fail"] },
    ]);
    const dispPath = join(
      ARTIFACTS_DIR,
      "runs",
      "PLAN-1",
      "implement",
      "node-dispositions.json",
    );
    expect(existsSync(dispPath)).toBe(true);
    const disp = JSON.parse(await readFile(dispPath, "utf8"));
    const entry = disp.dispositions.find((d: { node_id: string }) => d.node_id === "N-x");
    expect(entry.disposition).toBe("verified_complete");
  });
});

// ---------------------------------------------------------------------------
// Merge-state gate: a self-reported "resolved" node whose tool-owned verify/merge
// did NOT land its edits must be routed to triage, never left resolved. Regression
// for the rolling-driver gap where acceptNodeWorktree's {merged} outcome was
// discarded, so a verify-failed-but-in-scope node could be falsely resolved.
// ---------------------------------------------------------------------------

describe("mergeImplementResults — merge-state gate (verify/merge must actually land)", () => {
  async function writeAcceptOutcome(outcome: {
    outcome: "success" | "error" | "rate_limited" | "timeout";
    verifyPassed: boolean;
    merged: boolean;
  }): Promise<void> {
    await mkdir(join(ARTIFACTS_DIR, "runs", "PLAN-1", "implement"), { recursive: true });
    await recordNodeAcceptOutcome(ARTIFACTS_DIR, "PLAN-1", "CP-BLOCK-N-x", outcome);
  }

  it("blocks a self-reported-resolved node whose accept-outcome shows it never merged", async () => {
    await saveState(makeNodeState());
    // The worker self-reports resolved, but the tool-owned verify/merge failed: the
    // fix never landed on the main tree. The recorded outcome is the ground truth.
    await writeAcceptOutcome({ outcome: "error", verifyPassed: false, merged: false });
    const merged = await mergeWith([
      { finding_id: "N-x", status: "resolved", evidence: ["claimed resolved but verify failed"] },
    ]);
    expect(merged.items!["N-x"].status).toBe("blocked");
    expect(merged.items!["N-x"].failure_reason).toMatch(/did not land|not in.*main tree/i);
  });

  it("keeps a resolved node resolved when its accept-outcome shows it merged", async () => {
    await saveState(makeNodeState());
    await writeAcceptOutcome({ outcome: "success", verifyPassed: true, merged: true });
    const merged = await mergeWith([
      { finding_id: "N-x", status: "resolved", evidence: ["landed: vitest run -> 3 pass"] },
    ]);
    expect(merged.items!["N-x"].status).toBe("resolved");
  });

  it("stays inert (no sidecar) so the interim main-tree path is unaffected", async () => {
    // No accept-outcome recorded → the gate must not fire; the worker's resolved
    // result stands exactly as before the gate existed.
    await saveState(makeNodeState());
    const merged = await mergeWith([
      { finding_id: "N-x", status: "resolved", evidence: ["main-tree path, no worktree record"] },
    ]);
    expect(merged.items!["N-x"].status).toBe("resolved");
  });
});
