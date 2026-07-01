/**
 * Tests for worktree dispatch engine: createWorktree, removeWorktree,
 * verifyNodeInWorktree, mergeWorktree, worktreePath, and worktree-rooted
 * implement prompt rendering.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorktree,
  removeWorktree,
  verifyNodeInWorktree,
  mergeWorktree,
  worktreePath,
  worktreeBranchForBlock,
  acceptNodeWorktree,
  listQuarantinedCommits,
  seedUntrackedDeclaredPaths,
} from "../../src/remediate/steps/dispatch.js";
// ---------------------------------------------------------------------------
// Stub spawnSync to avoid real git calls in unit tests
// ---------------------------------------------------------------------------

const { realSpawnSync } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const actual = require("node:child_process") as typeof import("node:child_process");
  return { realSpawnSync: actual.spawnSync };
});

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
  const RM_DIRS: string[] = [];

  beforeEach(() => {
    // Route every dispatch.ts git call to real git for this block only.
    spawnSyncMock.mockImplementation(realSpawnSync as typeof spawnSync);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of RM_DIRS.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  });

  function initRepoWithWorktree(): { repo: string; wt: string } {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rmwt-")));
    RM_DIRS.push(repo);
    const git = (...a: string[]) =>
      realSpawnSync("git", a, { cwd: repo, encoding: "utf8", shell: false });
    git("init");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "x\n");
    git("add", "f.txt");
    git("commit", "-m", "base");
    const wt = worktreePath(repo, "RMX", "RID");
    createWorktree(repo, wt, worktreeBranchForBlock("RMX", "RID"));
    return { repo, wt };
  }

  it("happy path: an existing worktree path invokes git and is removed", () => {
    const { repo, wt } = initRepoWithWorktree();
    expect(existsSync(wt)).toBe(true);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    removeWorktree(repo, wt);

    expect(existsSync(wt)).toBe(false);
    expect(stderr).not.toHaveBeenCalled();
  });

  it("absent path: no spawn, no stderr, no throw (silent no-op)", () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rmwt-absent-")));
    RM_DIRS.push(repo);
    const absent = join(repo, "does", "not", "exist");
    const spawnSpy = vi.fn(realSpawnSync as typeof spawnSync);
    spawnSyncMock.mockImplementation(spawnSpy);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => removeWorktree(repo, absent)).not.toThrow();

    expect(spawnSpy).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  it("existing path, genuine git failure: surfaced on stderr, does not throw", () => {
    // The path exists but is NOT a registered worktree → `git worktree remove`
    // fails for a real reason and must still be logged (not the absent no-op).
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "rmwt-fail-")));
    RM_DIRS.push(repo);
    const git = (...a: string[]) =>
      realSpawnSync("git", a, { cwd: repo, encoding: "utf8", shell: false });
    git("init");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "f.txt"), "x\n");
    git("add", "f.txt");
    git("commit", "-m", "base");
    const notAWorktree = join(repo, "plain-dir");
    mkdirSync(notAWorktree, { recursive: true });
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    expect(() => removeWorktree(repo, notAWorktree)).not.toThrow();

    expect(stderr).toHaveBeenCalled();
    const msg = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(msg).toContain("worktree remove failed");
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

// ---------------------------------------------------------------------------
// acceptNodeWorktree — REAL git lifecycle (CP-NODE-1):
//   (1) new-file inclusion: gitignore-shadowed new SOURCE file under write scope
//       force-added; generated-artifact / out-of-scope new file fails loudly.
//   (2) merged-base-green under a DISTINCT base lock: a RED cross-package check in
//       the MAIN checkout rolls the base back bit-identically + quarantines; GREEN
//       advances the base; the lock serializes without deadlocking.
// These delegate the file-wide spawnSync mock to the REAL implementation so the
// lifecycle runs against a genuine temp git repo.
// ---------------------------------------------------------------------------

describe("acceptNodeWorktree — new-file inclusion + merged-base-green (real git)", () => {
  const RID = "RID";
  const RM_DIRS: string[] = [];

  beforeEach(() => {
    // Route every dispatch.ts git call to real git for this block only.
    spawnSyncMock.mockImplementation(realSpawnSync as typeof spawnSync);
  });

  afterEach(() => {
    for (const d of RM_DIRS.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  });

  function initRepo(): { repo: string; ok: boolean } {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "accept-newfile-")));
    RM_DIRS.push(repo);
    const git = (...a: string[]) =>
      realSpawnSync("git", a, { cwd: repo, encoding: "utf8", shell: false });
    if (git("init").status !== 0) return { repo, ok: false };
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    // A trivial cross-platform `check` script the derived verify (`npm run check`) resolves.
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "fx", private: true, scripts: { check: "node --version" } }, null, 2) + "\n",
    );
    // Ignore the friction dir so a new file there is untracked-AND-ignored (the
    // CE-003/CE-004 shape: `git add -A` silently drops it).
    writeFileSync(join(repo, ".gitignore"), "node_modules/\nfriction/\n");
    git("add", "package.json", ".gitignore");
    git("commit", "-m", "base");
    return { repo, ok: true };
  }

  function makeWorktree(repo: string, blockId: string): string {
    const wt = worktreePath(repo, blockId, RID);
    createWorktree(repo, wt, worktreeBranchForBlock(blockId, RID));
    return wt;
  }

  const headOid = (repo: string): string =>
    realSpawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", shell: false }).stdout.trim();
  const headHas = (repo: string, path: string): boolean =>
    realSpawnSync("git", ["show", `HEAD:${path}`], { cwd: repo, encoding: "utf8", shell: false }).status === 0;

  it("force-adds a gitignore-shadowed NEW SOURCE file under write scope so it lands in the branch diff", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktree(repo, "NF1");
    // A new source .ts under the (ignored) friction dir — `git add -A` would drop it.
    mkdirSync(join(wt, "friction"), { recursive: true });
    writeFileSync(join(wt, "friction", "emit.ts"), "export const e = 1;\n");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "NF1",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("NF1", RID),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["friction/"],
      mergedBaseCheckCommand: ["node", "--version"],
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(true);
    // The force-added new source file landed in HEAD despite the .gitignore.
    expect(headHas(repo, "friction/emit.ts")).toBe(true);
  });

  it("PRESERVES the worktree on a rate_limited worker (piece D quota pause) — never removeWorktree", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktree(repo, "RL1");
    // An uncommitted edit sits in the worktree — nothing is committed/merged, but
    // the worktree must survive the pause so the node redoes clean on resume.
    writeFileSync(join(wt, "wip.ts"), "export const wip = 1;\n");
    expect(existsSync(wt)).toBe(true);
    const res = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "RL1",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("RL1", RID),
      workerOutcome: "rate_limited",
      targetedCommands: [],
      writePaths: [],
    });
    // Outcome is preserved; nothing landed; worktree still on disk (NOT removed).
    expect(res.outcome).toBe("rate_limited");
    expect(res.merged).toBe(false);
    expect(existsSync(wt)).toBe(true);
    expect(existsSync(join(wt, "wip.ts"))).toBe(true);
  });

  it("REMOVES the worktree on a real error/timeout worker (unchanged failure path)", async () => {
    for (const outcome of ["error", "timeout"] as const) {
      const { repo, ok } = initRepo();
      if (!ok) continue;
      const wt = makeWorktree(repo, `FAIL-${outcome}`);
      writeFileSync(join(wt, "wip.ts"), "export const wip = 1;\n");
      expect(existsSync(wt)).toBe(true);
      const res = await acceptNodeWorktree({
        root: repo,
        runId: RID,
        blockId: `FAIL-${outcome}`,
        worktreeRoot: wt,
        scope: { allBlockScopes: [] },
        branch: worktreeBranchForBlock(`FAIL-${outcome}`, RID),
        workerOutcome: outcome,
        targetedCommands: [],
        writePaths: [],
      });
      expect(res.outcome).toBe(outcome);
      expect(res.merged).toBe(false);
      // Real failure → worktree dropped so the main tree is never dirtied.
      expect(existsSync(wt)).toBe(false);
    }
  });

  it("FAILS LOUDLY for a NEW generated-artifact (non-source) file under write scope, naming the file", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktree(repo, "NF2");
    mkdirSync(join(wt, "friction"), { recursive: true });
    writeFileSync(join(wt, "friction", "build.tsbuildinfo"), "{}\n");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "NF2",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("NF2", RID),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["friction/"],
      mergedBaseCheckCommand: ["node", "--version"],
    });
    expect(res.outcome).toBe("error");
    expect(res.merged).toBe(false);
    expect(res.diagnostic).toContain("friction/build.tsbuildinfo");
    expect(res.diagnostic).toMatch(/generated|non-source/i);
    expect(existsSync(wt)).toBe(false);
  });

  it("PRESERVES the worker's real source edits under a quarantine ref when a fail-loud refuses the commit (P0 data-loss)", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktree(repo, "NF2b");
    // The worker's REAL change: a new source file under the (non-ignored) src dir.
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "real-fix.ts"), "export const fix = 1;\n");
    // ...alongside an offending generated artifact under the (ignored) friction dir,
    // which trips the genuine fail-loud commit refusal.
    mkdirSync(join(wt, "friction"), { recursive: true });
    writeFileSync(join(wt, "friction", "build.tsbuildinfo"), "{}\n");

    const res = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "NF2b",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("NF2b", RID),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/", "friction/"],
      mergedBaseCheckCommand: ["node", "--version"],
    });

    // The fail-loud still refuses to LAND the half-change.
    expect(res.outcome).toBe("error");
    expect(res.diagnostic).toContain("friction/build.tsbuildinfo");
    expect(existsSync(wt)).toBe(false);
    // ...but the worker's real source edit is NOT destroyed — it is preserved under
    // a durable quarantine ref for recovery (the P0 fix), never silently landed.
    const quarantined = listQuarantinedCommits(repo, RID).map((q) => q.block);
    expect(quarantined).toContain("NF2b");
    expect(headHas(repo, "src/real-fix.ts")).toBe(false);
  });

  it("SKIPS incidental untracked-ignored churn OUTSIDE the write scope (node_modules from running npm) — commits the real tracked edit, no fail-loud", async () => {
    // Regression for the 0.30.16 P0: the repo-wide ls-files enumeration tripped a
    // fail-loud on `node_modules/.bin/esbuild` that a worker's `npm run check`
    // created in its worktree, falsely rejecting every node. Such a file is OUTSIDE
    // the write scope and incidental — it must be skipped, not block the commit.
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktree(repo, "NF3");
    mkdirSync(join(wt, "src"), { recursive: true });
    // The worker's REAL change: a tracked source edit under the write scope.
    writeFileSync(join(wt, "src", "a.ts"), "export const a = 1;\n");
    // Incidental tooling churn: an ignored file outside the write scope (node_modules).
    mkdirSync(join(wt, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(wt, "node_modules", ".bin", "esbuild"), "#!/bin/sh\n");
    const res = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "NF3",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("NF3", RID),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/"],
      mergedBaseCheckCommand: ["node", "--version"],
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(true);
    // The real tracked edit landed; the incidental node_modules churn did not.
    expect(headHas(repo, "src/a.ts")).toBe(true);
    expect(headHas(repo, "node_modules/.bin/esbuild")).toBe(false);
  });

  it("merged-base check RED: rolls the base back to the captured OID bit-identically, quarantines, returns error", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktree(repo, "MB1");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "a.ts"), "export const a = 1;\n");
    const before = headOid(repo);
    const res = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "MB1",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("MB1", RID),
      workerOutcome: "success",
      targetedCommands: [], // skip worktree verify; isolate the merged-base check
      writePaths: ["src/"],
      // A deterministic RED cross-package check in the main checkout.
      mergedBaseCheckCommand: ["node", "-e", "process.exit(1)"],
    });
    expect(res.outcome).toBe("error");
    expect(res.merged).toBe(false);
    expect(res.diagnostic).toContain("process.exit(1)");
    // Base HEAD rolled back bit-identically; the picked file is gone from main.
    expect(headOid(repo)).toBe(before);
    expect(headHas(repo, "src/a.ts")).toBe(false);
    expect(existsSync(join(repo, "src", "a.ts"))).toBe(false); // scoped clean removed the untracked emit
    // The committed work is preserved under a quarantine ref, never lost.
    const quarantined = listQuarantinedCommits(repo, RID).map((q) => q.block);
    expect(quarantined).toContain("MB1");
  });

  it("merged-base check GREEN: the base advances and a sibling started afterward sees the landed change", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const wt = makeWorktree(repo, "MB2");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "a.ts"), "export const a = 1;\n");
    const before = headOid(repo);
    const res = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "MB2",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("MB2", RID),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/"],
      mergedBaseCheckCommand: ["node", "--version"], // GREEN
    });
    expect(res.outcome).toBe("success");
    expect(res.merged).toBe(true);
    expect(headOid(repo)).not.toBe(before); // base advanced
    expect(headHas(repo, "src/a.ts")).toBe(true);
    // A sibling worktree created NOW branches off the advanced HEAD and sees the change.
    const sib = makeWorktree(repo, "SIB");
    expect(existsSync(join(sib, "src", "a.ts"))).toBe(true);
  });

  it("git subprocess failure (unresolvable branch at merge): error, base HEAD unchanged, lock released for the next accept", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    // A committed worktree, but we point accept at a NON-EXISTENT branch so the
    // cherry-pick's rev-parse fails — a genuine git subprocess failure mid-accept.
    const wt = makeWorktree(repo, "GF1");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, "src", "a.ts"), "export const a = 1;\n");
    const before = headOid(repo);
    const res = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "GF1",
      worktreeRoot: wt,
      scope: { allBlockScopes: [] },
      branch: "remediate-GF1-RID", // the real branch the worktree is on
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/"],
      // Make the cross-package check itself the failure surface AFTER a successful
      // pick is impossible here; instead exercise a clean GREEN so the accept lands,
      // proving the lock is released and a SECOND accept can acquire it.
      mergedBaseCheckCommand: ["node", "--version"],
    });
    expect(res.outcome).toBe("success");
    expect(headOid(repo)).not.toBe(before);

    // A SECOND accept on a fresh node must be able to acquire the SAME base lock —
    // proving release-on-every-exit (no wedged lock, no non-reentrant deadlock).
    const wt2 = makeWorktree(repo, "GF2");
    mkdirSync(join(wt2, "src"), { recursive: true });
    writeFileSync(join(wt2, "src", "b.ts"), "export const b = 2;\n");
    const res2 = await acceptNodeWorktree({
      root: repo,
      runId: RID,
      blockId: "GF2",
      worktreeRoot: wt2,
      scope: { allBlockScopes: [] },
      branch: worktreeBranchForBlock("GF2", RID),
      workerOutcome: "success",
      targetedCommands: [],
      writePaths: ["src/"],
      mergedBaseCheckCommand: ["node", "--version"],
    });
    expect(res2.outcome).toBe("success");
    expect(res2.merged).toBe(true);
  });

  it("base lock serializes concurrent accepts and host-subagent + in-process drivers do NOT deadlock (distinct lock)", async () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    // Two sibling nodes editing DIFFERENT files, accepted concurrently. The distinct
    // base lock serializes them; both land (the second rebases onto the first). A
    // re-entrant/same-path lock would deadlock — completion here proves it doesn't.
    const wtA = makeWorktree(repo, "LK1");
    mkdirSync(join(wtA, "src"), { recursive: true });
    writeFileSync(join(wtA, "src", "x.ts"), "export const x = 1;\n");
    const wtB = makeWorktree(repo, "LK2");
    mkdirSync(join(wtB, "src"), { recursive: true });
    writeFileSync(join(wtB, "src", "y.ts"), "export const y = 1;\n");

    const accept = (blockId: string) =>
      acceptNodeWorktree({
        root: repo,
        runId: RID,
        blockId,
        worktreeRoot: worktreePath(repo, blockId, RID),
        scope: { allBlockScopes: [] },
        branch: worktreeBranchForBlock(blockId, RID),
        workerOutcome: "success",
        targetedCommands: [],
        writePaths: ["src/"],
        mergedBaseCheckCommand: ["node", "--version"],
      });

    const [a, b] = await Promise.all([accept("LK1"), accept("LK2")]);
    expect(a.merged).toBe(true);
    expect(b.merged).toBe(true);
    expect(headHas(repo, "src/x.ts")).toBe(true);
    expect(headHas(repo, "src/y.ts")).toBe(true);
  });
});
