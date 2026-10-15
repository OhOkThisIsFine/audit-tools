import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSyncHidden as execFileSync } from "../helpers/spawn.mjs";
import * as exec from "../../src/shared/tooling/exec.js";
import {
  DirtyPathDiscoveryError,
  readAuditReadState,
  readGitPathList,
  readChangedFiles,
  changedFiles,
  stagedAndUntracked,
} from "../../src/shared/git.js";

const ROOT = join(tmpdir(), "synthetic-git-dirty-paths-root");
const HEAD = "a".repeat(40);
const PRIOR = "b".repeat(40);
const STATUS = [
  "--no-optional-locks", "status", "--porcelain=v1", "-z",
  "--untracked-files=all", "--ignore-submodules=none", "--no-renames",
];
const DIFF = ["diff", "--name-only", "--no-renames", "-z", HEAD];
const UNTRACKED = ["ls-files", "--others", "--exclude-standard", "-z"];
const INSIDE = ["rev-parse", "--is-inside-work-tree"];
const PREFIX = ["rev-parse", "--show-prefix"];
const CURRENT = ["rev-parse", "HEAD"];
const PRIOR_REF = ["rev-parse", "--verify", "--quiet", `${PRIOR}^{commit}`];

function result(stdout: string, overrides: Partial<exec.RunTrackedResult> = {}): exec.RunTrackedResult {
  return { status: 0, stdout, stderr: "", argv: [], duration_ms: 0, ...overrides };
}

function mockGit(
  override: (args: string[]) => exec.RunTrackedResult | undefined = () => undefined,
) {
  return vi.spyOn(exec, "runTrackedAsync").mockImplementation(async (argv) => {
    const args = argv.slice(1);
    const overridden = override(args);
    if (overridden) return overridden;
    if (args[1] === "--is-inside-work-tree") return result("true\n");
    if (args[1] === "--show-prefix") return result("\n");
    if (args[0] === "rev-parse") return result(`${args[1] === "HEAD" ? HEAD : PRIOR}\n`);
    return result("");
  });
}

function matches(actual: string[], expected: string[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function statusFixture(stdout: string) {
  return mockGit((args) => matches(args, STATUS) ? result(stdout) : undefined);
}

afterEach(() => vi.restoreAllMocks());

describe("bounded Git path transport", () => {
  it("uses the exact caller argv, explicit timeout/windowsHide and fixed output bound", async () => {
    const spy = mockGit(() => result(" z \0é.ts\0 z \0"));
    const args = ["diff", "--cached", "--ignore-submodules=none", "--name-only", "-z"];
    expect(await readGitPathList(ROOT, args, { timeout: 5_000, windowsHide: true })).toEqual({
      ok: true, paths: [" z ", "é.ts", " z "],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(["git", ...args], {
      cwd: ROOT, encoding: "utf8", timeout: 5_000,
      maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("refuses an unbounded timeout %s before spawning", async (timeout) => {
    const spy = mockGit();
    expect(await readGitPathList(ROOT, DIFF, { timeout })).toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("separates empty success from malformed NUL output without interpreting stderr", async () => {
    const spy = mockGit(() => result("", { stderr: "not-a-path\0" }));
    expect(await readGitPathList(ROOT, DIFF)).toEqual({ ok: true, paths: [] });
    for (const stdout of ["unterminated", "a\0tail", "a\0\0", "\0"]) {
      spy.mockResolvedValueOnce(result(stdout));
      expect(await readGitPathList(ROOT, DIFF)).toMatchObject({ ok: false });
    }
  });

  const failures: [string, () => exec.RunTrackedResult][] = [
    ["nonzero", () => result("partial\0", { status: 1 })],
    ["null status", () => result("partial\0", { status: null })],
    ["error with zero status", () => result("partial\0", { error: new Error("spawn failed") })],
    ["throw", () => { throw new Error("runner threw"); }],
    ["timeout", () => result("partial\0", {
      status: null, error: Object.assign(new Error("deadline exceeded"), { code: "ETIMEDOUT" }),
    })],
    ["overflow", () => result("partial\0", {
      status: null, error: Object.assign(new Error("output exceeded bound"), { code: "ENOBUFS" }),
    })],
  ];

  it.each(["--output=probe-output", "--stat", "-R", "-"])("rejects option-like delta refs before spawning: %s", async (since) => {
    const spy = mockGit();
    expect(await readChangedFiles(ROOT, since)).toMatchObject({ ok: false, reason: expect.stringContaining("option") });
    expect(await changedFiles(ROOT, since)).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("delta discovery is one bounded NUL query and keeps empty success distinct", async () => {
    const paths = ["ordinary.ts", "é雪😀.ts", 'quote".ts', "line\nbreak.ts", " padded "];
    const spy = mockGit(() => result(`${paths.join("\0")}\0`));
    expect(await readChangedFiles(ROOT, "HEAD")).toEqual({ ok: true, paths });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(["git", "diff", "--name-only", "-z", "HEAD", "--"], {
      cwd: ROOT, encoding: "utf8", timeout: exec.TRACKED_CHILD_DEADLINE_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    const compatible: Promise<string[]> = changedFiles(ROOT, "HEAD");
    expect(await compatible).toEqual(paths);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockResolvedValue(result(""));
    expect(await readChangedFiles(ROOT, "HEAD")).toEqual({ ok: true, paths: [] });
    for (const stdout of ["partial\0\0", "partial\0tail"]) {
      spy.mockResolvedValue(result(stdout));
      expect(await readChangedFiles(ROOT, "HEAD")).toMatchObject({ ok: false });
      expect(await changedFiles(ROOT, "HEAD")).toEqual([]);
    }
  });

  for (const [failure, fail] of failures) {
    it(`delta discovery distinguishes unknown while compatibility returns empty: ${failure}`, async () => {
      mockGit(() => fail());
      const answer = await readChangedFiles(ROOT, "HEAD");
      expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining("git diff") });
      expect(answer).not.toHaveProperty("paths");
      expect(await changedFiles(ROOT, "HEAD")).toEqual([]);
    });
    for (const [operation, args] of [
      ["working-tree probe", INSIDE], ["prefix probe", PREFIX], ["HEAD probe", CURRENT],
      ["audit diff", DIFF], ["audit untracked", UNTRACKED],
    ] as const) {
      it(`audit fails closed on ${operation}: ${failure}`, async () => {
        const spy = mockGit((actual) => matches(actual, [...args]) ? fail() : undefined);
        expect(await readAuditReadState(ROOT)).toBeNull();
        for (const [, options] of spy.mock.calls) {
          expect(options).toMatchObject({
            cwd: ROOT, encoding: "utf8", timeout: exec.TRACKED_CHILD_DEADLINE_MS,
            maxBuffer: 64 * 1024 * 1024,
          });
        }
      });
    }
    for (const [operation, args] of [
      ["working-tree probe", INSIDE], ["prefix probe", PREFIX], ["status", STATUS],
    ] as const) {
      it(`remediation rejects ${operation}: ${failure}`, async () => {
        mockGit((actual) => matches(actual, [...args]) ? fail() : undefined);
        await expect(stagedAndUntracked(ROOT)).rejects.toBeInstanceOf(DirtyPathDiscoveryError);
        await expect(stagedAndUntracked(ROOT)).rejects.toThrow(/git.*(?:failed|status|deadline|output|threw)/i);
      });
    }
    it(`the shared path query discards partial output on ${failure}`, async () => {
      mockGit(() => fail());
      const answer = await readGitPathList(ROOT, DIFF);
      expect(answer).toMatchObject({ ok: false, reason: expect.stringContaining("git diff") });
      expect(answer).not.toHaveProperty("paths");
    });
  }
});

describe("strict porcelain-v1 NUL parsing through remediation discovery", () => {
  it("preserves exact strings and first occurrence order with no audit exclusions", async () => {
    const names = [" z ", "é雪.ts", "line\nbreak", 'quote"name', "literal\\slash", ".audit-tools/state.json"];
    const spy = statusFixture(`${names.map((path) => `?? ${path}\0`).join("")} M  z \0`);
    expect(await stagedAndUntracked(ROOT)).toEqual(names);
    expect(spy.mock.calls.map(([argv]) => argv)).toEqual([
      ["git", ...INSIDE], ["git", ...PREFIX], ["git", ...STATUS],
    ]);
    for (const [, options] of spy.mock.calls) {
      expect(options).toMatchObject({
        cwd: ROOT, encoding: "utf8", timeout: exec.TRACKED_CHILD_DEADLINE_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
    }
  });

  const validPairs = new Set(["??", "D ", " A", " R", " C", "DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  for (const x of " MTARC") for (const y of " MTD") if (x !== " " || y !== " ") validPairs.add(x + y);
  it.each([...validPairs])("accepts status pair %j", async (pair) => {
    const paired = /[RC]/u.test(pair);
    statusFixture(`${pair} destination\0${paired ? "source\0" : ""}`);
    expect(await stagedAndUntracked(ROOT)).toEqual(pair.includes("R") ? ["destination", "source"] : ["destination"]);
  });

  it("consumes synthetic copy sources as paths and separately includes independently dirty sources", async () => {
    statusFixture("C  copied\0 M source-looking-header\0 M independent\0 C other-copy\0independent\0");
    expect(await stagedAndUntracked(ROOT)).toEqual(["copied", "independent", "other-copy"]);
  });

  it("consumes a rename source resembling a status header without reparsing it", async () => {
    statusFixture(" R destination\0?? source-name\0");
    expect(await stagedAndUntracked(ROOT)).toEqual(["destination", "?? source-name"]);
  });

  it.each([
    "?? a", "?? a\0tail", "?? a\0\0", "\0", "M\0", " M\0", " M\ta\0", " M \0",
    "!! ignored\0", "?! mixed\0", "?M mixed\0", "m  lowercase\0", " M?bad\0", "  clean\0",
    "DX bad\0", "# branch main\0", "R  destination\0", " R destination\0\0", "C  destination\0",
    "?? valid\0 M\0",
  ])("refuses malformed stream %j without partial results", async (stdout) => {
    statusFixture(stdout);
    await expect(stagedAndUntracked(ROOT)).rejects.toBeInstanceOf(DirtyPathDiscoveryError);
  });

  it("accepts empty status as a proven clean tree", async () => {
    statusFixture("");
    expect(await stagedAndUntracked(ROOT)).toEqual([]);
  });
});

describe("root admission and audit stamp conservatism", () => {
  for (const [operation, output] of [
    [INSIDE, "false\n"], [INSIDE, " true\n"], [INSIDE, "true\n\n"],
    [PREFIX, "nested/\n"], [PREFIX, "   \n"], [PREFIX, "\n\n"],
    [PREFIX, "\r"],
  ] as const) {
    it(`refuses synthetic malformed/non-root control output ${JSON.stringify(output)} from ${operation[1]}`, async () => {
      mockGit((args) => matches(args, [...operation]) ? result(output) : undefined);
      expect(await readAuditReadState(ROOT)).toBeNull();
      await expect(stagedAndUntracked(ROOT)).rejects.toBeInstanceOf(DirtyPathDiscoveryError);
    });
  }

  it("accepts one terminal CRLF without trimming path control responses", async () => {
    mockGit((args) => matches(args, INSIDE) ? result("true\r\n") : matches(args, PREFIX) ? result("\r\n") : undefined);
    expect(await stagedAndUntracked(ROOT)).toEqual([]);
    expect(await readAuditReadState(ROOT)).toEqual({ commit: HEAD, dirty_paths: [] });
  });

  it.each(["", "HEAD\n", `${HEAD}\ntrailer`, ` ${HEAD}\n`, `${HEAD}\n\n`])("audit refuses malformed current HEAD %j", async (stdout) => {
    mockGit((args) => matches(args, CURRENT) ? result(stdout) : undefined);
    expect(await readAuditReadState(ROOT)).toBeNull();
  });

  it("audit preserves exact names, exclusions and code-unit sorting", async () => {
    mockGit((args) => matches(args, DIFF)
      ? result(" z \0雪\0.audit-tools/state\0excluded\0excluded/child\0excluded-sibling\0")
      : matches(args, UNTRACKED) ? result("雪\0a\nfile\0a\\file\0") : undefined);
    expect(await readAuditReadState(ROOT, undefined, { excludePaths: ["excluded"] })).toEqual({
      commit: HEAD, dirty_paths: [" z ", "a\nfile", "a\\file", "excluded-sibling", "雪"],
    });
  });

  it.each([DIFF, UNTRACKED])("audit refuses malformed listing %j", async (...args) => {
    mockGit((actual) => matches(actual, args) ? result("good\0unterminated") : undefined);
    expect(await readAuditReadState(ROOT)).toBeNull();
  });

  it("retains a prior stamp only when both current and prior dirty lists match exactly", async () => {
    mockGit((args) => args[0] === "diff" ? result("file\0") : undefined);
    expect(await readAuditReadState(ROOT, { commit: PRIOR, dirty_paths: ["file"] })).toEqual({ commit: PRIOR, dirty_paths: ["file"] });
  });

  it.each(["unavailable", "throw", "error", "malformed"])("uses the valid current stamp when prior verification is %s", async (mode) => {
    mockGit((args) => {
      if (!matches(args, PRIOR_REF)) return undefined;
      if (mode === "throw") throw new Error("prior unavailable");
      return result(mode === "malformed" ? "not-a-commit\n" : `${PRIOR}\n`, {
        ...(mode === "unavailable" ? { status: 128 } : {}),
        ...(mode === "error" ? { error: new Error("prior failure") } : {}),
      });
    });
    expect(await readAuditReadState(ROOT, { commit: PRIOR, dirty_paths: [] })).toEqual({ commit: HEAD, dirty_paths: [] });
  });

  it.each(["throw", "malformed", "nonzero"])("uses the valid current stamp when prior dirt is %s", async (mode) => {
    mockGit((args) => {
      if (args[0] !== "diff" || args.at(-1) !== PRIOR) return undefined;
      if (mode === "throw") throw new Error("prior diff failed");
      return result(mode === "malformed" ? "not-terminated" : "", { status: mode === "nonzero" ? 1 : 0 });
    });
    expect(await readAuditReadState(ROOT, { commit: PRIOR, dirty_paths: [] })).toEqual({ commit: HEAD, dirty_paths: [] });
  });
});

type Git = (...args: string[]) => string;
async function withRepo(run: (dir: string, git: Git) => Promise<void>, commit = true): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "git-dirty-paths-"));
  const git: Git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    git("config", "core.autocrlf", "false");
    if (commit) {
      await writeFile(join(dir, "tracked.ts"), "original\n");
      git("add", "tracked.ts");
      git("commit", "-qm", "initial");
    }
    await run(dir, git);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("real Git discovery policy", () => {
  it("remediation fences canceled index edits while audit reads net working-tree content", async () => {
    await withRepo(async (dir, git) => {
      await writeFile(join(dir, "tracked.ts"), "staged\n");
      git("add", "tracked.ts");
      await writeFile(join(dir, "tracked.ts"), "original\n");
      expect(await stagedAndUntracked(dir)).toEqual(["tracked.ts"]);
      expect((await readAuditReadState(dir))?.dirty_paths).toEqual([]);
    });
  });

  it("preserves Unicode, nested untracked files, deletions and both rename endpoints", async () => {
    await withRepo(async (dir, git) => {
      await writeFile(join(dir, "雪.ts"), "unicode\n");
      await writeFile(join(dir, "deleted.ts"), "delete me\n");
      await writeFile(join(dir, ".gitignore"), "ignored/\n");
      git("add", ".");
      git("commit", "-qm", "names");
      await writeFile(join(dir, "雪.ts"), "changed\n");
      await rm(join(dir, "deleted.ts"));
      git("mv", "tracked.ts", "renamed.ts");
      await mkdir(join(dir, "new", "nested"), { recursive: true });
      await writeFile(join(dir, "new", "nested", "file.ts"), "new\n");
      await mkdir(join(dir, "ignored"));
      await writeFile(join(dir, "ignored", "secret"), "ignored\n");
      const expected = ["deleted.ts", "renamed.ts", "tracked.ts", "雪.ts", "new/nested/file.ts"];
      expect(await stagedAndUntracked(dir)).toEqual(expected);
      expect((await readAuditReadState(dir))?.dirty_paths).toEqual([...expected].sort());
    });
  });

  it.skipIf(process.platform === "win32")("preserves actual POSIX whitespace, newline, quote and backslash names", async () => {
    await withRepo(async (dir, git) => {
      const names = [" lead ", "line\nbreak", 'quote"name', "literal\\name"];
      for (const name of names) await writeFile(join(dir, name), "initial\n");
      git("add", ".");
      git("commit", "-qm", "special paths");
      for (const name of names) await writeFile(join(dir, name), "changed\n");
      await writeFile(join(dir, " untracked \n"), "new\n");
      expect(await stagedAndUntracked(dir)).toEqual([...names].sort().concat(" untracked \n"));
      expect((await readAuditReadState(dir))?.dirty_paths).toEqual([...names, " untracked \n"].sort());
    });
  });

  it.skipIf(process.platform === "win32")("includes a file-to-symlink type change", async () => {
    await withRepo(async (dir) => {
      await rename(join(dir, "tracked.ts"), join(dir, "target"));
      await symlink("target", join(dir, "tracked.ts"));
      expect(await stagedAndUntracked(dir)).toEqual(["tracked.ts", "target"]);
      expect((await readAuditReadState(dir))?.dirty_paths).toEqual(["target", "tracked.ts"]);
    });
  });

  it("includes conflicted files", async () => {
    await withRepo(async (dir, git) => {
      const original = git("rev-parse", "HEAD").trim();
      git("checkout", "-qb", "other");
      await writeFile(join(dir, "tracked.ts"), "other\n");
      git("commit", "-qam", "other");
      git("checkout", "-q", "--detach", original);
      await writeFile(join(dir, "tracked.ts"), "ours\n");
      git("commit", "-qam", "ours");
      expect(() => git("merge", "other")).toThrow();
      expect(await stagedAndUntracked(dir)).toEqual(["tracked.ts"]);
      expect((await readAuditReadState(dir))?.dirty_paths).toEqual(["tracked.ts"]);
    });
  });

  it("admits unborn working trees for remediation but not audit", async () => {
    await withRepo(async (dir) => {
      await writeFile(join(dir, "new.ts"), "new\n");
      expect(await stagedAndUntracked(dir)).toEqual(["new.ts"]);
      expect(await readAuditReadState(dir)).toBeNull();
    }, false);
  });

  it("refuses bare, non-repository and nested roots, including a real spaces-only directory", async () => {
    await withRepo(async (dir, git) => {
      for (const name of process.platform === "win32" ? ["nested"] : ["nested", "   "]) {
        await mkdir(join(dir, name));
        await expect(stagedAndUntracked(join(dir, name))).rejects.toBeInstanceOf(DirtyPathDiscoveryError);
        expect(await readAuditReadState(join(dir, name))).toBeNull();
      }
      const bare = join(dir, "bare.git");
      git("init", "--bare", "-q", bare);
      await expect(stagedAndUntracked(bare)).rejects.toBeInstanceOf(DirtyPathDiscoveryError);
      expect(await readAuditReadState(bare)).toBeNull();
    });
    const plain = await mkdtemp(join(tmpdir(), "not-git-dirty-paths-"));
    try {
      await expect(stagedAndUntracked(plain)).rejects.toBeInstanceOf(DirtyPathDiscoveryError);
      expect(await readAuditReadState(plain)).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("admits a linked worktree root", async () => {
    await withRepo(async (_dir, git) => {
      const holder = await mkdtemp(join(tmpdir(), "git-dirty-linked-"));
      const linked = join(holder, "worktree");
      try {
        git("worktree", "add", "--detach", linked, "HEAD");
        await writeFile(join(linked, "tracked.ts"), "changed\n");
        expect(await stagedAndUntracked(linked)).toEqual(["tracked.ts"]);
        expect((await readAuditReadState(linked))?.dirty_paths).toEqual(["tracked.ts"]);
      } finally {
        git("worktree", "remove", "--force", linked);
        await rm(holder, { recursive: true, force: true });
      }
    });
  });
});
