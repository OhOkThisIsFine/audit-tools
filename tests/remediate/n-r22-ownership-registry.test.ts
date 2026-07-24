/**
 * N-R22: Ownership-gated affected_files amendment protocol.
 *
 * Tests:
 * - OwnershipRegistry: claimAmendment grants unowned file and persists
 * - OwnershipRegistry: claimAmendment blocks file owned by another node
 * - OwnershipRegistry: claimAmendment blocks file claimed by live parallel sibling
 * - OwnershipRegistry: no TOCTOU — two concurrent claim calls for the same unowned file
 * - OwnershipRegistry: releaseAmendments makes file available again
 * - routeAmendmentRequest: partitions paths correctly
 * - mergeImplementResults: unowned amended_files are accepted and added to effective scope
 * - mergeImplementResults: owned amended_files block the item
 * - OwnershipRegistry: stale in-flight claims are purged on load
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OwnershipRegistry } from "../../src/remediate/dispatch/ownershipRegistry.js";
import { routeAmendmentRequest } from "../../src/remediate/dispatch/amendmentClaim.js";
import { mergeImplementResults } from "../../src/remediate/steps/dispatch.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../../src/remediate/steps/types.js";
import { scratchDir } from "../helpers/scratch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = scratchDir(".test-n-r22");
const ARTIFACTS_DIR = join(TEST_DIR, ".audit-tools", "remediation");

// ---------------------------------------------------------------------------
// OwnershipRegistry unit tests
// ---------------------------------------------------------------------------

describe("OwnershipRegistry: claimAmendment grants unowned file and persists", () => {
  it("returns 'granted' for a path not in any node's contract scope", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const result = registry.claimAmendment("NODE-A", "src/c.ts");
    expect(result).toBe("granted");
  });

  it("the granted claim appears in getScope() for the claiming node", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
    ]);

    registry.claimAmendment("NODE-A", "src/new.ts");

    const scope = registry.getScope("NODE-A");
    expect(scope).toContain("src/a.ts");
    expect(scope).toContain("src/new.ts");
  });

  it("serialize() round-trips through fromJson() with the claim intact", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
    ]);
    registry.claimAmendment("NODE-A", "src/new.ts");

    const json = registry.serialize();
    const restored = OwnershipRegistry.fromJson(json, new Set(["NODE-A"]));

    const scope = restored.getScope("NODE-A");
    expect(scope).toContain("src/a.ts");
    expect(scope).toContain("src/new.ts");
  });
});

describe("OwnershipRegistry: claimAmendment blocks file owned by another node", () => {
  it("returns 'owned' when path is in node B's contract scope", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const result = registry.claimAmendment("NODE-A", "src/b.ts");
    expect(result).toBe("owned");
  });

  it("the 'owned' result carries the correct owner_node_id via routeAmendmentRequest", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const { seam_routed } = routeAmendmentRequest(registry, "NODE-A", ["src/b.ts"]);
    expect(seam_routed).toHaveLength(1);
    const reason = seam_routed[0].reason;
    expect(reason.outcome).toBe("owned");
    if (reason.outcome === "owned") {
      expect(reason.owner_node_id).toBe("NODE-B");
    }
  });

  it("getScope(nodeA) does not include the blocked path", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    registry.claimAmendment("NODE-A", "src/b.ts"); // returns 'owned', not granted
    const scope = registry.getScope("NODE-A");
    expect(scope).not.toContain("src/b.ts");
  });
});

describe("OwnershipRegistry: claimAmendment blocks file claimed by live parallel sibling", () => {
  it("returns 'contended' when another node has already claimed the file", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    // NODE-A claims the unowned file first
    const firstClaim = registry.claimAmendment("NODE-A", "src/shared.ts");
    expect(firstClaim).toBe("granted");

    // NODE-B tries to claim the same file while NODE-A is still in-flight
    const secondClaim = registry.claimAmendment("NODE-B", "src/shared.ts");
    expect(secondClaim).toBe("contended");
  });

  it("contended result carries sibling_node_id === nodeA", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);
    registry.claimAmendment("NODE-A", "src/shared.ts");

    const { seam_routed } = routeAmendmentRequest(registry, "NODE-B", ["src/shared.ts"]);
    expect(seam_routed).toHaveLength(1);
    const reason = seam_routed[0].reason;
    expect(reason.outcome).toBe("contended");
    if (reason.outcome === "contended") {
      expect(reason.sibling_node_id).toBe("NODE-A");
    }
  });
});

describe("OwnershipRegistry: no TOCTOU — two synchronous claim calls for the same unowned file", () => {
  it("exactly one returns 'granted' and the other returns 'contended'", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const r1 = registry.claimAmendment("NODE-A", "src/shared.ts");
    const r2 = registry.claimAmendment("NODE-B", "src/shared.ts");

    const results = [r1, r2];
    expect(results.filter((r) => r === "granted")).toHaveLength(1);
    expect(results.filter((r) => r === "contended")).toHaveLength(1);
  });

  it("the registry reflects only the winning claim after both calls", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    registry.claimAmendment("NODE-A", "src/shared.ts");
    registry.claimAmendment("NODE-B", "src/shared.ts");

    // Only NODE-A's claim should be in the registry (first caller wins).
    expect(registry.amendmentClaimant("src/shared.ts")).toBe("NODE-A");
    // NODE-B should not have it in scope.
    expect(registry.getScope("NODE-B")).not.toContain("src/shared.ts");
  });
});

describe("OwnershipRegistry: releaseAmendments makes file available again", () => {
  it("after node A's amendments are released, the previously contended file is available", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    registry.claimAmendment("NODE-A", "src/shared.ts");
    // Before release: NODE-B gets contended
    expect(registry.claimAmendment("NODE-B", "src/shared.ts")).toBe("contended");

    registry.releaseAmendments("NODE-A");

    // After release: NODE-B can claim it
    const result = registry.claimAmendment("NODE-B", "src/shared.ts");
    expect(result).toBe("granted");
  });

  it("a subsequent claim by node B returns 'granted' after NODE-A releases", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    registry.claimAmendment("NODE-A", "src/shared.ts");
    registry.releaseAmendments("NODE-A");

    expect(registry.claimAmendment("NODE-B", "src/shared.ts")).toBe("granted");
  });

  it("getScope(nodeA) no longer includes the released path", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
    ]);

    registry.claimAmendment("NODE-A", "src/shared.ts");
    expect(registry.getScope("NODE-A")).toContain("src/shared.ts");

    registry.releaseAmendments("NODE-A");
    expect(registry.getScope("NODE-A")).not.toContain("src/shared.ts");
  });
});

describe("routeAmendmentRequest: partitions paths correctly", () => {
  it("unowned paths appear in the 'granted' list", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const { granted } = routeAmendmentRequest(registry, "NODE-A", ["src/c.ts", "src/d.ts"]);
    expect(granted).toContain("src/c.ts");
    expect(granted).toContain("src/d.ts");
  });

  it("owned/contended paths appear in 'seam_routed' with correct AmendmentClaimResult", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
      { node_id: "NODE-C", write_paths: ["src/c.ts"] },
    ]);
    // NODE-C claims an unowned file so NODE-A's claim on it is contended
    registry.claimAmendment("NODE-C", "src/shared.ts");

    const { seam_routed } = routeAmendmentRequest(registry, "NODE-A", [
      "src/b.ts",       // owned by NODE-B
      "src/shared.ts",  // contended by NODE-C
    ]);

    expect(seam_routed).toHaveLength(2);
    const ownedEntry = seam_routed.find((r) => r.path === "src/b.ts");
    const contendedEntry = seam_routed.find((r) => r.path === "src/shared.ts");
    expect(ownedEntry?.reason.outcome).toBe("owned");
    expect(contendedEntry?.reason.outcome).toBe("contended");
  });

  it("no path appears in both lists", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
      { node_id: "NODE-B", write_paths: ["src/b.ts"] },
    ]);

    const { granted, seam_routed } = routeAmendmentRequest(registry, "NODE-A", [
      "src/new.ts",
      "src/b.ts",
    ]);

    const grantedSet = new Set(granted);
    for (const { path } of seam_routed) {
      expect(grantedSet.has(path)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// OwnershipRegistry: stale in-flight claims are purged on load
// ---------------------------------------------------------------------------

describe("OwnershipRegistry: stale in-flight claims are purged on load", () => {
  it("a serialized registry with an in-flight claim for an unknown node_id has that claim removed on fromJson()", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
    ]);
    registry.claimAmendment("NODE-A", "src/shared.ts");

    const json = registry.serialize();

    // Restore with a DAG that no longer contains NODE-A (stale node)
    const restored = OwnershipRegistry.fromJson(json, new Set<string>([]));

    // The amendment claim for NODE-A should be purged
    expect(restored.amendmentClaimant("src/shared.ts")).toBeUndefined();
  });

  it("the purged file is available for new claims", () => {
    const registry = new OwnershipRegistry();
    registry.initialize([
      { node_id: "NODE-A", write_paths: ["src/a.ts"] },
    ]);
    registry.claimAmendment("NODE-A", "src/shared.ts");

    const json = registry.serialize();

    // Restore with new DAG (NODE-A is gone, NODE-B is new)
    const newDagNodes = [{ node_id: "NODE-B", write_paths: ["src/b.ts"] }];
    const restored = OwnershipRegistry.fromJson(json, new Set(["NODE-B"]));
    restored.initialize(newDagNodes);

    expect(restored.claimAmendment("NODE-B", "src/shared.ts")).toBe("granted");
  });
});

// ---------------------------------------------------------------------------
// mergeImplementResults: amended_files integration
// ---------------------------------------------------------------------------

beforeEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  await mkdir(ARTIFACTS_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

/**
 * Minimal state scaffold for mergeImplementResults tests.
 */
async function writeMinimalState(
  artifactsDir: string,
  blocks: Array<{
    block_id: string;
    items: string[];
    write_paths?: string[];
  }>,
  findings: Array<{ id: string }>,
): Promise<void> {
  const state = {
    status: "implementing",
    run_id: "N-R22-TEST",
    plan: {
      plan_id: "P1",
      findings: findings.map((f) => ({
        id: f.id,
        title: `Finding ${f.id}`,
        severity: "medium",
        confidence: "high",
        lens: "correctness",
        summary: "Test finding.",
        affected_files: [{ path: `src/${f.id}.ts` }],
        evidence: [],
      })),
      // MNT-eefc3864: thread write_paths into the state block when a caller
      // supplies it, so the shared `blocks` param means the same thing in both
      // writeMinimalState and writeDispatchPlan (it was previously dropped here,
      // silently diverging the two helpers).
      blocks: blocks.map((b) => ({
        block_id: b.block_id,
        items: b.items,
        parallel_safe: true,
        ...(b.write_paths ? { write_paths: b.write_paths } : {}),
      })),
      project_type: "typescript",
      candidate_closing_actions: [],
    },
    items: Object.fromEntries(
      findings.map((f) => [
        f.id,
        {
          // INV-RSM-STATE-COMPLETE: persisted items carry their identity fields.
          finding_id: f.id,
          block_id:
            blocks.find((b) => b.items.includes(f.id))?.block_id ??
            blocks[0]?.block_id ??
            "BLK-001",
          status: "pending",
          item_spec: {
            finding_id: f.id,
            concrete_change: "Fix it.",
            no_change: false,
            touched_files: [`src/${f.id}.ts`],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      ]),
    ),
    clarifications: [],
    closing_plan: { action: "none" },
  };

  await writeFile(
    join(artifactsDir, "state.json"),
    JSON.stringify(state, null, 2) + "\n",
    "utf8",
  );
}

async function writeDispatchPlan(
  artifactsDir: string,
  runId: string,
  blocks: Array<{
    block_id: string;
    items: string[];
    write_paths?: string[];
  }>,
): Promise<void> {
  const dir = join(artifactsDir, "runs", runId, "implement");
  await mkdir(dir, { recursive: true });

  const plan = {
    contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
    phase: "implement",
    run_id: runId,
    repo_root: TEST_DIR.replace(/\\/g, "/"),
    artifacts_dir: artifactsDir.replace(/\\/g, "/"),
    items: blocks.map((b) => ({
      task_id: `implement-${b.block_id}`,
      block_id: b.block_id,
      prompt_path: join(dir, `implement-${b.block_id}.md`),
      result_path: join(dir, `implement-${b.block_id}.result.json`),
      access: {
        read_paths: b.items.map((id) => `src/${id}.ts`),
        write_paths: b.write_paths ?? b.items.map((id) => `src/${id}.ts`),
      },
    })),
  };

  await writeFile(
    join(dir, "dispatch-plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
    "utf8",
  );
}

describe("mergeImplementResults: unowned amended_files are accepted and added to effective scope", () => {
  it("an ImplementWorkerResult with amended_files listing an unowned path is accepted", async () => {
    const runId = "run-r22-a";
    await writeMinimalState(ARTIFACTS_DIR, [{ block_id: "BLK-001", items: ["F-001"] }], [{ id: "F-001" }]);
    await writeDispatchPlan(ARTIFACTS_DIR, runId, [{ block_id: "BLK-001", items: ["F-001"] }]);

    const dir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(dir, { recursive: true });

    const result = {
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: "F-001", status: "resolved", evidence: ["Tests pass."] }],
      amended_files: ["src/shared-util.ts"], // unowned — not in any block's write_paths
    };
    await writeFile(
      join(dir, "implement-BLK-001.result.json"),
      JSON.stringify(result, null, 2) + "\n",
      "utf8",
    );

    const state = await mergeImplementResults(
      { root: TEST_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    // F-001 should be resolved (amendment was unowned, so the result was accepted)
    expect(state.items?.["F-001"]?.status).toBe("resolved");
  });
});

describe("mergeImplementResults: owned amended_files block the item", () => {
  it("an ImplementWorkerResult with amended_files listing a path owned by another block blocks the item", async () => {
    const runId = "run-r22-b";
    await writeMinimalState(
      ARTIFACTS_DIR,
      [
        { block_id: "BLK-001", items: ["F-001"], write_paths: ["src/F-001.ts"] },
        { block_id: "BLK-002", items: ["F-002"], write_paths: ["src/F-002.ts"] },
      ],
      [{ id: "F-001" }, { id: "F-002" }],
    );
    await writeDispatchPlan(ARTIFACTS_DIR, runId, [
      { block_id: "BLK-001", items: ["F-001"], write_paths: ["src/F-001.ts"] },
      { block_id: "BLK-002", items: ["F-002"], write_paths: ["src/F-002.ts"] },
    ]);

    const dir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    await mkdir(dir, { recursive: true });

    // BLK-001 tries to amend a file that is owned by BLK-002's contract scope
    const result1 = {
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: "F-001", status: "resolved", evidence: ["Tests pass."] }],
      amended_files: ["src/F-002.ts"], // owned by BLK-002 → seam conflict
    };
    await writeFile(
      join(dir, "implement-BLK-001.result.json"),
      JSON.stringify(result1, null, 2) + "\n",
      "utf8",
    );

    // BLK-002 has a normal result
    const result2 = {
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: "F-002", status: "resolved", evidence: ["Tests pass."] }],
    };
    await writeFile(
      join(dir, "implement-BLK-002.result.json"),
      JSON.stringify(result2, null, 2) + "\n",
      "utf8",
    );

    const state = await mergeImplementResults(
      { root: TEST_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    // F-001 should be blocked (seam conflict)
    expect(state.items?.["F-001"]?.status).toBe("blocked");
    expect(state.items?.["F-001"]?.failure_reason).toMatch(/seam conflict/i);
    // F-002 should be resolved (its result was fine)
    expect(state.items?.["F-002"]?.status).toBe("resolved");
  });

  it("the failure_reason identifies the conflicting path and owner block", async () => {
    const runId = "run-r22-c";
    await writeMinimalState(
      ARTIFACTS_DIR,
      [
        { block_id: "BLK-001", items: ["F-001"], write_paths: ["src/F-001.ts"] },
        { block_id: "BLK-002", items: ["F-002"], write_paths: ["src/F-002.ts"] },
      ],
      [{ id: "F-001" }, { id: "F-002" }],
    );
    await writeDispatchPlan(ARTIFACTS_DIR, runId, [
      { block_id: "BLK-001", items: ["F-001"], write_paths: ["src/F-001.ts"] },
      { block_id: "BLK-002", items: ["F-002"], write_paths: ["src/F-002.ts"] },
    ]);

    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(ARTIFACTS_DIR, "runs", runId, "implement");
    mkdirSync(dir, { recursive: true });

    const result1 = {
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: "F-001", status: "resolved" }],
      amended_files: ["src/F-002.ts"],
    };
    writeFileSync(
      join(dir, "implement-BLK-001.result.json"),
      JSON.stringify(result1, null, 2) + "\n",
      "utf8",
    );
    const result2 = {
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: "F-002", status: "resolved" }],
    };
    writeFileSync(
      join(dir, "implement-BLK-002.result.json"),
      JSON.stringify(result2, null, 2) + "\n",
      "utf8",
    );

    const state = await mergeImplementResults(
      { root: TEST_DIR, artifactsDir: ARTIFACTS_DIR },
      runId,
    );

    const failureReason = state.items?.["F-001"]?.failure_reason ?? "";
    expect(failureReason).toContain("src/F-002.ts");
    expect(failureReason).toContain("BLK-002");
  });
});
