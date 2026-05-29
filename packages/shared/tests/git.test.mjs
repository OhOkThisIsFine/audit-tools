import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const { isGitRepo, changedFiles, fileCommits, stagedAndUntracked } = await import(
  "../dist/git.js"
);

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
