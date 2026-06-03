import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { isGitRepo, gitRefExists, changedFiles, fileCommits, stagedAndUntracked } =
  await import("../src/git.ts");

// Build a throwaway git repo with one commit. Mirrors the mkdtemp/rm +
// execFileSync('git', ...) helper pattern from
// packages/remediate-code/tests/phase-implement.test.ts.
async function withTempRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-git-repo-"));
  const git = (...args) =>
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

const here = dirname(fileURLToPath(import.meta.url));
// packages/shared/tests -> repo root is three levels up and holds .git.
const repoRoot = join(here, "..", "..", "..");

test("isGitRepo: true inside the repo, false in a fresh temp dir", async () => {
  assert.equal(isGitRepo(repoRoot), true);
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-git-"));
  try {
    assert.equal(isGitRepo(dir), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("git helpers degrade to empty results outside a repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-git-"));
  try {
    assert.deepEqual(changedFiles(dir, "HEAD"), []);
    assert.deepEqual(stagedAndUntracked(dir), []);
    const commits = fileCommits(dir, "anything.ts");
    assert.ok(commits instanceof Set);
    assert.equal(commits.size, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("gitRefExists distinguishes a valid ref, an unknown ref, and a non-repo dir", async () => {
  await withTempRepo(async (repoRoot) => {
    assert.equal(gitRefExists(repoRoot, "HEAD"), true);
    assert.equal(gitRefExists(repoRoot, "no-such-ref-xyz"), false);
  });
  // Out of a repo it must degrade to false without throwing.
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-git-"));
  try {
    assert.equal(gitRefExists(dir, "HEAD"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("changedFiles/fileCommits/stagedAndUntracked report real changes inside a temp repo", async () => {
  await withTempRepo(async (repoRoot, git) => {
    // fileCommits on the committed file returns at least one 40-hex SHA.
    const commits = fileCommits(repoRoot, "tracked.ts");
    assert.ok(commits instanceof Set);
    assert.ok(commits.size >= 1);
    for (const sha of commits) {
      assert.match(sha, /^[0-9a-f]{40}$/);
    }

    // Capture the ref of the first commit, then edit + commit again so the path
    // shows up in changedFiles relative to that prior ref.
    const firstRef = git("rev-parse", "HEAD").trim();
    await writeFile(join(repoRoot, "tracked.ts"), "export const a = 2;\n", "utf8");
    git("commit", "-q", "-am", "second");
    assert.ok(changedFiles(repoRoot, firstRef).includes("tracked.ts"));

    // A newly written, never-added file is reported by stagedAndUntracked.
    await writeFile(join(repoRoot, "fresh.ts"), "export const b = 3;\n", "utf8");
    assert.ok(stagedAndUntracked(repoRoot).includes("fresh.ts"));
  });
});
