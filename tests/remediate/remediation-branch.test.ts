/**
 * BUG 1 — remediate must never modify the base branch. Accepted node commits land
 * on a dedicated `remediation/<runId>` branch created from the base; the run leaves
 * it for review (it does not merge back). Covers the derived branch name and the
 * idempotent checkout primitive against a real git repo.
 */
import { describe, it, expect } from "vitest";
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  remediationBranchName,
  ensureRemediationBranchCheckedOut,
  quarantineFailedNodeCommit,
  clearQuarantinedCommit,
  listQuarantinedCommits,
} from "../../src/remediate/steps/dispatch.js";

function git(repo: string, ...args: string[]) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
}

function initRepo(): { repo: string; ok: boolean } {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "rem-branch-")));
  if (git(repo, "init").status !== 0) return { repo, ok: false };
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "--allow-empty", "-m", "base");
  return { repo, ok: true };
}

function currentBranch(repo: string): string {
  return git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
}

describe("remediationBranchName", () => {
  it("derives a stable remediation/ ref from the run id", () => {
    expect(remediationBranchName("PLAN-abc123")).toBe("remediation/PLAN-abc123");
  });

  it("sanitizes ref-unsafe characters and collapses '..'", () => {
    expect(remediationBranchName("plan with spaces/and..dots")).toBe(
      "remediation/plan-with-spaces-and.dots",
    );
  });

  it("falls back to a usable name for an all-unsafe id", () => {
    expect(remediationBranchName("///")).toBe("remediation/run");
  });
});

describe("ensureRemediationBranchCheckedOut", () => {
  it("creates the remediation branch from the base and checks it out, base left intact", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    const base = currentBranch(repo);
    const branch = ensureRemediationBranchCheckedOut(repo, "PLAN-1");
    expect(branch).toBe("remediation/PLAN-1");
    expect(currentBranch(repo)).toBe("remediation/PLAN-1");
    // The base branch still exists and is unchanged.
    expect(git(repo, "rev-parse", "--verify", base).status).toBe(0);
  });

  it("is idempotent across waves — re-checkout, no error", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    ensureRemediationBranchCheckedOut(repo, "PLAN-2");
    const again = ensureRemediationBranchCheckedOut(repo, "PLAN-2");
    expect(again).toBe("remediation/PLAN-2");
    expect(currentBranch(repo)).toBe("remediation/PLAN-2");
  });

  it("returns null on a non-git root (best-effort, never throws)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "rem-nogit-")));
    expect(ensureRemediationBranchCheckedOut(dir, "PLAN-3")).toBeNull();
  });
});

describe("failed-node commit quarantine (BUG 2 — no lost verified fix)", () => {
  it("preserves a failed node's commit so it survives branch -D, then clears", () => {
    const { repo, ok } = initRepo();
    if (!ok) return;
    // A worktree-style node branch carrying a real commit (the would-be fix).
    git(repo, "checkout", "-b", "remediate-BLK1-RID");
    writeFileSync(join(repo, "fix.txt"), "the verified fix");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "fix");
    const sha = git(repo, "rev-parse", "HEAD").stdout.trim();
    git(repo, "checkout", "-"); // leave the node branch (back to base)

    const q = quarantineFailedNodeCommit(repo, "remediate-BLK1-RID", "RID", "BLK1");
    expect(q?.commit).toBe(sha);

    // resetNodeWorktreeAndBranch force-deletes the node branch on re-dispatch...
    git(repo, "branch", "-D", "remediate-BLK1-RID");
    // ...but the commit is STILL reachable via the durable quarantine ref.
    expect(git(repo, "rev-parse", "--verify", q!.ref).stdout.trim()).toBe(sha);

    expect(listQuarantinedCommits(repo, "RID")).toEqual([
      { block: "BLK1", ref: q!.ref, commit: sha },
    ]);

    clearQuarantinedCommit(repo, "RID", "BLK1");
    expect(listQuarantinedCommits(repo, "RID")).toEqual([]);
  });
});
