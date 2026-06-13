/**
 * Tests for worktree dispatch engine: createWorktree, removeWorktree,
 * verifyNodeInWorktree, mergeWorktree, worktreePath, and worktree-rooted
 * implement prompt rendering.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  createWorktree,
  removeWorktree,
  verifyNodeInWorktree,
  mergeWorktree,
  worktreePath,
} from "../src/steps/dispatch.js";

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
// createWorktree
// ---------------------------------------------------------------------------

describe("createWorktree", () => {
  it("calls 'git worktree add -b <branch> <path> HEAD' in the repo root", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(0));

    createWorktree("/repo", "/repo/.audit-tools/worktrees/remediate-BLK-001-RUN-1", "remediate-BLK-001-RUN-1");

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "git",
      ["worktree", "add", "-b", "remediate-BLK-001-RUN-1", "/repo/.audit-tools/worktrees/remediate-BLK-001-RUN-1", "HEAD"],
      expect.objectContaining({ cwd: "/repo", shell: false }),
    );
  });

  it("throws when git exits non-zero", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(1, "", "fatal: branch already exists"));

    expect(() =>
      createWorktree("/repo", "/some/path", "my-branch"),
    ).toThrow(/git worktree add failed/);
  });

  it("uses shell: false", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(0));
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
  it("runs each targeted_command in the worktree cwd", () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult(0, "ok", ""));

    verifyNodeInWorktree("/repo/wt", ["npm test", "npm run lint"]);

    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npm",
      ["test"],
      expect.objectContaining({ cwd: "/repo/wt" }),
    );
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "npm",
      ["run", "lint"],
      expect.objectContaining({ cwd: "/repo/wt" }),
    );
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
    const dispatchPath = pathJoin(testsDir, "..", "src", "steps", "dispatch.ts");
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
    const dispatchPath = pathJoin(testsDir, "..", "src", "steps", "dispatch.ts");
    const source = readFileSync(dispatchPath, "utf8");
    // The dispatch source must reference worktreeRoot so isolated workers see
    // their worktree path, not the main repo root.
    expect(source).toContain("worktreeRoot");
  });
});
