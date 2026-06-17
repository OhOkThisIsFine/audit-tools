// A8 host-subagent rolling driver: the shared accept lifecycle (acceptNodeWorktree)
// and the per-completion session state machine (advanceHostRolling) that the
// `accept-node` callback drives. Real git worktrees; no state.json needed
// (loadState → null → empty verify auto-passes), so these isolate the driver logic.

import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  acceptNodeWorktree,
  createWorktree,
  worktreePath,
  worktreeBranchForBlock,
} from "../src/steps/dispatch.js";
import { advanceHostRolling, type RollingSession } from "../src/steps/rollingSession.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../src/steps/types.js";

const RID = "RID";

function initRepo(): { repo: string; ok: boolean } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "host-roll-")));
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
  if (git("init").status !== 0) return { repo, ok: false };
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "--allow-empty", "-m", "base");
  return { repo, ok: true };
}

function headHas(repo: string, path: string): boolean {
  return (
    spawnSync("git", ["show", `HEAD:${path}`], { cwd: repo, encoding: "utf8", shell: false })
      .status === 0
  );
}

function makeWorktreeWithEdit(repo: string, blockId: string, file: string): string {
  const wt = worktreePath(repo, blockId, RID);
  createWorktree(repo, wt, worktreeBranchForBlock(blockId, RID));
  mkdirSync(join(wt, "src"), { recursive: true });
  writeFileSync(join(wt, "src", file), `export const x = "${blockId}";\n`);
  return wt;
}

// ===========================================================================
// acceptNodeWorktree — the shared commit -> verify -> merge core
// ===========================================================================

describe("acceptNodeWorktree", () => {
  it("commits, verifies, and merges a successful node's edits into HEAD", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktreeWithEdit(repo, "A1", "a.ts");
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "A1",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("A1", RID),
      workerOutcome: "success",
      targetedCommands: [],
    });
    expect(res.outcome).toBe("success");
    expect(res.verifyPassed).toBe(true);
    expect(res.merged).toBe(true);
    expect(headHas(repo, "src/a.ts")).toBe(true);
    expect(existsSync(wt)).toBe(false); // mergeWorktree removes it
  });

  it("treats a success worker that made no edits as no-change (not merged, dropped)", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = worktreePath(repo, "A2", RID);
    createWorktree(repo, wt, worktreeBranchForBlock("A2", RID)); // no edits
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "A2",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("A2", RID),
      workerOutcome: "success",
      targetedCommands: [],
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(false);
    expect(existsSync(wt)).toBe(false);
  });

  it("drops a worker-error node without merging", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktreeWithEdit(repo, "A3", "a.ts");
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "A3",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("A3", RID),
      workerOutcome: "error",
      targetedCommands: [],
    });
    expect(res.outcome).toBe("error");
    expect(res.merged).toBe(false);
    expect(existsSync(wt)).toBe(false);
    expect(headHas(repo, "src/a.ts")).toBe(false);
  });

  it("rejects a node whose verify fails: not merged, worktree dropped, main tree clean", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktreeWithEdit(repo, "A4", "a.ts");
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "A4",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("A4", RID),
      workerOutcome: "success",
      // A read-only command that always exits non-zero → verify fails.
      targetedCommands: ["git rev-parse --verify refs/heads/__nope__"],
    });
    expect(res.verifyPassed).toBe(false);
    expect(res.merged).toBe(false);
    expect(res.outcome).toBe("error");
    expect(existsSync(wt)).toBe(false);
    expect(headHas(repo, "src/a.ts")).toBe(false);
  });
});

// ===========================================================================
// advanceHostRolling — the per-completion session state machine
// ===========================================================================

describe("advanceHostRolling", () => {
  function seedSession(repo: string, frontierIds: string[], slots: number): string {
    const artifactsDir = join(repo, ".audit-tools", "remediation");
    const implDir = join(artifactsDir, "runs", RID, "implement");
    mkdirSync(implDir, { recursive: true });
    const frontier = frontierIds.map((id) => ({
      block_id: id,
      prompt_path: join(implDir, `${id}.md`),
      result_path: join(artifactsDir, `${id}.result.json`),
    }));
    // A resolved result per node → resultOutcome = "success".
    for (const node of frontier) {
      writeFileSync(
        node.result_path,
        JSON.stringify({
          contract_version: REMEDIATION_WORKER_RESULT_CONTRACT_VERSION,
          phase: "implement",
          item_results: [{ finding_id: node.block_id, status: "resolved", evidence: ["ok"] }],
        }),
      );
    }
    const initial = frontierIds.slice(0, Math.min(slots, frontierIds.length));
    for (const id of initial) {
      createWorktree(repo, worktreePath(repo, id, RID), worktreeBranchForBlock(id, RID));
    }
    const session: RollingSession = {
      run_id: RID,
      slots,
      frontier,
      dispatched: initial,
      accepted: [],
    };
    writeFileSync(join(implDir, "rolling-session.json"), JSON.stringify(session));
    return artifactsDir;
  }

  it("rolls dispatch -> wait -> done across a frontier, JIT-creating the next worktree", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    // 3 nodes, slots=2: B1,B2 pre-dispatched; B3 is JIT-created on the first completion.
    const artifactsDir = seedSession(repo, ["B1", "B2", "B3"], 2);

    const d1 = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" });
    expect(d1.kind).toBe("dispatch");
    if (d1.kind === "dispatch") expect(d1.node.block_id).toBe("B3");
    // B3's worktree was JIT-created; B1's was removed by its accept lifecycle.
    expect(existsSync(worktreePath(repo, "B3", RID))).toBe(true);
    expect(existsSync(worktreePath(repo, "B1", RID))).toBe(false);

    // B2 finishes; B3 is still in flight and nothing left to dispatch → wait.
    const d2 = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B2" });
    expect(d2.kind).toBe("wait");
    if (d2.kind === "wait") expect(d2.accepted).toBe(2);

    // B3 finishes; all accepted → done.
    const d3 = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B3" });
    expect(d3.kind).toBe("done");
    if (d3.kind === "done") expect(d3.accepted).toBe(3);
  });

  it("is idempotent: a re-run for an already-accepted node does not double-accept", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = seedSession(repo, ["B1"], 1);
    const first = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" });
    expect(first.kind).toBe("done");
    // Re-run: no throw, still done, accepted count unchanged (1, not 2).
    const again = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" });
    expect(again.kind).toBe("done");
    if (again.kind === "done") expect(again.accepted).toBe(1);
  });

  it("throws for a block id that is not in the frontier", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = seedSession(repo, ["B1"], 1);
    await expect(
      advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "ZZZ" }),
    ).rejects.toThrow(/not in the rolling frontier/);
  });

  it("records each accepted node's verify/merge outcome to the sidecar mergeImplementResults reads", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const artifactsDir = seedSession(repo, ["B1"], 1);
    // seedSession created B1's worktree without edits; add a real edit so the accept
    // lifecycle commits → verifies (no targeted cmds → auto-pass) → merges (merged:true).
    const wt = worktreePath(repo, "B1", RID);
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "b1.ts"), 'export const x = "B1";\n');

    const d = await advanceHostRolling({ root: repo, artifactsDir, runId: RID, blockId: "B1" });
    expect(d.kind).toBe("done");

    // The accept-outcome sidecar is the merge-state ground truth (OBL-DS-06).
    const sidecar = join(artifactsDir, "runs", RID, "implement", "accept-outcome-B1.json");
    expect(existsSync(sidecar)).toBe(true);
    const rec = JSON.parse(readFileSync(sidecar, "utf8"));
    expect(rec.block_id).toBe("B1");
    expect(rec.merged).toBe(true);
    expect(rec.verify_passed).toBe(true);
    expect(rec.outcome).toBe("success");
  });
});
