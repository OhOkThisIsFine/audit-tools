import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const execFileAsync = promisify(execFile);

const WORKTREE_DIR = "worktrees";

export function worktreeBasePath(artifactsDir: string): string {
  return join(artifactsDir, WORKTREE_DIR);
}

export function worktreePathForBlock(artifactsDir: string, blockId: string): string {
  // Sanitize blockId for filesystem safety
  const safe = blockId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(worktreeBasePath(artifactsDir), safe);
}

export async function createWorktree(
  repoRoot: string,
  artifactsDir: string,
  blockId: string,
): Promise<string> {
  const wtPath = worktreePathForBlock(artifactsDir, blockId);
  if (existsSync(wtPath)) {
    // Worktree already exists (crash recovery) — reuse it
    return wtPath;
  }
  await mkdir(worktreeBasePath(artifactsDir), { recursive: true });
  const branchName = `remediate-${blockId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  try {
    await execFileAsync("git", ["worktree", "add", "-b", branchName, wtPath, "HEAD"], {
      cwd: repoRoot,
    });
  } catch (error) {
    // Branch may already exist from a prior interrupted run
    if (String(error).includes("already exists")) {
      await execFileAsync("git", ["worktree", "add", wtPath, branchName], {
        cwd: repoRoot,
      });
    } else {
      throw error;
    }
  }
  return wtPath;
}

export async function mergeWorktree(
  repoRoot: string,
  artifactsDir: string,
  blockId: string,
): Promise<{ merged: boolean; conflicted: boolean; error?: string }> {
  const wtPath = worktreePathForBlock(artifactsDir, blockId);
  if (!existsSync(wtPath)) {
    return { merged: false, conflicted: false, error: "Worktree does not exist" };
  }
  const branchName = `remediate-${blockId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;

  // Check if worktree has any commits beyond HEAD
  try {
    const { stdout: diffOutput } = await execFileAsync(
      "git", ["diff", "--stat", "HEAD", branchName],
      { cwd: repoRoot },
    );
    if (!diffOutput.trim()) {
      // No changes — clean up
      await removeWorktree(repoRoot, artifactsDir, blockId);
      return { merged: true, conflicted: false };
    }
  } catch {
    // diff failed — proceed with merge attempt
  }

  try {
    await execFileAsync("git", ["merge", "--no-ff", "--no-edit", branchName], {
      cwd: repoRoot,
    });
    await removeWorktree(repoRoot, artifactsDir, blockId);
    return { merged: true, conflicted: false };
  } catch (error) {
    // Merge conflict — abort and report
    try {
      await execFileAsync("git", ["merge", "--abort"], { cwd: repoRoot });
    } catch { /* already clean */ }
    return {
      merged: false,
      conflicted: true,
      error: `Merge conflict for block ${blockId}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function removeWorktree(
  repoRoot: string,
  artifactsDir: string,
  blockId: string,
): Promise<void> {
  const wtPath = worktreePathForBlock(artifactsDir, blockId);
  const branchName = `remediate-${blockId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", wtPath], {
      cwd: repoRoot,
    });
  } catch {
    // Worktree might already be removed — try manual cleanup
    await rm(wtPath, { recursive: true, force: true });
    try {
      await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot });
    } catch { /* best effort */ }
  }
  // Clean up the branch
  try {
    await execFileAsync("git", ["branch", "-D", branchName], { cwd: repoRoot });
  } catch { /* branch might not exist */ }
}

export async function cleanupAllWorktrees(
  repoRoot: string,
  artifactsDir: string,
): Promise<void> {
  const base = worktreeBasePath(artifactsDir);
  if (!existsSync(base)) return;
  await rm(base, { recursive: true, force: true });
  try {
    await execFileAsync("git", ["worktree", "prune"], { cwd: repoRoot });
  } catch { /* best effort */ }
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: root });
    return true;
  } catch {
    return false;
  }
}
