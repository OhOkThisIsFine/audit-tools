/**
 * A-8 hybrid in-process partition execution (FINDING-020 capstone).
 *
 * `executeInProcessPartition` runs the coordinator's IN-PROCESS partition this
 * cycle — the half of the hybrid split the orchestrator runs itself (the other half
 * goes to the host-subagent driver). Over a real temp git repo with a stub worker,
 * this asserts the spec §A8 executor-level guarantees:
 *
 *  - each coordinator-claimed node runs on its assigned backend pool and LANDS its
 *    edits via the shared `acceptNodeWorktree` lifecycle (commit → verify → merge);
 *  - a worker that resolves nothing is NOT merged (never false-resolved) and is left
 *    for the deterministic merge to route to triage;
 *  - every node's coordinator claim is released on its terminal outcome, so a peer
 *    driver or the next cycle never re-grabs it.
 *
 * acceptNodeWorktree's base-mutating section runs under a DISTINCT base-branch
 * lock, so the concurrent partition's per-node merges serialize on that lock — no
 * git index.lock race despite `Promise.all`.
 */

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import {
  ClaimRegistry,
  type CapacityPool,
  type SessionConfig,
} from "audit-tools/shared";
import { executeInProcessPartition } from "../../src/remediate/steps/nextStep.js";
import { planHybridDispatch } from "audit-tools/shared";
import { prepareHostRollingDispatch } from "../../src/remediate/steps/rollingSession.js";
import type { WorktreeNodeWorker } from "../../src/remediate/steps/dispatch.js";
import type { RemediationDispatchPlan } from "../../src/remediate/steps/types.js";
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

/** A stub worker that edits a node file + writes a valid resolved result. */
const resolvingWorker: WorktreeNodeWorker = async ({ block, worktreeRoot, resultPath }) => {
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
    outcome: "success",
  };
};

describe("A-8 executeInProcessPartition", () => {
  it("runs each coordinator-claimed node on its backend pool, merges into HEAD, releases the claim", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = artifactsDirOf(repo);
    mkdirSync(artifactsDir, { recursive: true });
    const blockIds = ["NIM1", "NIM2"];
    const plan = planFor(repo, blockIds);
    const registry = new ClaimRegistry(join(artifactsDir, "node-claims.json"));
    const settled = new Set<string>();

    // Backend-only pool set → the whole frontier is the in-process partition.
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

    const out = await executeInProcessPartition({
      root: repo,
      artifactsDir,
      runId: RID,
      sessionConfig: SESSION,
      partition: partition.inProcess,
      plan,
      coordinator: partition.coordinator,
      dispatchNode: resolvingWorker,
    });

    // Both nodes ran, merged, and report a clean lifecycle.
    expect(out.nodes.map((n) => n.block_id).sort()).toEqual(["NIM1", "NIM2"]);
    expect(out.nodes.every((n) => n.outcome === "success" && n.merged)).toBe(true);
    // Each node's edit landed in HEAD — the in-process partition merged this cycle.
    expect(headHas(repo, "src/NIM1.ts")).toBe(true);
    expect(headHas(repo, "src/NIM2.ts")).toBe(true);
    // Claims released so a peer / the next cycle never re-grabs them.
    expect(Object.keys(await registry.listClaims())).toEqual([]);
  });

  it("a worker that errors is NOT merged and is left for triage, but its claim is still released", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = artifactsDirOf(repo);
    mkdirSync(artifactsDir, { recursive: true });
    const plan = planFor(repo, ["BAD"]);
    const registry = new ClaimRegistry(join(artifactsDir, "node-claims.json"));
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

    const errorWorker: WorktreeNodeWorker = async ({ block }) => ({
      packet: { id: block.block_id, payload: { block_id: block.block_id }, estimatedTokens: 0, complexity: 0.5 },
      outcome: "error",
      error: new Error("boom"),
    });

    const out = await executeInProcessPartition({
      root: repo,
      artifactsDir,
      runId: RID,
      sessionConfig: SESSION,
      partition: partition.inProcess,
      plan,
      coordinator: partition.coordinator,
      dispatchNode: errorWorker,
    });

    expect(out.nodes[0]!.merged).toBe(false);
    expect(headHas(repo, "src/BAD.ts")).toBe(false);
    // Terminal error → claim released (never stuck claimed).
    expect(Object.keys(await registry.listClaims())).toEqual([]);
  });
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
