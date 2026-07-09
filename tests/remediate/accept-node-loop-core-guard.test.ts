/**
 * Per-node loop-core cross-file GUARD (acceptNode.ts). A remediate node's own verify
 * runs only its targeted tests + a merged-base typecheck, so a cross-FILE
 * invariant/contract regression escapes node-local verify. `acceptNodeWorktree` runs
 * the cross-cutting guard suite in the MAIN checkout after the pick lands — but ONLY
 * when the node's edits touched a loop-core path (`isLoopCorePath`), so the cheap
 * majority of nodes never pay for it. A RED guard rolls the base back + quarantines.
 *
 *  A  loop-core edit + FAILING guard   → outcome:error, base rolled back, quarantined
 *  B  non-loop-core edit + FAILING guard → guard SKIPPED, outcome:success, edit lands
 *  C  loop-core edit + PASSING guard    → outcome:success, edit lands
 *
 * Real temp git repo (strongest ground truth), matching dispatch-worktree-safety.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  worktreePath,
  worktreeBranchForBlock,
  acceptNodeWorktree,
  quarantineRef,
} from "../../src/remediate/steps/dispatch.js";

const RM_DIRS: string[] = [];
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

const headOid = (repo: string): string => git(repo, "rev-parse", "HEAD").stdout.trim();
const refExists = (repo: string, ref: string): boolean =>
  git(repo, "rev-parse", "--verify", "--quiet", ref).status === 0;

/** Create the node's worktree and write `relPath` into it (a committed node edit). */
function nodeWithEdit(repo: string, id: string, relPath: string): string {
  const wt = worktreePath(repo, id, "R");
  createWorktree(repo, wt, worktreeBranchForBlock(id, "R"));
  const dir = join(wt, ...relPath.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(wt, relPath), "export const x = 1;\n");
  return wt;
}

afterEach(() => {
  for (const d of RM_DIRS.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

describe("acceptNodeWorktree — per-node loop-core cross-file guard", () => {
  // A — the node's edit touches a LOOP-CORE path and the injected guard FAILS: the
  // guard runs, the base is rolled back to its pre-pick OID, and the node is quarantined.
  it("A: loop-core edit + FAILING guard → error, base rolled back, quarantined", async () => {
    const repo = initRepo("lcg-fail-");
    const base = headOid(repo);
    nodeWithEdit(repo, "LCA", "src/shared/quota/foo.ts");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: "R",
      blockId: "LCA",
      worktreeRoot: worktreePath(repo, "LCA", "R"),
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("LCA", "R"),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/"],
      // Merged-base check PASSES so the guard is what fails.
      mergedBaseCheckCommand: ["node", "-e", ""],
      mergedGuardCommand: ["node", "-e", "process.exit(1)"],
    });
    expect(res.outcome).toBe("error");
    expect(res.merged).toBe(false);
    // Base rolled back bit-identically to its pre-pick OID.
    expect(headOid(repo)).toBe(base);
    // The node's work is preserved under its quarantine ref.
    expect(refExists(repo, quarantineRef("R", "LCA"))).toBe(true);
    expect(res.diagnostic).toMatch(/node -e process\.exit\(1\)/);
  });

  // B — the node's edit touches ONLY a non-loop-core path: the guard is SKIPPED (never
  // run) even though the injected guard command would fail, so the edit lands.
  it("B: non-loop-core edit + FAILING guard → guard SKIPPED, success, edit lands", async () => {
    const repo = initRepo("lcg-skip-");
    nodeWithEdit(repo, "LCB", "src/remediate/intake.ts");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: "R",
      blockId: "LCB",
      worktreeRoot: worktreePath(repo, "LCB", "R"),
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("LCB", "R"),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/"],
      mergedBaseCheckCommand: ["node", "-e", ""],
      // Would fail IF run — proves the loop-core gate skipped it entirely.
      mergedGuardCommand: ["node", "-e", "process.exit(1)"],
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(true);
    expect(refExists(repo, quarantineRef("R", "LCB"))).toBe(false);
  });

  // C — the node's edit touches a LOOP-CORE path and the injected guard PASSES: the
  // guard runs green and the edit lands.
  it("C: loop-core edit + PASSING guard → success, edit lands", async () => {
    const repo = initRepo("lcg-pass-");
    nodeWithEdit(repo, "LCC", "src/shared/quota/bar.ts");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: "R",
      blockId: "LCC",
      worktreeRoot: worktreePath(repo, "LCC", "R"),
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("LCC", "R"),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/"],
      mergedBaseCheckCommand: ["node", "-e", ""],
      mergedGuardCommand: ["node", "-e", ""],
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(true);
    expect(refExists(repo, quarantineRef("R", "LCC"))).toBe(false);
  });
});
