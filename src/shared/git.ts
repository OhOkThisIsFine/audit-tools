import { existsSync } from "node:fs";
import { join } from "node:path";
import { runTracked } from "./tooling/exec.js";

// Git helpers shared by both orchestrators. The remediator previously issued
// `git` calls inline in close.ts and plan.ts; the auditor's Phase 3 delta mode
// needs the same primitives. All run through the shared `runTracked` so the
// one Windows-wrapping implementation applies, and all degrade to empty/false
// when git is unavailable or the command fails (never throw).

function gitLines(root: string, args: string[]): string[] {
  const result = runTracked(["git", ...args], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** True when `root` is inside a git working tree. */
export function isGitRepo(root: string): boolean {
  if (existsSync(join(root, ".git"))) return true;
  const result = runTracked(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * True when `ref` resolves to a commit in `root`. Lets callers distinguish a
 * mistyped/unknown `--since` ref (fall back to a full audit) from a valid ref
 * with no changes (`changedFiles` returns `[]` in both cases otherwise).
 */
export function gitRefExists(root: string, ref: string): boolean {
  const result = runTracked(
    ["git", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
    { cwd: root, encoding: "utf8" },
  );
  return result.status === 0 && result.stdout.trim().length > 0;
}

/**
 * Files differing between `since` (a ref/SHA) and the current working tree —
 * committed, staged, and unstaged. Backs the auditor's `--since` delta mode.
 */
export function changedFiles(root: string, since: string): string[] {
  return gitLines(root, ["diff", "--name-only", since]);
}

/** The set of commit SHAs that have touched `path`, newest first. */
export function fileCommits(root: string, path: string): Set<string> {
  return new Set(gitLines(root, ["log", "--format=%H", "--", path]));
}

/** Working-tree changes vs HEAD plus untracked (non-ignored) files. */
export function stagedAndUntracked(root: string): string[] {
  const files = new Set<string>();
  for (const file of gitLines(root, ["diff", "--name-only", "HEAD"])) {
    files.add(file);
  }
  for (const file of gitLines(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
  ])) {
    files.add(file);
  }
  return [...files];
}
