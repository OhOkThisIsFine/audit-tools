/**
 * Accept write-scope residual pair (2026-08-06 run, open-bugs): the tool-owned
 * node commit must keep out
 *  - ws-1: worker SCRATCH — new non-source files outside the declared write
 *    scope (they previously rode the unowned-grant path straight into merges);
 *  - ws-2: tool-SEEDED untracked declared targets whose content is UNCHANGED
 *    from the seed (the run swept the operator's root session-config.json into
 *    a node commit this way).
 * A seeded file the worker genuinely edited stays in the commit (and is then
 * adjudicated by the write-scope gate like any other edit).
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSyncHidden } from "../helpers/spawn.mjs";
import { mkdtempSync, writeFileSync, appendFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  worktreePath,
  worktreeBranchForBlock,
  commitWorktree,
  seedUntrackedDeclaredPaths,
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
  writeFileSync(join(repo, "src.ts"), "export const v = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
  git(repo, "add", "src.ts", ".gitignore");
  git(repo, "commit", "-m", "base");
  return repo;
}

const committedFiles = (repo: string, branch: string): string[] =>
  git(repo, "show", "--name-only", "--pretty=format:", branch)
    .stdout.split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

afterEach(() => {
  for (const d of RM_DIRS.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort temp cleanup
    }
  }
});

describe("commitWorktree — scratch/seed exclusion (ws-1/ws-2)", () => {
  it("ws-1: a new non-source file outside declared write scope never enters the node commit", () => {
    const repo = initRepo("wts-scratch-");
    const branch = worktreeBranchForBlock("SC", "R");
    const wt = worktreePath(repo, "SC", "R");
    createWorktree(repo, wt, branch);
    // Real in-scope work + two scratch files the worker left behind.
    appendFileSync(join(wt, "src.ts"), "export const edited = 2;\n");
    writeFileSync(join(wt, "worker-notes.md"), "scratch notes\n");
    writeFileSync(join(wt, "debug-output.log"), "log line\n");

    const res = commitWorktree(wt, "remediate SC (R)", ["src.ts"]);

    expect(res.error).toBeUndefined();
    expect(res.committed).toBe(true);
    expect(res.excludedFromCommit).toEqual(
      expect.arrayContaining(["worker-notes.md", "debug-output.log"]),
    );
    const files = committedFiles(repo, branch);
    expect(files).toContain("src.ts");
    expect(files).not.toContain("worker-notes.md");
    expect(files).not.toContain("debug-output.log");
  });

  it("ws-2: an UNCHANGED tool-seeded file never enters the node commit", () => {
    const repo = initRepo("wts-seed-");
    // Untracked operator file at repo root (the session-config.json shape).
    writeFileSync(join(repo, "session-config.json"), '{"context_tokens":200000}\n');
    const branch = worktreeBranchForBlock("SD", "R");
    const wt = worktreePath(repo, "SD", "R");
    createWorktree(repo, wt, branch);
    const seeded = seedUntrackedDeclaredPaths(repo, wt, ["session-config.json"]);
    expect(seeded.map((s) => s.rel)).toEqual(["session-config.json"]);
    appendFileSync(join(wt, "src.ts"), "export const edited = 2;\n");

    const res = commitWorktree(
      wt,
      "remediate SD (R)",
      ["src.ts", "session-config.json"],
      seeded,
    );

    expect(res.error).toBeUndefined();
    expect(res.committed).toBe(true);
    expect(res.excludedFromCommit).toContain("session-config.json");
    const files = committedFiles(repo, branch);
    expect(files).toContain("src.ts");
    expect(files).not.toContain("session-config.json");
  });

  it("ws-2 negative: a seeded file the worker EDITED stays in the commit", () => {
    const repo = initRepo("wts-seed-edit-");
    writeFileSync(join(repo, "target.json"), '{"a":1}\n');
    const branch = worktreeBranchForBlock("SE", "R");
    const wt = worktreePath(repo, "SE", "R");
    createWorktree(repo, wt, branch);
    const seeded = seedUntrackedDeclaredPaths(repo, wt, ["target.json"]);
    expect(seeded.map((s) => s.rel)).toEqual(["target.json"]);
    // The worker's actual work IS the edit to the seeded declared target.
    writeFileSync(join(wt, "target.json"), '{"a":2}\n');

    const res = commitWorktree(wt, "remediate SE (R)", ["target.json"], seeded);

    expect(res.error).toBeUndefined();
    expect(res.committed).toBe(true);
    expect(res.excludedFromCommit ?? []).not.toContain("target.json");
    expect(committedFiles(repo, branch)).toContain("target.json");
  });

  it("all-scratch node degrades to the genuine no-change path, with the exclusion recorded", () => {
    const repo = initRepo("wts-only-scratch-");
    const branch = worktreeBranchForBlock("OS", "R");
    const wt = worktreePath(repo, "OS", "R");
    createWorktree(repo, wt, branch);
    writeFileSync(join(wt, "scratch.log"), "only scratch\n");

    const res = commitWorktree(wt, "remediate OS (R)", ["src.ts"]);

    expect(res.error).toBeUndefined();
    expect(res.committed).toBe(false);
    expect(res.excludedFromCommit).toEqual(["scratch.log"]);
  });
});
