import { join } from "node:path";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { auditToolsWorktreesDir } from "../io/auditToolsPaths.js";

/**
 * Disposable, DETACHED read-only review worktree — the mechanical write-scope
 * boundary for spawned CLI review workers.
 *
 * A live incident (re-dogfood 2026-07-22) showed prompt-level "treat repo files
 * as read-only" is host discretion, not enforcement: a codex worker under
 * `--sandbox workspace-write --cd <repoRoot>` ran `git checkout main` on the
 * operator's real checkout mid-run (the sandbox roots the WRITABLE region at
 * the repo — the opposite of protective here), and the agy lane carries no
 * sandbox at all. Per-CLI flags therefore cannot cover every lane; what covers
 * ALL of them uniformly is the `repoRoot`/cwd the single spawn chokepoint
 * launches against. Pointing that at a disposable `git worktree add --detach`
 * snapshot of HEAD makes any worker-side mutation — checkout, reset, direct
 * file writes — land in a throwaway copy while the real checkout stays
 * untouched ([[enforce-robustness-in-tooling-not-host-discretion]]).
 *
 * Properties:
 *  - DETACHED (no branch): review needs no merge-back, and a branch would
 *    pollute `git branch` output and block same-name recreation.
 *  - Snapshot of HEAD, tracked files only: audit review of a dirty working
 *    tree sees HEAD, not the dirt — acceptable because planning hashes ride
 *    the staleness DAG (a commit re-plans anyway), and deliberate: the
 *    alternative (auditing live dirt) races the operator's editor.
 *  - Deterministic per-run path under the gitignored `.audit-tools/worktrees/`
 *    (same convention as remediate's node worktrees); recreated fresh per
 *    drive so a mid-run commit is picked up, leftovers from a crashed drive
 *    are removed first.
 *  - Creation failure (non-git root, exotic setups) returns `{path: null}`
 *    with a reason — callers DEGRADE to the real root with a loud friction
 *    record rather than blocking the run. A non-git root has no `.git` to
 *    corrupt, which bounds the degraded exposure.
 */
export interface ReviewSnapshotFailure {
  path: null;
  reason: string;
}
export interface ReviewSnapshotCreated {
  path: string;
}
export type ReviewSnapshotResult = ReviewSnapshotCreated | ReviewSnapshotFailure;

function snapshotPath(root: string, runId: string): string {
  // Worktree dir names must be filesystem-safe; run ids are already `[\w.-]`
  // shaped, but sanitize defensively (Windows-safe, mirrors sidecar naming).
  const safe = runId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(auditToolsWorktreesDir(root), `review-${safe}`);
}

async function git(cwd: string, args: string[]): Promise<string> {
  // child_process is resolved LAZILY, at first git call — never at module load.
  // This module rides the shared barrel into test files that partially mock
  // node:child_process (without an execFile export); a top-level
  // `promisify(execFile)` would crash those suites at collection time even
  // though they never call the snapshot functions.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

/** Create (recreating over any crashed-drive leftover) the run's review snapshot. */
export async function createReviewSnapshot(
  root: string,
  runId: string,
): Promise<ReviewSnapshotResult> {
  try {
    // Inside the try: `auditToolsWorktreesDir` throws on a drifted root (a root
    // already inside a `.audit-tools` tree), and this function's contract is
    // degrade-with-reason, never throw.
    const path = snapshotPath(root, runId);
    await git(root, ["rev-parse", "--is-inside-work-tree"]);
    await removeReviewSnapshot(root, runId);
    await git(root, ["worktree", "add", "--detach", path, "HEAD"]);
    return { path };
  } catch (err) {
    return {
      path: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Best-effort removal (drive end / pre-create sweep). A worker straggler
 * holding the cwd can EBUSY the removal on Windows — degrade to a plain
 * recursive delete + `git worktree prune` so the registration never dangles;
 * a still-failing delete is left for the next drive's pre-create sweep.
 */
export async function removeReviewSnapshot(root: string, runId: string): Promise<void> {
  let path: string;
  try {
    path = snapshotPath(root, runId);
  } catch {
    return; // drifted root — nothing was ever created there
  }
  if (!existsSync(path)) return;
  try {
    await git(root, ["worktree", "remove", "--force", path]);
  } catch {
    try {
      await rm(path, { recursive: true, force: true });
      await git(root, ["worktree", "prune"]);
    } catch {
      /* leftover swept by the next createReviewSnapshot */
    }
  }
}
