import { test, expect } from "vitest";
import { execFileSyncHidden as execFileSync } from "../helpers/spawn.mjs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isGitRepo, gitRefExists, readChangedFiles, stagedAndUntracked } from "../../src/shared/git.js";

// Build a throwaway git repo with one commit. Mirrors the mkdtemp/rm +
// execFileSync('git', ...) helper pattern from
// packages/remediate-code/tests/phase-implement.test.ts.
async function withTempRepo<T>(
  fn: (dir: string, git: (...args: string[]) => string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-git-repo-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf8" });
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    git("config", "commit.gpgsign", "false");
    await writeFile(join(dir, "tracked.ts"), "export const a = 1;\n", "utf8");
    git("add", "tracked.ts");
    git("commit", "-q", "-m", "initial");
    return await fn(dir, git);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("isGitRepo: true inside a repo, false in a fresh temp dir", async () => {
  await withTempRepo(async root => { expect(await isGitRepo(root)).toBe(true); });
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-git-"));
  try {
    expect(await isGitRepo(dir)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stagedAndUntracked fails closed outside a repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-git-"));
  try {
    await expect(stagedAndUntracked(dir)).rejects.toThrow("Dirty path discovery failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitRefExists distinguishes a valid ref, an unknown ref, and a non-repo dir", async () => {
  await withTempRepo(async (repoRoot) => {
    expect(await gitRefExists(repoRoot, "HEAD")).toBe(true);
    expect(await gitRefExists(repoRoot, "no-such-ref-xyz")).toBe(false);
  });
  // Out of a repo it must degrade to false without throwing.
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-git-"));
  try {
    expect(await gitRefExists(dir, "HEAD")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stagedAndUntracked reports a new untracked file inside a temp repo", async () => {
  await withTempRepo(async (repoRoot) => {
    // A newly written, never-added file is reported by stagedAndUntracked.
    await writeFile(join(repoRoot, "fresh.ts"), "export const b = 3;\n", "utf8");
    expect((await stagedAndUntracked(repoRoot)).includes("fresh.ts")).toBeTruthy();
  });
});

// Unicode and spaces run on Windows too; quote/newline/trailing-space names
// require POSIX filename capabilities. This characterizes transport, not graph keys.
for (const quotePath of [true, false]) {
  test(`readChangedFiles preserves exact paths with core.quotePath=${quotePath}`, async () => {
    await withTempRepo(async (root, git) => {
      git("config", "core.quotePath", String(quotePath));
      const paths = ["ordinary.ts", "é雪😀.ts", "with space.ts", " leading.ts",
        ...(process.platform === "win32" ? [] : ['quote".ts', "line\nbreak.ts", "trailing.ts "])];
      for (const path of paths) await writeFile(join(root, path), "before\n");
      git("add", "-A");
      git("commit", "-qm", "paths");
      for (const path of paths) await writeFile(join(root, path), "after\n");
      const answer = await readChangedFiles(root, "HEAD");
      expect(answer.ok ? [...answer.paths].sort() : answer).toEqual([...paths].sort());
    });
  });
}


test("delta discovery refuses Git output options without creating a file", async () => {
  await withTempRepo(async (root) => {
    await writeFile(join(root, "tracked.ts"), "dirty\n");
    const output = join(root, "probe-output");
    const since = `--output=${output}`;
    expect(await readChangedFiles(root, since)).toMatchObject({ ok: false });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
});


test("structured delta discovery preserves valid commit-range arguments", async () => {
  await withTempRepo(async (root, git) => {
    await writeFile(join(root, "tracked.ts"), "second\n");
    git("commit", "-qam", "second");
    for (const since of ["HEAD~1", "HEAD~1..HEAD", "HEAD~1...HEAD"]) {
      expect(await readChangedFiles(root, since)).toEqual({ ok: true, paths: ["tracked.ts"] });
    }
  });
});
