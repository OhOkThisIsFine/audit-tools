import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  worktreeBasePath,
  worktreePathForBlock,
  isGitRepo,
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
