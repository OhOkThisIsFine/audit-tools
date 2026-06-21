/**
 * Tests for worktree dispatch engine: createWorktree, removeWorktree,
 * verifyNodeInWorktree, mergeWorktree, worktreePath, and worktree-rooted
 * implement prompt rendering.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  removeWorktree,
  verifyNodeInWorktree,
  mergeWorktree,
  worktreePath,
  seedUntrackedDeclaredPaths,
} from "../../src/remediate/steps/dispatch.js";
// ---------------------------------------------------------------------------
// Stub spawnSync to avoid real git calls in unit tests
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);

function makeSpawnResult(status: number, stdout = "", stderr = "") {
  return { status, stdout, stderr, pid: 1, output: [], signal: null, error: undefined };
}

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// seedUntrackedDeclaredPaths (pure fs — copies declared targets a worktree lacks)
// ---------------------------------------------------------------------------

describe("seedUntrackedDeclaredPaths", () => {
  async function makeDirs() {
    const base = await mkdtemp(join(tmpdir(), "seed-untracked-"));
    const root = join(base, "root");
    const wt = join(base, "wt");
    await mkdir(root, { recursive: true });
    await mkdir(wt, { recursive: true });
    return { base, root, wt };
  }

  it("copies a declared path present in root but absent from the worktree", async () => {
    const { base, root, wt } = await makeDirs();
    try {
      await writeFile(join(root, "opencode.json"), '{"a":1}');
      seedUntrackedDeclaredPaths(root, wt, ["opencode.json"]);
      expect(existsSync(join(wt, "opencode.json"))).toBe(true);
      expect(await readFile(join(wt, "opencode.json"), "utf8")).toBe('{"a":1}');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("creates nested parent dirs for a declared path", async () => {
    const { base, root, wt } = await makeDirs();
    try {
      await mkdir(join(root, ".gemini", "commands"), { recursive: true });
      await writeFile(join(root, ".gemini", "commands", "audit-code.toml"), "x = 1");
      seedUntrackedDeclaredPaths(root, wt, [".gemini/commands/audit-code.toml"]);
      expect(existsSync(join(wt, ".gemini", "commands", "audit-code.toml"))).toBe(true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("never clobbers a path already materialized in the worktree (tracked-from-HEAD)", async () => {
    const { base, root, wt } = await makeDirs();
    try {
      await writeFile(join(root, "tracked.txt"), "ROOT-DIRTY");
      await writeFile(join(wt, "tracked.txt"), "WORKTREE-HEAD");
      seedUntrackedDeclaredPaths(root, wt, ["tracked.txt"]);
      expect(await readFile(join(wt, "tracked.txt"), "utf8")).toBe("WORKTREE-HEAD");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("skips a declared path that does not exist in root, and absolute paths", async () => {
    const { base, root, wt } = await makeDirs();
    try {
      seedUntrackedDeclaredPaths(root, wt, ["missing.json", join(root, "abs.json")]);
      expect(existsSync(join(wt, "missing.json"))).toBe(false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe("createWorktree", () => {
  it("calls 'git worktree add -b <branch> <path> HEAD' in the repo root", () => {
    // First spawnSync is the `git rev-parse --show-toplevel` guard → returns the
    // target root itself; the second is the worktree add.
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, "/repo\n"))
      .mockReturnValueOnce(makeSpawnResult(0));

    createWorktree("/repo", "/repo/.audit-tools/worktrees/remediate-BLK-001-RUN-1", "remediate-BLK-001-RUN-1");

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "remediate-BLK-001-RUN-1", "/repo/.audit-tools/worktrees/remediate-BLK-001-RUN-1", "HEAD"],
      expect.objectContaining({ cwd: "/repo", shell: false }),
    );
  });

  it("throws when git exits non-zero", () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, "/repo\n")) // rev-parse guard passes
      .mockReturnValueOnce(makeSpawnResult(1, "", "fatal: branch already exists"));

    expect(() =>
      createWorktree("/repo", "/repo/some/path", "my-branch"),
    ).toThrow(/git worktree add failed/);
  });

  it("refuses when the target root is not inside a git repository", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(128, "", "fatal: not a git repository"));

    expect(() =>
      createWorktree("/not-a-repo", "/not-a-repo/wt", "br"),
    ).toThrow(/not inside a git repository/);
    // The worktree add must never run when the guard refuses.
    const addCall = spawnSyncMock.mock.calls.find(
      (call) => call[0] === "git" && (call[1] as string[])[0] === "worktree",
    );
    expect(addCall).toBeUndefined();
  });

  it("refuses (does not walk up) when the git top-level is an ancestor repo", () => {
    // The target root is a non-git subdir whose enclosing repo is the parent;
    // a bare `git worktree add` would escape upward. The guard must refuse.
    spawnSyncMock.mockReturnValue(makeSpawnResult(0, "/parent\n"));

    expect(() =>
      createWorktree("/parent/child", "/parent/child/wt", "br"),
    ).toThrow(/escape to an ancestor repo/);
    const addCall = spawnSyncMock.mock.calls.find(
      (call) => call[0] === "git" && (call[1] as string[])[0] === "worktree",
    );
    expect(addCall).toBeUndefined();
  });

  it("uses shell: false", () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, "/repo\n"))
      .mockReturnValueOnce(makeSpawnResult(0));
    createWorktree("/repo", "/repo/wt", "br");
    expect(spawnSyncMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ shell: false }),
    );
  });
});

// ---------------------------------------------------------------------------
// removeWorktree
// ---------------------------------------------------------------------------

describe("removeWorktree", () => {
  it("calls 'git worktree remove --force <path>'", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(0));

    removeWorktree("/repo", "/repo/.audit-tools/worktrees/remediate-X-Y");

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "remove", "--force", "/repo/.audit-tools/worktrees/remediate-X-Y"],
      expect.objectContaining({ cwd: "/repo", shell: false }),
    );
  });

  it("does not throw on non-zero exit (best-effort)", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(1, "", "some error"));

    // Should not throw
    expect(() => removeWorktree("/repo", "/repo/wt")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyNodeInWorktree
// ---------------------------------------------------------------------------

describe("verifyNodeInWorktree", () => {
  it("runs each targeted_command as an opaque string through the platform shell in the worktree cwd", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(0, "ok", ""));

    verifyNodeInWorktree("/repo/wt", ["npm test", "npm run lint"]);

    // targeted_commands are opaque host-authored strings run through the platform
    // shell (shell:true) so cmd.exe/sh — not a word-split argv spawn — resolves
    // the verb. This is what makes verify OS-agnostic: `.cmd` shims (npm/npx/...)
    // exec natively on win32 and PATH commands resolve everywhere.
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npm test",
      expect.objectContaining({ cwd: "/repo/wt", shell: true }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npm run lint",
      expect.objectContaining({ cwd: "/repo/wt", shell: true }),
    );
  });

  it("runs a non-executable verb through the shell verbatim (regression: shell:false ENOENT'd the spawn on win32)", () => {
    // The bug: word-split + spawnSync(shell:false) ENOENT'd the *spawn itself*
    // for any verb that is not a bare PATH executable (e.g. `grep` on win32, or
    // a command with pipes/redirections), turning a correct fix into a phantom
    // contract failure that burned the retry budget. shell:true hands the whole
    // string to the shell, which resolves the verb (or fails with a normal
    // non-zero status, never a spawn error).
    spawnSyncMock.mockReturnValue(makeSpawnResult(0, "0", ""));

    const result = verifyNodeInWorktree("/repo/wt", ["grep -c '/packages/' .gitignore"]);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "grep -c '/packages/' .gitignore",
      expect.objectContaining({ cwd: "/repo/wt", shell: true }),
    );
    expect(result.passed).toBe(true);
  });

  it("returns passed: true when all commands exit 0", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(0, "all good", ""));

    const result = verifyNodeInWorktree("/repo/wt", ["npm test"]);
    expect(result.passed).toBe(true);
    expect(result.output).toContain("npm test");
  });

  it("returns passed: false on first non-zero exit and includes the output", () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, "ok", ""))
      .mockReturnValueOnce(makeSpawnResult(1, "", "FAIL: assertion failed"));

    const result = verifyNodeInWorktree("/repo/wt", ["npm test -w pkg1", "npm test -w pkg2"]);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("FAIL: assertion failed");
  });

  it("returns passed: false and surfaces the message when the spawn itself errors", () => {
    spawnSyncMock.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      pid: 0,
      output: [],
      signal: null,
      error: new Error("spawn npm ENOENT"),
    } as ReturnType<typeof spawnSync>);

    const result = verifyNodeInWorktree("/repo/wt", ["npm run build"]);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("ENOENT");
  });

  it("returns passed: true and includes output when no commands are given", () => {
    const result = verifyNodeInWorktree("/repo/wt", []);
    expect(result.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeWorktree
// ---------------------------------------------------------------------------

describe("mergeWorktree", () => {
  it("resolves branch tip and cherry-picks it into HEAD", () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, "abc123\n", "")) // rev-parse
      .mockReturnValueOnce(makeSpawnResult(0, "", ""));          // cherry-pick
    // removeWorktree call
    spawnSyncMock.mockReturnValue(makeSpawnResult(0));

    const result = mergeWorktree("/repo", "/repo/wt", "remediate-blk-run");
    expect(result.success).toBe(true);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "remediate-blk-run"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "git",
      ["cherry-pick", "abc123"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("returns success: false and calls removeWorktree when rev-parse fails", () => {
    spawnSyncMock.mockReturnValueOnce(makeSpawnResult(1, "", "unknown revision"));
    // removeWorktree call
    spawnSyncMock.mockReturnValue(makeSpawnResult(0));

    const result = mergeWorktree("/repo", "/repo/wt", "my-branch");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("my-branch");
    }
  });

  it("aborts cherry-pick and returns success: false when cherry-pick fails", () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult(0, "deadbeef\n", "")) // rev-parse
      .mockReturnValueOnce(makeSpawnResult(1, "", "conflict"))    // cherry-pick fails
      .mockReturnValue(makeSpawnResult(0));                        // cherry-pick --abort + removeWorktree

    const result = mergeWorktree("/repo", "/repo/wt", "br");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("cherry-pick failed");
    }
    // cherry-pick --abort should have been called
    const abortCall = spawnSyncMock.mock.calls.find(
      (call) => call[0] === "git" && (call[1] as string[]).includes("--abort"),
    );
    expect(abortCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// worktreePath
// ---------------------------------------------------------------------------

describe("worktreePath", () => {
  it("returns .audit-tools/worktrees/remediate-<blockId>-<runId> under repo root", () => {
    const result = worktreePath("/my/repo", "BLK-001", "RUN-abc");
    // Normalize separators for cross-platform comparison
    const normalized = result.replace(/\\/g, "/");
    expect(normalized).toBe("/my/repo/.audit-tools/worktrees/remediate-BLK-001-RUN-abc");
  });
});

// ---------------------------------------------------------------------------
// claimedWritePaths heuristic is absent
// ---------------------------------------------------------------------------

describe("claimedWritePaths heuristic absent from prepareImplementDispatch", () => {
  it("dispatch module source does not reference claimedWritePaths", async () => {
    // Read the dispatch source and verify the heuristic is not present.
    // Use import.meta.url to get the tests directory, then navigate to the src file.
    const { readFileSync } = await import("node:fs");
    const { join: pathJoin, dirname: pathDirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const testsDir = pathDirname(fileURLToPath(import.meta.url));
    const dispatchPath = pathJoin(testsDir, "..", "..", "src", "remediate", "steps", "dispatch.ts");
    const source = readFileSync(dispatchPath, "utf8");
    expect(source).not.toContain("claimedWritePaths");
  });
});

// ---------------------------------------------------------------------------
// Worktree-rooted implement prompt rendering
// ---------------------------------------------------------------------------

describe("worktree-rooted implement prompt rendering", () => {
  // We test implementPrompt indirectly via checking the dispatch source uses worktreeRoot.
  // Since implementPrompt is not exported, we verify the source-level contract.
  it("dispatch source references worktreeRoot in prompt rendering (not always the repo root)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join: pathJoin, dirname: pathDirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const testsDir = pathDirname(fileURLToPath(import.meta.url));
    const dispatchPath = pathJoin(testsDir, "..", "..", "src", "remediate", "steps", "dispatch.ts");
    const source = readFileSync(dispatchPath, "utf8");
    // The dispatch source must reference worktreeRoot so isolated workers see
    // their worktree path, not the main repo root.
    expect(source).toContain("worktreeRoot");
  });
});
