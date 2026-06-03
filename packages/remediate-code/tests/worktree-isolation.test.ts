import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  worktreeBasePath,
  worktreePathForBlock,
  isGitRepo,
  createWorktree,
  mergeWorktree,
  removeWorktree,
  cleanupAllWorktrees,
} from "../src/steps/worktreeIsolation.js";

describe("worktreeIsolation path helpers", () => {
  it("worktreeBasePath nests worktrees under the artifacts dir", () => {
    expect(worktreeBasePath(join("a", "artifacts"))).toBe(
      join("a", "artifacts", "worktrees"),
    );
  });

  it("worktreePathForBlock sanitizes the block id so it cannot escape the base", () => {
    const base = join("art", "worktrees");
    expect(worktreePathForBlock("art", "B-1")).toBe(join(base, "B-1"));
    // Traversal / separators in the block id are replaced, keeping the path
    // a single safe segment under the worktree base.
    expect(worktreePathForBlock("art", "../../etc")).toBe(join(base, "______etc"));
    expect(worktreePathForBlock("art", "a/b\\c")).toBe(join(base, "a_b_c"));
  });
});

describe("isGitRepo", () => {
  it("is false outside a git repo and true once initialized", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-iso-"));
    try {
      expect(await isGitRepo(dir)).toBe(false);
      execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
      expect(await isGitRepo(dir)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** Helper: create and configure a bare git repo with one commit. */
function makeRepo(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

describe("createWorktree — already-exists retry", () => {
  it("resolves to a worktree path when the branch already exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-iso-"));
    const artifactsDir = join(dir, ".artifacts");
    try {
      makeRepo(dir);
      const blockId = "block-1";
      const sanitized = blockId.replace(/[^a-zA-Z0-9_-]/g, "_");
      const branchName = `remediate-${sanitized}`;
      // Pre-create the branch so the first git worktree add -b will fail
      execFileSync("git", ["branch", branchName], { cwd: dir, stdio: "ignore" });
      const wtPath = await createWorktree(dir, artifactsDir, blockId);
      expect(typeof wtPath).toBe("string");
      expect(existsSync(wtPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeWorktree — merge conflict", () => {
  it("returns merged:false conflicted:true and leaves the repo clean when there is a conflict", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-iso-"));
    const artifactsDir = join(dir, ".artifacts");
    try {
      makeRepo(dir);
      // Seed a shared file on HEAD so both branches can conflict over it
      const sharedFile = join(dir, "shared.txt");
      execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: dir, stdio: "ignore" });

      const blockId = "conflict-block";
      await createWorktree(dir, artifactsDir, blockId);
      const wtPath = worktreePathForBlock(artifactsDir, blockId);

      // Commit a change on the block branch (in the worktree)
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(wtPath, "shared.txt"), "branch change\n");
      execFileSync("git", ["add", "shared.txt"], { cwd: wtPath, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "branch commit"], { cwd: wtPath, stdio: "ignore" });

      // Commit a conflicting change on HEAD in the main repo
      writeFileSync(sharedFile, "main change\n");
      execFileSync("git", ["add", "shared.txt"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "main commit"], { cwd: dir, stdio: "ignore" });

      const result = await mergeWorktree(dir, artifactsDir, blockId);
      expect(result.merged).toBe(false);
      expect(result.conflicted).toBe(true);
      expect(result.error).toMatch(blockId);
      // Repo must be left clean — no MERGE_HEAD
      expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cleanupAllWorktrees", () => {
  it("resolves without error when the worktree base dir does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-iso-"));
    try {
      makeRepo(dir);
      const artifactsDir = join(dir, ".artifacts");
      // Base dir was never created — should be a no-op
      await expect(cleanupAllWorktrees(dir, artifactsDir)).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("removes the worktree base dir after creating a worktree", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-iso-"));
    const artifactsDir = join(dir, ".artifacts");
    try {
      makeRepo(dir);
      await createWorktree(dir, artifactsDir, "cleanup-block");
      expect(existsSync(worktreeBasePath(artifactsDir))).toBe(true);
      await cleanupAllWorktrees(dir, artifactsDir);
      expect(existsSync(worktreeBasePath(artifactsDir))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("removeWorktree — fallback to rm+prune", () => {
  it("resolves and clears the path when git worktree remove fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-iso-"));
    const artifactsDir = join(dir, ".artifacts");
    try {
      makeRepo(dir);
      const blockId = "stale-block";
      const wtPath = await createWorktree(dir, artifactsDir, blockId);
      expect(existsSync(wtPath)).toBe(true);

      // Delete the worktree directory out from under git so
      // `git worktree remove --force` fails and the fallback rm+prune runs.
      await rm(wtPath, { recursive: true, force: true });

      await expect(
        removeWorktree(dir, artifactsDir, blockId),
      ).resolves.toBeUndefined();
      expect(existsSync(wtPath)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("mergeWorktree — clean fast path", () => {
  it("returns merged:true conflicted:false with no error when the branch has no diff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-iso-"));
    const artifactsDir = join(dir, ".artifacts");
    try {
      makeRepo(dir);
      const blockId = "clean-block";
      // Create the worktree but commit nothing — branch is identical to HEAD,
      // so `git diff --stat HEAD <branch>` is empty and the fast path triggers.
      await createWorktree(dir, artifactsDir, blockId);

      const result = await mergeWorktree(dir, artifactsDir, blockId);
      expect(result.merged).toBe(true);
      expect(result.conflicted).toBe(false);
      expect(result.error).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns merged:false with a 'does not exist' error when the worktree path is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wt-iso-"));
    const artifactsDir = join(dir, ".artifacts");
    try {
      makeRepo(dir);

      const result = await mergeWorktree(dir, artifactsDir, "never-created");
      expect(result.merged).toBe(false);
      expect(result.conflicted).toBe(false);
      expect(result.error).toMatch(/does not exist/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
