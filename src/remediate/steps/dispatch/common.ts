import { statSync } from "node:fs";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSyncHidden } from "audit-tools/shared";
import {
  AGENT_FEEDBACK_FILENAME,
  detectRepoConventions,
  formatRepoConventions,
  estimateTokensFromBytes,
  normalizeRepoPath,
} from "audit-tools/shared";

export interface DispatchOptions {
  root: string;
  artifactsDir: string;
}

// ---------------------------------------------------------------------------
// Path + set primitives
// ---------------------------------------------------------------------------

/** Normalize a declared path (absolute, repo-relative, or back-slashed) to a repo-relative forward-slash string. */
export function toRepoRelative(p: string, root: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  let s = p.replace(/\\/g, "/");
  if (s.startsWith(normalizedRoot + "/")) {
    s = s.slice(normalizedRoot.length + 1);
  }
  return s;
}

export function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

export function runDir(artifactsDir: string, runId: string, phase: string): string {
  return join(artifactsDir, "runs", runId, phase);
}

export function dispatchPlanPath(
  artifactsDir: string,
  runId: string,
  phase: string,
): string {
  return join(runDir(artifactsDir, runId, phase), "dispatch-plan.json");
}

/**
 * Canonical comparison key for a filesystem path. `realpathSync` resolves
 * symlinks and platform short-names so it matches git's `--show-toplevel`
 * output (macOS TMPDIR `/var`→`/private/var`, Windows 8.3 names); falls back to
 * `resolve` for paths that don't exist on disk (e.g. mocked unit tests).
 */
export function canonicalPathKey(p: string): string {
  try {
    return normalizeRepoPath(realpathSync(p));
  } catch {
    return normalizeRepoPath(resolve(p));
  }
}

/**
 * Deterministic name of the dedicated remediation branch for a run. Derived from
 * the stable run id (= the plan id, constant for the whole remediation) so every
 * wave and the final report resolve the SAME branch without persisting it. Ref-safe:
 * any character outside [A-Za-z0-9._-] collapses to '-'. Distinct from the per-node
 * worktree branches (`remediate-<blockId>-<runId>`) — this uses a `remediation/` ref
 * namespace so the two never collide.
 */
export function refSafeSegment(s: string, fallback: string): string {
  return (
    s
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/\.{2,}/g, ".") // ".." is invalid in a git ref name
      .replace(/^[-.]+|[-.]+$/g, "") || fallback
  );
}

// ---------------------------------------------------------------------------
// Git primitives
// ---------------------------------------------------------------------------

/**
 * The git top-level directory containing `cwd`, or `null` when `cwd` is not
 * inside a git working tree (or git is unavailable). `git rev-parse
 * --show-toplevel` emits a forward-slash absolute path on every platform.
 */
export function gitTopLevel(cwd: string): string | null {
  const result = spawnSyncHidden("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) return null;
  const top = (result.stdout ?? "").trim();
  return top.length > 0 ? top : null;
}

/** True when `root` is inside a git work tree (the git tool is present and it's a repo). */
export function isGitWorkTree(root: string): boolean {
  const probe = spawnSyncHidden(
    "git",
    ["rev-parse", "--is-inside-work-tree"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  return !probe.error && probe.status === 0 && /true/.test(probe.stdout ?? "");
}

/** True when `branch` resolves to a commit in the repo at `root`. */
export function gitBranchExists(root: string, branch: string): boolean {
  const probe = spawnSyncHidden(
    "git",
    ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`],
    { cwd: root, encoding: "utf8", shell: false },
  );
  return !probe.error && probe.status === 0;
}

/** Branch name a block's isolated worktree is created on (mirrors `worktreePath`). */
export function worktreeBranchForBlock(blockId: string, runId: string): string {
  return `remediate-${blockId}-${runId}`;
}

// ---------------------------------------------------------------------------
// Merge-seam: git-diff write-scope enforcement (never trust amended_files)
// ---------------------------------------------------------------------------

/** Outcome of resolving the worker's ACTUAL edited files from git. */
export type GitEditedFiles =
  | { available: true; files: Set<string> }
  /** git is present but a probe failed against a real repo → fail closed. */
  | { available: false; reason: "probe_failed"; error: string }
  /** root is not under version control at all → no ground truth, gate is skipped. */
  | { available: false; reason: "not_a_repo"; error: string };

/**
 * The files a worker's worktree branch changed relative to HEAD — the ground
 * truth for write-scope enforcement. Diffs `HEAD...<branch>` (the branch's own
 * commits). Fail-closed / not-a-repo semantics mirror `gitEditedFiles`.
 */
export function gitEditedFilesForBranch(root: string, branch: string): GitEditedFiles {
  if (!isGitWorkTree(root)) {
    return { available: false, reason: "not_a_repo", error: "root is not a git work tree" };
  }
  const diff = spawnSyncHidden(
    "git",
    ["diff", "--name-only", `HEAD...${branch}`],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (diff.error || typeof diff.status !== "number" || diff.status !== 0) {
    const detail = (diff.stderr ?? diff.error?.message ?? "git diff failed").toString().trim();
    return { available: false, reason: "probe_failed", error: detail };
  }
  const files = new Set<string>();
  for (const line of (diff.stdout ?? "").split(/\r?\n/)) {
    const p = line.trim();
    if (p.length > 0) files.add(p.replace(/\\/g, "/"));
  }
  return { available: true, files };
}

/** A single edited hunk on the NEW side of a branch diff (repo-relative path). */
export interface GitBranchHunk {
  /** Repo-relative forward-slash path the hunk belongs to. */
  file: string;
  /** 1-based first line of the hunk on the new side. */
  startLine: number;
  /** Number of new-side lines the hunk spans (a pure deletion has 0). */
  lineCount: number;
}

/**
 * Outcome of resolving a branch's ACTUAL edited HUNKS from git. Fail-closed like
 * {@link gitEditedFilesForBranch}: on a non-repo, a failed probe, or a diff we
 * cannot parse, `available` is false and callers MUST treat hunk info as absent
 * (conservatively assume same-file blocks overlap — never silently drop a
 * collision).
 */
export type GitBranchHunks =
  | { available: true; hunks: GitBranchHunk[] }
  | { available: false; reason: "not_a_repo"; error: string }
  | { available: false; reason: "probe_failed"; error: string };

/**
 * Parse `git diff HEAD...<branch>` into per-hunk NEW-side line ranges — the
 * ground truth for whether two same-file edits actually touch disjoint regions.
 * Mirrors {@link gitEditedFilesForBranch}'s fail-closed / not-a-repo semantics:
 * never throws; on a non-repo / failed probe / malformed diff returns a
 * discriminated result marking hunks unavailable so the caller can fail closed.
 *
 * Paths are normalised to repo-relative forward-slash (the same scheme
 * {@link gitEditedFilesForBranch} emits) so hunk files compare like-for-like
 * with the file set.
 */
export function gitHunksForBranch(root: string, branch: string): GitBranchHunks {
  if (!isGitWorkTree(root)) {
    return { available: false, reason: "not_a_repo", error: "root is not a git work tree" };
  }
  const diff = spawnSyncHidden(
    "git",
    // No rename detection / context noise beyond what we parse; a plain unified
    // diff carries the `+++ b/<path>` and `@@ … +start,count @@` headers we need.
    ["diff", `HEAD...${branch}`],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (diff.error || typeof diff.status !== "number" || diff.status !== 0) {
    const detail = (diff.stderr ?? diff.error?.message ?? "git diff failed").toString().trim();
    return { available: false, reason: "probe_failed", error: detail };
  }
  return parseUnifiedDiffHunks(diff.stdout ?? "");
}

/**
 * Parse a unified-diff body into NEW-side hunk ranges. Extracted for testability
 * (no git spawn). Recognises `+++ b/<path>` file headers and
 * `@@ -a,b +c,d @@` hunk headers; a header we cannot parse fails the whole probe
 * closed (returns `probe_failed`) rather than silently producing partial hunks
 * that would let a real overlap slip through.
 */
export function parseUnifiedDiffHunks(diffText: string): GitBranchHunks {
  const hunks: GitBranchHunk[] = [];
  let currentFile: string | null = null;
  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith("+++ ")) {
      // `+++ b/path` — or `+++ /dev/null` for a pure deletion (no new side).
      const target = rawLine.slice(4).trim();
      if (target === "/dev/null") {
        currentFile = null;
        continue;
      }
      // Strip the conventional `b/` prefix; leave already-bare paths intact.
      const bare = target.startsWith("b/") ? target.slice(2) : target;
      currentFile = bare.replace(/\\/g, "/");
      continue;
    }
    if (rawLine.startsWith("@@")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
      if (!match) {
        return {
          available: false,
          reason: "probe_failed",
          error: `unparseable hunk header: ${rawLine}`,
        };
      }
      if (currentFile === null) continue; // deletion-only target: no new-side hunk.
      const startLine = Number(match[1]);
      const lineCount = match[2] === undefined ? 1 : Number(match[2]);
      hunks.push({ file: currentFile, startLine, lineCount });
    }
  }
  return { available: true, hunks };
}

/**
 * Files the worker edited (from git) that fall OUTSIDE the block's declared
 * write scope. Result-file artifacts and the agent-feedback file are excluded
 * (they are sanctioned side outputs, never source edits). Returns the offending
 * repo-relative paths (empty when the edits are fully within scope).
 */
export function writeScopeViolations(
  declaredWritePaths: string[],
  editedFiles: Set<string>,
  root: string,
): string[] {
  const declared = new Set(declaredWritePaths.map((p) => toRepoRelative(p, root)));
  const violations: string[] = [];
  for (const edited of editedFiles) {
    const rel = toRepoRelative(edited, root);
    if (declared.has(rel)) continue;
    // Sanctioned non-source outputs: result JSON files and the reflection file.
    if (rel.endsWith(".result.json")) continue;
    if (rel.endsWith(AGENT_FEEDBACK_FILENAME)) continue;
    violations.push(rel);
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Byte-based token estimation helpers
// ---------------------------------------------------------------------------

/** Fixed prompt overhead per dispatch slot (prompt instructions, JSON schema, etc.). */
export const PROMPT_OVERHEAD_TOKENS = 2000;

/** Sum the byte sizes of a list of absolute or repo-relative file paths. */
function sumFileSizes(filePaths: string[]): number {
  let total = 0;
  for (const p of filePaths) {
    try {
      total += statSync(p).size;
    } catch {
      // Missing file → 0 bytes; not an error for estimation purposes.
    }
  }
  return total;
}

/** Estimate slot tokens for an implement dispatch slot from readFiles byte sizes. */
export function estimateImplementSlotTokens(readFiles: string[], root: string): number {
  const absPaths = readFiles.map((f) =>
    f.startsWith("/") || /^[A-Za-z]:[/\\]/.test(f) ? f : join(root, f),
  );
  const bytes = sumFileSizes(absPaths);
  return estimateTokensFromBytes(bytes) + PROMPT_OVERHEAD_TOKENS;
}

// ---------------------------------------------------------------------------
// detectRepoConventions cache (one call per repo root per process)
// ---------------------------------------------------------------------------

/** Module-level cache: repo root → formatted conventions string. */
export const detectRepoConventionsCache = new Map<string, string>();

export function getCachedConventions(root: string): string {
  if (detectRepoConventionsCache.has(root)) {
    return detectRepoConventionsCache.get(root)!;
  }
  const result = formatRepoConventions(detectRepoConventions(root));
  detectRepoConventionsCache.set(root, result);
  return result;
}
