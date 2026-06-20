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
  removeWorktree,
  resetNodeWorktreeAndBranch,
  worktreePath,
  worktreeBranchForBlock,
} from "../../src/remediate/steps/dispatch.js";
import { advanceHostRolling, type RollingSession } from "../../src/remediate/steps/rollingSession.js";
import { REMEDIATION_WORKER_RESULT_CONTRACT_VERSION } from "../../src/remediate/steps/types.js";

const RID = "RID";

function initRepo(): { repo: string; ok: boolean } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "host-roll-")));
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
  if (git("init").status !== 0) return { repo, ok: false };
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  // A minimal package.json with a trivial, cross-platform `check` script: the
  // per-node verify is now DERIVED (always runs `npm run check`), so the fixture
  // repo must resolve that script. `node --version` always exits 0 and needs no deps.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "host-roll-fixture", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
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

// ===========================================================================
// Re-dispatch after a blocked/triaged attempt — stale branch must be reset
// (regression: createNodeWorktree left the branch behind -> "branch already
// exists" on retry, blocking the whole host-rolling re-dispatch).
// ===========================================================================

describe("re-dispatch after a stale prior attempt", () => {
  it("resetNodeWorktreeAndBranch clears a leftover branch so createWorktree -b succeeds again", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const blockId = "RETRY1";
    const wt = worktreePath(repo, blockId, RID);
    const branch = worktreeBranchForBlock(blockId, RID);

    // First attempt: create worktree+branch, then remove ONLY the worktree
    // (the bug: branch survives) — mirrors a node dropped on a failed verify.
    createWorktree(repo, wt, branch);
    removeWorktree(repo, wt);

    // A bare re-create now fails because the branch still exists.
    expect(() => createWorktree(repo, wt, branch)).toThrow(/already exists/);

    // The reset clears worktree dir + pruned admin + branch, so -b recreates it.
    resetNodeWorktreeAndBranch(repo, wt, branch);
    expect(() => createWorktree(repo, wt, branch)).not.toThrow();
    expect(existsSync(wt)).toBe(true);
  });

  it("reset force-removes an orphaned worktree DIRECTORY (admin gone, files remain)", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const blockId = "RETRY2";
    const wt = worktreePath(repo, blockId, RID);
    const branch = worktreeBranchForBlock(blockId, RID);

    // Simulate an orphaned worktree dir: a directory at the worktree path that
    // git does not know about (admin entry pruned), with leftover files. A bare
    // `git worktree add` refuses because the path already exists.
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "stale.ts"), "export const stale = true;\n");
    expect(() => createWorktree(repo, wt, branch)).toThrow(/already exists/);

    // Reset must delete the leftover directory so the re-create succeeds.
    resetNodeWorktreeAndBranch(repo, wt, branch);
    expect(() => createWorktree(repo, wt, branch)).not.toThrow();
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, "src", "stale.ts"))).toBe(false);
  });
});

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

  it("runs the node's additionalVerifyCommands ALONGSIDE the derived verify (task_7d35176d): a failing targeted command gates even when no test files were touched", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    // A non-test edit → the derived verify is just `npm run check` (passes here);
    // the node's own targeted command must still run + gate the merge.
    const wt = makeWorktreeWithEdit(repo, "ADD1", "a.ts");
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "ADD1",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("ADD1", RID),
      workerOutcome: "success",
      // No targetedCommands override → derive runs; the additional command runs too.
      additionalVerifyCommands: ["node -e process.exit(1)"],
    });
    expect(res.outcome).toBe("error");
    expect(res.verifyPassed).toBe(false);
    expect(res.merged).toBe(false);
    expect(headHas(repo, "src/a.ts")).toBe(false);
  });

  it("merges when BOTH the derived verify and the node's additionalVerifyCommands pass", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktreeWithEdit(repo, "ADD2", "a.ts");
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "ADD2",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("ADD2", RID),
      workerOutcome: "success",
      additionalVerifyCommands: ["node --version"],
    });
    expect(res.outcome).toBe("success");
    expect(res.verifyPassed).toBe(true);
    expect(res.merged).toBe(true);
    expect(headHas(repo, "src/a.ts")).toBe(true);
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
    // The failing command + its output is captured so triage isn't blind.
    expect(res.diagnostic).toBeTruthy();
    expect(res.diagnostic).toContain("git rev-parse --verify refs/heads/__nope__");
    expect(existsSync(wt)).toBe(false);
    expect(headHas(repo, "src/a.ts")).toBe(false);
  });
});

// ===========================================================================
// acceptNodeWorktree — accept-time write-scope gate (BEFORE the cherry-pick)
// An out-of-scope edit must be PREVENTED from landing, not reported post-hoc.
// ===========================================================================

describe("acceptNodeWorktree — accept-time write-scope gate", () => {
  it("merges an in-scope edit (declared write path) without blocking", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktreeWithEdit(repo, "WS1", "a.ts");
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "WS1",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("WS1", RID),
      workerOutcome: "success",
      targetedCommands: [],
      scope: { allBlockScopes: [{ block_id: "WS1", write_paths: ["src/a.ts"] }] },
    });
    expect(res.merged).toBe(true);
    expect(headHas(repo, "src/a.ts")).toBe(true);
  });

  it("GRANTS an out-of-declared edit to an UNOWNED file — the gate routes git-actual edits, no self-report needed", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktreeWithEdit(repo, "WS2", "a.ts");
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "WS2",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("WS2", RID),
      workerOutcome: "success",
      targetedCommands: [],
      // src/a.ts is outside the declared scope, but no sibling block owns it, so the
      // actual git edit is granted (extend-into-unowned) and the node lands — even
      // though the worker reported nothing. A too-narrow/empty declared scope no
      // longer falsely blocks a correct fix.
      scope: { allBlockScopes: [{ block_id: "WS2", write_paths: ["src/declared.ts"] }] },
    });
    expect(res.merged).toBe(true);
    expect(headHas(repo, "src/a.ts")).toBe(true);
  });

  it("seam-conflicts an actual edit to a file OWNED by another block — blocked, not landed", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktreeWithEdit(repo, "WS4", "owned.ts");
    const res = acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "WS4",
      worktreeRoot: wt,
      branch: worktreeBranchForBlock("WS4", RID),
      workerOutcome: "success",
      targetedCommands: [],
      // src/owned.ts is in sibling block OTHER's declared scope → seam conflict on
      // the node's ACTUAL edit (no self-report involved).
      scope: {
        allBlockScopes: [
          { block_id: "WS4", write_paths: ["src/declared.ts"] },
          { block_id: "OTHER", write_paths: ["src/owned.ts"] },
        ],
      },
    });
    expect(res.merged).toBe(false);
    expect(res.outcome).toBe("error");
    expect(res.diagnostic).toMatch(/seam conflict/i);
    expect(res.diagnostic).toContain("owned by OTHER");
    expect(headHas(repo, "src/owned.ts")).toBe(false);
  });
});

// ===========================================================================
// acceptNodeWorktree — rebase-onto-HEAD folds in a sibling's merge (defect-3 seam).
// Two nodes branched off the same base both edit one file; the second rebases onto
// the first's merge so non-overlapping edits land and a true line conflict triages.
// ===========================================================================

describe("acceptNodeWorktree — rebase-onto-HEAD seam handling", () => {
  function seedShared(repo: string, lines: string[]): void {
    const git = (...a: string[]) => spawnSync("git", a, { cwd: repo, encoding: "utf8", shell: false });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "shared.ts"), lines.join("\n") + "\n");
    git("add", "src/shared.ts");
    git("commit", "-m", "seed shared");
  }
  function worktreeEditingShared(repo: string, blockId: string, lines: string[]): void {
    const wt = worktreePath(repo, blockId, RID);
    createWorktree(repo, wt, worktreeBranchForBlock(blockId, RID));
    writeFileSync(join(wt, "src", "shared.ts"), lines.join("\n") + "\n");
  }
  const accept = (repo: string, blockId: string) =>
    acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId,
      worktreeRoot: worktreePath(repo, blockId, RID),
      branch: worktreeBranchForBlock(blockId, RID),
      workerOutcome: "success",
      // omit targetedCommands → derive; no test file touched → `npm run check` only,
      // which the fixture's package.json resolves to `node --version` (exits 0).
    });
  const sharedAtHead = (repo: string): string =>
    spawnSync("git", ["show", "HEAD:src/shared.ts"], { cwd: repo, encoding: "utf8", shell: false }).stdout;

  it("auto-merges two nodes that edit DIFFERENT lines of one file (rebase folds in the prior merge)", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    seedShared(repo, ["A0", "B0", "C0"]);
    // Both worktrees branch off the SAME base (created before either merges).
    worktreeEditingShared(repo, "SEAMA", ["A1", "B0", "C0"]); // edits line 1
    worktreeEditingShared(repo, "SEAMB", ["A0", "B0", "C1"]); // edits line 3

    expect(accept(repo, "SEAMA").merged).toBe(true); // first lands; HEAD advances
    expect(accept(repo, "SEAMB").merged).toBe(true); // rebased onto A's merge; non-overlapping

    const shared = sharedAtHead(repo);
    expect(shared).toContain("A1"); // node A's change survived
    expect(shared).toContain("C1"); // node B's change folded in on top
  });

  it("routes to triage when two nodes edit the SAME line (a true seam the rebase can't merge)", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    seedShared(repo, ["A0", "B0", "C0"]);
    worktreeEditingShared(repo, "SEAMC", ["AX", "B0", "C0"]);
    worktreeEditingShared(repo, "SEAMD", ["AY", "B0", "C0"]); // same line, different content

    expect(accept(repo, "SEAMC").merged).toBe(true);
    const b = accept(repo, "SEAMD");
    expect(b.merged).toBe(false); // rebase conflict on line 1 → not merged
    expect(b.outcome).toBe("error");
    expect(b.diagnostic).toMatch(/seam|conflict|rebase/i);

    const shared = sharedAtHead(repo);
    expect(shared).toContain("AX"); // first node intact; second did not clobber it
    expect(shared).not.toContain("AY");
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
