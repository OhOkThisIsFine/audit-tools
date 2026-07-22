/**
 * Disposable detached review-snapshot worktree (mechanical write-scope for
 * spawned CLI review workers): create/remove round-trip, leftover sweep, and
 * the non-git degrade contract.
 */

import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSyncHidden } from "../helpers/spawn.mjs";

const { createReviewSnapshot, removeReviewSnapshot } = await import(
  "../../src/shared/providers/reviewSnapshot.ts"
);

function git(cwd, ...args) {
  return execFileSyncHidden("git", args, { cwd, encoding: "utf8" }).trim();
}

async function makeGitRepo() {
  const root = await mkdtemp(join(tmpdir(), "review-snap-"));
  git(root, "init");
  git(root, "config", "user.email", "t@t");
  git(root, "config", "user.name", "t");
  await writeFile(join(root, "tracked.txt"), "committed content\n", "utf8");
  git(root, "add", ".");
  git(root, "commit", "-m", "init");
  return root;
}

test("createReviewSnapshot yields a detached worktree of HEAD; remove cleans it fully", async () => {
  const root = await makeGitRepo();
  try {
    const snap = await createReviewSnapshot(root, "run-1");
    expect(snap.path, "snapshot must be created in a git repo").not.toBe(null);
    expect(snap.path).not.toBe(root);
    // Contains the committed file at HEAD content (line-ending normalized:
    // autocrlf may rewrite the checkout on Windows).
    expect((await readFile(join(snap.path, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("committed content\n");
    // Detached: same HEAD commit, no branch ref.
    expect(git(snap.path, "rev-parse", "HEAD")).toBe(git(root, "rev-parse", "HEAD"));
    expect(() => git(snap.path, "symbolic-ref", "-q", "HEAD"), "must be detached (no branch)").toThrow();
    // A worker-side mutation inside the snapshot never touches the real tree.
    await writeFile(join(snap.path, "tracked.txt"), "worker vandalism\n", "utf8");
    expect((await readFile(join(root, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("committed content\n");

    await removeReviewSnapshot(root, "run-1");
    expect(existsSync(snap.path), "snapshot dir removed").toBe(false);
    // Registration cleaned: a fresh create at the same path succeeds.
    const again = await createReviewSnapshot(root, "run-1");
    expect(again.path).not.toBe(null);
    await removeReviewSnapshot(root, "run-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createReviewSnapshot sweeps a crashed-drive leftover instead of failing", async () => {
  const root = await makeGitRepo();
  try {
    const first = await createReviewSnapshot(root, "run-x");
    expect(first.path).not.toBe(null);
    // No removal (simulated crash) — a second create must succeed, not EEXIST.
    const second = await createReviewSnapshot(root, "run-x");
    expect(second.path).not.toBe(null);
    await removeReviewSnapshot(root, "run-x");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createReviewSnapshot on a non-git root degrades with a reason, never throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-snap-nogit-"));
  try {
    const snap = await createReviewSnapshot(root, "run-1");
    expect(snap.path).toBe(null);
    expect(typeof snap.reason).toBe("string");
    expect(snap.reason.length > 0).toBe(true);
    await removeReviewSnapshot(root, "run-1"); // no-op, must not throw
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
