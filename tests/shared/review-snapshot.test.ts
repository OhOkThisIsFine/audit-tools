/**
 * Disposable detached review-snapshot worktree (mechanical write-scope for
 * spawned CLI review workers): create/remove round-trip, leftover sweep, and
 * the non-git degrade contract.
 */

import { test, expect } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSyncHidden } from "../helpers/spawn.mjs";

import {
  createReviewSnapshot,
  removeReviewSnapshot,
} from "../../src/shared/providers/reviewSnapshot.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

function git(cwd: string, ...args: string[]): string {
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
    if (snap.path === null) return;
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

test("missing snapshot cleanup clears only its registration and preserves a sibling", async () => {
  const root = await makeGitRepo();
  try {
    const vanished = await createReviewSnapshot(root, "run-vanished");
    const sibling = await createReviewSnapshot(root, "run-sibling");
    expect(vanished.path).not.toBe(null);
    expect(sibling.path).not.toBe(null);
    if (vanished.path === null || sibling.path === null) return;

    // Simulate an external cleanup / crashed-drive fallback: directory gone,
    // worktree registration still present.
    await rm(vanished.path, { recursive: true, force: true });
    await removeReviewSnapshot(root, "run-vanished");

    const registrations = git(root, "worktree", "list", "--porcelain")
      .replace(/\\/g, "/")
      .toLowerCase();
    expect(registrations).not.toContain(vanished.path.replace(/\\/g, "/").toLowerCase());
    expect(registrations).toContain(sibling.path.replace(/\\/g, "/").toLowerCase());
    expect(existsSync(sibling.path), "path-scoped cleanup must not touch sibling dir").toBe(true);

    await removeReviewSnapshot(root, "run-sibling");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fallback cleanup is path-scoped when a sibling registration has no directory", async () => {
  const root = await makeGitRepo();
  try {
    const target = await createReviewSnapshot(root, "run-target");
    const sibling = await createReviewSnapshot(root, "run-sibling");
    expect(target.path).not.toBe(null);
    expect(sibling.path).not.toBe(null);
    if (target.path === null || sibling.path === null) return;

    // Put the sibling in the precise race window where a global prune is unsafe:
    // its directory is transiently absent while its registration remains live.
    await rm(sibling.path, { recursive: true, force: true });

    let targetRemoveAttempts = 0;
    const failFirstTargetRemove = async (cwd: string, args: string[]) => {
      if (
        args[0] === "worktree" &&
        args[1] === "remove" &&
        args.at(-1) === target.path
      ) {
        targetRemoveAttempts += 1;
        if (targetRemoveAttempts === 1) {
          throw new Error("simulated first remove failure");
        }
      }
      return git(cwd, ...args);
    };

    await removeReviewSnapshot(root, "run-target", failFirstTargetRemove);

    const registrations = git(root, "worktree", "list", "--porcelain")
      .replace(/\\/g, "/")
      .toLowerCase();
    expect(targetRemoveAttempts, "fallback must retry the target-specific remove").toBe(2);
    expect(registrations).not.toContain(target.path.replace(/\\/g, "/").toLowerCase());
    expect(registrations).toContain(sibling.path.replace(/\\/g, "/").toLowerCase());
    expect(existsSync(sibling.path), "fixture must keep the sibling path absent").toBe(false);

    await removeReviewSnapshot(root, "run-sibling");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production source never shells out to global `git worktree prune`", async () => {
  const sourceFiles = git(REPO_ROOT, "ls-files", "src")
    .split(/\r?\n/)
    .filter((path) => /\.(?:[cm]?[jt]s|tsx)$/.test(path));
  const offenders: string[] = [];
  for (const path of sourceFiles) {
    const source = await readFile(join(REPO_ROOT, path), "utf8");
    if (/\[\s*["']worktree["']\s*,\s*["']prune["']\s*\]/.test(source)) {
      offenders.push(path);
    }
  }
  expect(offenders).toEqual([]);
});

test("createReviewSnapshot rejects a nested root owned by an ancestor repository", async () => {
  const ancestor = await makeGitRepo();
  const root = join(ancestor, "nested-project");
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "nested.txt"), "nested project content\n", "utf8");

    const snap = await createReviewSnapshot(root, "run-nested");

    expect(snap.path).toBe(null);
    if (snap.path !== null) return;
    expect(snap.reason).toMatch(/git top-level|ancestor/i);
  } finally {
    await removeReviewSnapshot(root, "run-nested");
    await rm(ancestor, { recursive: true, force: true });
  }
});

test("createReviewSnapshot on a non-git root degrades with a reason, never throws", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-snap-nogit-"));
  try {
    const snap = await createReviewSnapshot(root, "run-1");
    expect(snap.path).toBe(null);
    if (snap.path !== null) return;
    expect(typeof snap.reason).toBe("string");
    expect(snap.reason.length > 0).toBe(true);
    await removeReviewSnapshot(root, "run-1"); // no-op, must not throw
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
