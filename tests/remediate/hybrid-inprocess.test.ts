/**
 * A-8 hybrid in-process partition (H2+H4 collapse shape).
 *
 * The coordinator's IN-PROCESS partition now drives through the ROLLING ENGINE
 * (`driveRollingImplementDispatch` with `blocksOverride` + adopted
 * `claimOwnerTokens`) — `executeInProcessPartition`, the direct-Promise.all
 * executor these tests used to pin, is DELETED. The spec-A8 executor-level
 * guarantees carry over and are re-asserted against the engine path:
 *
 *  - each coordinator-claimed node runs on its assigned backend pool and LANDS its
 *    edits via the shared `acceptNodeWorktree` lifecycle (commit -> verify -> merge);
 *  - a worker that resolves nothing is NOT merged (never false-resolved) and is left
 *    for the deterministic merge to route to triage;
 *  - the coordinator's claims are ADOPTED, not re-claimed (a re-claim through the
 *    same registry would self-collide and skip every node as peer-owned), and each
 *    node's claim is released on its terminal outcome.
 *
 * Red on HEAD: `claimOwnerTokens` did not exist, so a coordinator-claimed partition
 * driven through the engine skipped every node as peer-owned.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, existsSync } from "node:fs";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import {
  ClaimRegistry,
  type CapacityPool,
  type SessionConfig,
} from "audit-tools/shared";
import { driveRollingImplementDispatch } from "../../src/remediate/steps/nextStep.js";
import { planHybridDispatch } from "audit-tools/shared";
import {
  prepareHostRollingDispatch,
  nodeClaimRegistryPath,
} from "../../src/remediate/steps/rollingSession.js";
import type { RemediationDispatchPlan } from "../../src/remediate/steps/types.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import { StateStore } from "../../src/remediate/state/store.js";
import {
  REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
  REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
} from "../../src/remediate/steps/types.js";


const RID = "RID-HYB";
const SESSION = { quota: { unknown_hosted_concurrency: 8 } } as SessionConfig;

/** A confirmed in-process backend pool (the NIM / openai-compatible worker). */
const NIM_POOL: CapacityPool = {
  id: "pool/nim",
  providerName: "openai-compatible",
  hostModel: null,
  hostConcurrencyLimit: null,
  quotaSourceSnapshot: {
    remaining_pct: 0.95,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date(0).toISOString(),
    source: "test",
  },
};

function initRepo(): { repo: string; ok: boolean } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "hyb-inproc-")));
  const git = (...a: string[]) =>
    spawnSync("git", a, { cwd: repo, encoding: "utf8", shell: false });
  if (git("init").status !== 0) return { repo, ok: false };
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  // Trivial cross-platform `check` so the derived per-node verify resolves + passes.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "hyb", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
  );
  git("add", "package.json");
  git("commit", "-m", "base");
  return { repo, ok: true };
}

function headHas(repo: string, path: string): boolean {
  return (
    spawnSync("git", ["show", `HEAD:${path}`], { cwd: repo, encoding: "utf8", shell: false })
      .status === 0
  );
}

function artifactsDirOf(repo: string): string {
  return join(repo, ".audit-tools", "remediation");
}

function planFor(repo: string, blockIds: string[]): RemediationDispatchPlan {
  const dir = artifactsDirOf(repo);
  return {
    contract_version: REMEDIATION_DISPATCH_PLAN_CONTRACT_VERSION,
    phase: "implement",
    run_id: RID,
    repo_root: repo,
    artifacts_dir: dir,
    items: blockIds.map((id) => ({
      task_id: id,
      block_id: id,
      prompt_path: join(dir, `${id}.prompt.md`),
      result_path: join(dir, `${id}.result.json`),
    })),
  };
}

/** Remediation state whose plan/items back the handcrafted dispatch plan. */
function stateFor(blockIds: string[]): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-HYB",
      findings: blockIds.map((id) => ({
        id: `${id}-f`,
        title: `Create src/${id}.ts`,
        category: "correctness",
        severity: "low",
        confidence: "high",
        lens: "correctness",
        summary: `Create src/${id}.ts.`,
        affected_files: [{ path: `src/${id}.ts` }],
        evidence: [`src/${id}.ts:1`],
      })),
      blocks: blockIds.map((id) => ({
        block_id: id,
        items: [`${id}-f`],
        parallel_safe: true,
        dependencies: [],
      })),
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: Object.fromEntries(
      blockIds.map((id) => [
        `${id}-f`,
        { finding_id: `${id}-f`, status: "pending", block_id: id },
      ]),
    ),
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

/** A stub worker that edits a node file + writes a valid resolved result. */
const resolvingWorker = async ({
  block,
  worktreeRoot,
  resultPath,
}: {
  block: { block_id: string };
  worktreeRoot: string;
  resultPath: string;
}) => {
  mkdirSync(join(worktreeRoot, "src"), { recursive: true });
  writeFileSync(join(worktreeRoot, "src", `${block.block_id}.ts`), `export const x = "${block.block_id}";\n`);
  writeFileSync(
    resultPath,
    JSON.stringify({
      contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
      phase: "implement",
      item_results: [{ finding_id: `${block.block_id}-f`, status: "resolved", evidence: ["edited"] }],
    }) + "\n",
  );
  return {
    packet: { id: block.block_id, payload: { block_id: block.block_id }, estimatedTokens: 0, complexity: 0.5 },
    outcome: "success" as const,
  };
};

describe("A-8 in-process partition via the rolling engine (H2+H4 collapse)", () => {
  it("drives each coordinator-claimed node on its backend pool with ADOPTED claims, merges into HEAD, releases the claim", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = artifactsDirOf(repo);
    mkdirSync(artifactsDir, { recursive: true });
    const blockIds = ["NIM1", "NIM2"];
    const plan = planFor(repo, blockIds);
    await new StateStore(artifactsDir).saveState(stateFor(blockIds));
    // The SAME registry file the driver derives (nodeClaimRegistryPath) — the
    // coordinator claims through it, the driver must ADOPT those claims.
    const registry = new ClaimRegistry(nodeClaimRegistryPath(artifactsDir, RID));
    const settled = new Set<string>();

    // Backend-only pool set -> the whole frontier is the in-process partition.
    const partition = await planHybridDispatch({
      frontier: blockIds.map((id) => ({ id, estimatedTokens: 1000 })),
      pools: [NIM_POOL],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: () => settled,
      onSettle: (p) => settled.add(p),
      isInProcess: (pool) => pool.providerName === "openai-compatible",
    });
    expect(partition.inProcess.length).toBe(2);
    expect(partition.host).toEqual([]);
    // The coordinator claimed both before returning them.
    expect(Object.keys(await registry.listClaims()).sort()).toEqual(["NIM1", "NIM2"]);

    const driven = await driveRollingImplementDispatch({
      root: repo,
      artifactsDir,
      runId: RID,
      sessionConfig: SESSION,
      dispatchNode: resolvingWorker,
      rebuildSharedBetweenLevels: async () => {},
      blocksOverride: partition.inProcess.map((a) => a.nodeId),
      poolsOverride: [NIM_POOL],
      // planOverride: the decision point's ONE prepared plan is reused — the driver
      // must not re-prepare (no dispatch-plan.json write from this drive).
      planOverride: plan,
      claimOwnerTokens: new Map(partition.inProcess.map((a) => [a.nodeId, a.ownerToken])),
    });

    // Both nodes ran on the assigned backend pool, merged, clean lifecycle.
    expect(driven?.nodes.map((n) => n.block_id).sort()).toEqual(["NIM1", "NIM2"]);
    expect(driven?.nodes.every((n) => n.outcome === "success" && n.merged)).toBe(true);
    expect(driven?.nodes.every((n) => n.pool_id === "pool/nim")).toBe(true);
    // Each node's edit landed in HEAD — the in-process partition merged this cycle.
    expect(headHas(repo, "src/NIM1.ts")).toBe(true);
    expect(headHas(repo, "src/NIM2.ts")).toBe(true);
    // planOverride respected: the driver did not re-prepare a plan.
    expect(existsSync(join(artifactsDir, "runs", RID, "implement", "dispatch-plan.json"))).toBe(false);
    // Terminal accepts released the ADOPTED claims (token-checked) so a peer / the
    // next cycle never re-grabs them; the caller's coordinator release is a no-op.
    expect(Object.keys(await registry.listClaims())).toEqual([]);
    for (const a of partition.inProcess) {
      await partition.coordinator.release(a); // idempotent post-drive sweep
    }
    expect(Object.keys(await registry.listClaims())).toEqual([]);
  }, 120_000);

  it("a worker that errors is NOT merged and is left for triage, but its claim is still released", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = artifactsDirOf(repo);
    mkdirSync(artifactsDir, { recursive: true });
    const plan = planFor(repo, ["BAD"]);
    await new StateStore(artifactsDir).saveState(stateFor(["BAD"]));
    const registry = new ClaimRegistry(nodeClaimRegistryPath(artifactsDir, RID));
    const settled = new Set<string>();
    const partition = await planHybridDispatch({
      frontier: [{ id: "BAD", estimatedTokens: 1000 }],
      pools: [NIM_POOL],
      sessionConfig: SESSION,
      claimRegistry: registry,
      readSettled: () => settled,
      onSettle: (p) => settled.add(p),
      isInProcess: (pool) => pool.providerName === "openai-compatible",
    });

    const errorWorker = async ({ block }: { block: { block_id: string } }) => ({
      packet: { id: block.block_id, payload: { block_id: block.block_id }, estimatedTokens: 0, complexity: 0.5 },
      outcome: "error" as const,
      error: new Error("boom"),
    });

    const driven = await driveRollingImplementDispatch({
      root: repo,
      artifactsDir,
      runId: RID,
      sessionConfig: SESSION,
      dispatchNode: errorWorker,
      rebuildSharedBetweenLevels: async () => {},
      blocksOverride: ["BAD"],
      poolsOverride: [NIM_POOL],
      planOverride: plan,
      claimOwnerTokens: new Map(partition.inProcess.map((a) => [a.nodeId, a.ownerToken])),
    });

    expect(driven?.nodes[0]?.merged).toBe(false);
    expect(headHas(repo, "src/BAD.ts")).toBe(false);
    // Terminal error -> adopted claim released (never stuck claimed).
    expect(Object.keys(await registry.listClaims())).toEqual([]);
  }, 120_000);

  it("WITHOUT adoption a coordinator-held claim self-collides: the node is skipped as peer-owned (why claimOwnerTokens is load-bearing)", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = artifactsDirOf(repo);
    mkdirSync(artifactsDir, { recursive: true });
    const plan = planFor(repo, ["HELD"]);
    await new StateStore(artifactsDir).saveState(stateFor(["HELD"]));
    const registry = new ClaimRegistry(nodeClaimRegistryPath(artifactsDir, RID));
    const held = await registry.claim("HELD", "in-process");
    expect(held.acquired).toBe(true);

    let dispatched = 0;
    const driven = await driveRollingImplementDispatch({
      root: repo,
      artifactsDir,
      runId: RID,
      sessionConfig: SESSION,
      dispatchNode: async (args) => {
        dispatched += 1;
        return resolvingWorker(args);
      },
      rebuildSharedBetweenLevels: async () => {},
      blocksOverride: ["HELD"],
      poolsOverride: [NIM_POOL],
      planOverride: plan,
      // NO claimOwnerTokens: the driver self-claims, collides, and skips.
    });

    expect(dispatched).toBe(0);
    expect(driven?.nodes[0]?.merged).toBe(false);
    expect(headHas(repo, "src/HELD.ts")).toBe(false);
    // The held claim is untouched (still the coordinator's to release).
    expect(Object.keys(await registry.listClaims())).toEqual(["HELD"]);
  }, 120_000);
});

describe("A-8 prepareHostRollingDispatch (hybrid partition)", () => {
  it("restricts the frontier to the host partition and REUSES the coordinator's claims (no re-claim)", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = artifactsDirOf(repo);
    const implementDir = join(artifactsDir, "runs", RID, "implement");
    mkdirSync(implementDir, { recursive: true });
    // Admission grants all three eligible nodes; the coordinator partition then
    // restricts the host driver to HOST1/HOST2. The granted set is what the host may
    // dispatch this step (worktrees == granted set ∩ partition).
    writeFileSync(
      join(implementDir, "dispatch-quota.json"),
      JSON.stringify({
        admission: {
          granted_packet_ids: ["HOST1", "HOST2", "HOST3"],
          declared_cap: null,
          leases: [],
          explains: [],
        },
      }) + "\n",
    );

    // The plan has THREE host blocks; the coordinator partition covers only two.
    const plan = planFor(repo, ["HOST1", "HOST2", "HOST3"]);

    // Pre-claim the two partition nodes (as the coordinator would), capturing the
    // tokens the host driver must REUSE — the registry path is the one
    // prepareHostRollingDispatch derives from (artifactsDir + runId).
    const registry = new ClaimRegistry(join(implementDir, "node-claims.json"));
    const c1 = await registry.claim("HOST1", "host-subagent");
    const c2 = await registry.claim("HOST2", "host-subagent");
    expect(c1.acquired && c2.acquired).toBe(true);
    const t1 = c1.acquired ? c1.ownerToken : "";
    const t2 = c2.acquired ? c2.ownerToken : "";

    const { session } = await prepareHostRollingDispatch(
      { root: repo, artifactsDir },
      RID,
      { sessionConfig: SESSION },
      {
        plan,
        partition: [
          { block_id: "HOST1", ownerToken: t1 },
          { block_id: "HOST2", ownerToken: t2 },
        ],
      },
    );

    // Frontier restricted to the partition (HOST3 excluded — it's another pool's / cycle's).
    expect(session.frontier.map((n) => n.block_id).sort()).toEqual(["HOST1", "HOST2"]);
    // Claims REUSED the coordinator's tokens. A re-claim would have FAILED (already
    // held) → the node would be skipped, so identical tokens prove the reuse path.
    expect(session.claims).toEqual({ HOST1: t1, HOST2: t2 });
    expect(session.dispatched.sort()).toEqual(["HOST1", "HOST2"]);
  });
});
