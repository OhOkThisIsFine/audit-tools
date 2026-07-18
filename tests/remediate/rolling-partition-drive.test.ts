// Partition-scoped rolling implement drive (H2 plan commit 2 — enabling change
// for the branch-pair collapse; docs/reviews/h2-h4-collapse-plan-2026-07-18.md D2).
// Red on HEAD: `blocksOverride`/`poolsOverride`, per-node `pool_id`, and
// `exhausted_pool_ids`/`terminal` on the driver result did not exist, and a
// partition wall would have been persisted as the RUN's terminal.
//
//  - pass-through: the adapter surfaces the unified driver's exhaustedPoolIds.
//  - scope: an override drive touches ONLY its partition's blocks; the run-level
//    state merge is the CALLER's (items stay pending here).
//  - lifecycle: a partition-scoped wall surfaces `terminal` on the result but
//    never persists `partial_completion_terminal` onto state.
//  - pin: a full-frontier drive is unchanged (merges, persists terminal).

import { afterAll, describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import {
  driveRollingDispatch,
  driveRollingImplementDispatch,
} from "../../src/remediate/steps/nextStep.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";
import { StateStore } from "../../src/remediate/state/store.js";
import type { RemediationState } from "../../src/remediate/state/store.js";
import type { RemediationBlock } from "../../src/remediate/state/types.js";
import type { CapacityPool, ProviderSlot, SessionConfig } from "audit-tools/shared";

const RM_DIRS: string[] = [];
afterAll(() => {
  for (const dir of RM_DIRS) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows file-lock stragglers are harmless temp litter. */
    }
  }
});

const git = (repo: string, ...a: string[]) =>
  spawnSyncHidden("git", a, { cwd: repo, encoding: "utf8", shell: false, windowsHide: true });

function initRepo(prefix: string): string {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  RM_DIRS.push(repo);
  git(repo, "init");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fx", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
  );
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n.audit-tools/\n");
  git(repo, "add", "package.json", ".gitignore");
  git(repo, "commit", "-m", "base");
  return repo;
}

function block(id: string, items: string[]): RemediationBlock {
  return { block_id: id, items, parallel_safe: true, dependencies: [] };
}

const NODES = [
  { id: "F-001", block: "B-001", file: "alpha.mjs", content: "export const alpha = 1;\n" },
  { id: "F-002", block: "B-002", file: "beta.mjs", content: "export const beta = 2;\n" },
];

function buildState(): RemediationState {
  return {
    status: "implementing",
    plan: {
      plan_id: "PLAN-PART",
      findings: NODES.map((n) => ({
        id: n.id,
        title: `Create ${n.file}`,
        category: "correctness",
        severity: "low",
        confidence: "high",
        lens: "correctness",
        summary: `Create ${n.file}.`,
        affected_files: [{ path: n.file }],
        evidence: [`${n.file}:1`],
      })),
      blocks: NODES.map((n) => block(n.block, [n.id])),
      project_type: "unknown",
      candidate_closing_actions: ["none"],
    },
    items: Object.fromEntries(
      NODES.map((n) => [
        n.id,
        {
          finding_id: n.id,
          status: "pending",
          block_id: n.block,
          item_spec: {
            finding_id: n.id,
            concrete_change: `Create ${n.file} containing exactly: ${n.content}`,
            no_change: false,
            touched_files: [n.file],
            tests_to_write: [],
            not_applicable_steps: [],
          },
        },
      ]),
    ),
    closing_plan: { action: "none" },
  } as unknown as RemediationState;
}

const backendPool = (id: string): CapacityPool =>
  ({
    id,
    providerName: "openai-compatible",
    hostModel: null,
    hostConcurrencyLimit: null,
  }) as unknown as CapacityPool;

/** A stub worker that lands its node's declared file + a resolved result. */
function successNodeStub() {
  const dispatched: string[] = [];
  const stub = async (args: {
    block: RemediationBlock;
    slot: ProviderSlot;
    worktreeRoot: string;
    resultPath: string;
  }) => {
    dispatched.push(args.block.block_id);
    const node = NODES.find((n) => n.block === args.block.block_id)!;
    writeFileSync(join(args.worktreeRoot, node.file), node.content);
    await writeFile(
      args.resultPath,
      JSON.stringify({
        contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
        phase: "implement",
        item_results: [{ finding_id: node.id, status: "resolved", evidence: ["stub landed"] }],
      }),
    );
    return {
      packet: {
        id: args.block.block_id,
        payload: { block_id: args.block.block_id },
        estimatedTokens: 1,
        complexity: 0.5,
      },
      outcome: "success" as const,
    };
  };
  return { stub, dispatched };
}

describe("driveRollingDispatch — exhausted-pool pass-through (H2 commit 2)", () => {
  it("surfaces the unified driver's exhaustedPoolIds on the adapter result", async () => {
    const result = await driveRollingDispatch([[block("B-X", ["F-X"])]], {
      confirmedPools: [backendPool("nim/exhausts")],
      sessionConfig: { quota: { safety_margin: 1.0 } } as SessionConfig,
      dispatchNode: async (b, slot: ProviderSlot) => ({
        packet: {
          id: b.block_id,
          payload: { block_id: b.block_id },
          estimatedTokens: 1,
          complexity: 0.5,
        },
        outcome: "credit_exhausted" as const,
        creditExhaustion: { rawMatch: "credits exhausted" },
      }),
      rebuildSharedBetweenLevels: async () => {},
    });
    expect(result.exhaustedPoolIds).toContain("nim/exhausts");
  });
});

describe("driveRollingImplementDispatch — partition scope + lifecycle (H2 commit 2)", () => {
  it(
    "blocksOverride drives ONLY its partition; state merge stays with the caller; pool_id attributed",
    async () => {
      const repo = initRepo("part-scope-");
      const artifactsDir = join(repo, ".audit-tools", "remediation");
      await new StateStore(artifactsDir).saveState(buildState());
      const { stub, dispatched } = successNodeStub();

      const driven = await driveRollingImplementDispatch({
        root: repo,
        artifactsDir,
        runId: "RUN-PART",
        sessionConfig: null,
        dispatchNode: stub,
        rebuildSharedBetweenLevels: async () => {},
        blocksOverride: ["B-001"],
        poolsOverride: [backendPool("nim/part")],
      });

      // Only the partition's block was driven; its pool is attributed.
      expect(dispatched).toEqual(["B-001"]);
      expect(driven?.nodes.map((n) => n.block_id)).toEqual(["B-001"]);
      expect(driven?.nodes[0]?.pool_id).toBe("nim/part");
      expect(driven?.exhausted_pool_ids).toEqual([]);

      // The node-level worktree merge landed the file...
      expect(git(repo, "show", "HEAD:alpha.mjs").status).toBe(0);
      expect(git(repo, "show", "HEAD:beta.mjs").status).not.toBe(0);
      // ...but the RUN-level state merge is the caller's: items stay pending.
      const after = await new StateStore(artifactsDir).loadState();
      expect(after?.items?.["F-001"]?.status).toBe("pending");
      expect(after?.items?.["F-002"]?.status).toBe("pending");
    },
    120_000,
  );

  it(
    "a partition-scoped wall surfaces `terminal` on the result but never persists it onto state",
    async () => {
      const repo = initRepo("part-wall-");
      const artifactsDir = join(repo, ".audit-tools", "remediation");
      await new StateStore(artifactsDir).saveState(buildState());

      const driven = await driveRollingImplementDispatch({
        root: repo,
        artifactsDir,
        runId: "RUN-WALL",
        sessionConfig: null,
        dispatchNode: async (args) => ({
          packet: {
            id: args.block.block_id,
            payload: { block_id: args.block.block_id },
            estimatedTokens: 1,
            complexity: 0.5,
          },
          outcome: "credit_exhausted" as const,
          creditExhaustion: { rawMatch: "credits exhausted" },
        }),
        rebuildSharedBetweenLevels: async () => {},
        blocksOverride: ["B-001"],
        poolsOverride: [backendPool("nim/wall")],
      });

      // The engine stranded the node on its permanently-excluded pool: the
      // caller gets the evidence (exhausted pool + terminal) on the RESULT...
      expect(driven?.exhausted_pool_ids).toContain("nim/wall");
      expect(driven?.terminal).toBeTruthy();
      // ...and the RUN's state is untouched — a backend-only wall must not
      // pause the whole run while the host share proceeds.
      const after = await new StateStore(artifactsDir).loadState();
      expect(after?.partial_completion_terminal).toBeUndefined();
    },
    120_000,
  );

  it(
    "full-frontier drive is unchanged: merges the run state and resolves the items",
    async () => {
      const repo = initRepo("part-full-");
      const artifactsDir = join(repo, ".audit-tools", "remediation");
      await new StateStore(artifactsDir).saveState(buildState());
      const { stub, dispatched } = successNodeStub();

      const driven = await driveRollingImplementDispatch({
        root: repo,
        artifactsDir,
        runId: "RUN-FULL",
        sessionConfig: null,
        dispatchNode: stub,
        rebuildSharedBetweenLevels: async () => {},
        poolsOverride: [backendPool("nim/full")],
      });

      expect(dispatched.sort()).toEqual(["B-001", "B-002"]);
      expect(driven?.exhausted_pool_ids).toEqual([]);
      const after = await new StateStore(artifactsDir).loadState();
      expect(after?.items?.["F-001"]?.status).toBe("resolved");
      expect(after?.items?.["F-002"]?.status).toBe("resolved");
    },
    120_000,
  );

  it(
    "full-frontier wall still persists the engine terminal onto state (pin — h2c2 F2)",
    async () => {
      const repo = initRepo("part-full-wall-");
      const artifactsDir = join(repo, ".audit-tools", "remediation");
      await new StateStore(artifactsDir).saveState(buildState());

      const driven = await driveRollingImplementDispatch({
        root: repo,
        artifactsDir,
        runId: "RUN-FULL-WALL",
        sessionConfig: null,
        dispatchNode: async (args) => ({
          packet: {
            id: args.block.block_id,
            payload: { block_id: args.block.block_id },
            estimatedTokens: 1,
            complexity: 0.5,
          },
          outcome: "credit_exhausted" as const,
          creditExhaustion: { rawMatch: "credits exhausted" },
        }),
        rebuildSharedBetweenLevels: async () => {},
        poolsOverride: [backendPool("nim/full-wall")],
      });

      // No partition scope → the terminal is BOTH surfaced and persisted (the
      // pre-merge write the partition guard must never suppress on this path).
      expect(driven?.terminal).toBeTruthy();
      expect(driven?.exhausted_pool_ids).toContain("nim/full-wall");
      const after = await new StateStore(artifactsDir).loadState();
      expect(after?.partial_completion_terminal).toBeTruthy();
    },
    120_000,
  );

  it("an EMPTY partition returns an empty-shaped result, never null (h2c2 F1)", async () => {
    const repo = initRepo("part-empty-");
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    await new StateStore(artifactsDir).saveState(buildState());

    const driven = await driveRollingImplementDispatch({
      root: repo,
      artifactsDir,
      runId: "RUN-EMPTY",
      sessionConfig: null,
      dispatchNode: async () => {
        throw new Error("must not dispatch");
      },
      rebuildSharedBetweenLevels: async () => {},
      blocksOverride: [],
      poolsOverride: [backendPool("nim/none")],
    });

    // `null` means "no eligible work → merge" to existing callers; an empty
    // partition must not trigger that recipe against the full-frontier plan.
    expect(driven).not.toBeNull();
    expect(driven?.nodes).toEqual([]);
    expect(driven?.exhausted_pool_ids).toEqual([]);
    // And nothing was merged: items untouched.
    const after = await new StateStore(artifactsDir).loadState();
    expect(after?.items?.["F-001"]?.status).toBe("pending");
  });
});
