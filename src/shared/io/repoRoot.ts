import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { AUDIT_TOOLS_DIRNAME } from "./auditToolsPaths.js";
import { AUDIT_TOOLS_CALLER_CWD_ENV } from "./nodeWorktreeGuard.js";

/**
 * Resolve the repository root that owns the `.audit-tools/` artifact tree,
 * anchoring away from a drifted process cwd. Both orchestrators recompute the
 * root on every `next-step` from `--root` (default `"."`) resolved against cwd,
 * so a run whose cwd has wandered into `.audit-tools/` would otherwise recompute
 * repo_root AS that dir and mint a phantom nested `.audit-tools/.audit-tools/`
 * tree forked off the real run (observed 2026-07-04).
 *
 * The fix is deliberately narrow: climb out of any `.audit-tools/` the resolved
 * root sits inside — the exact drift pathology — and nothing more. It is NOT a
 * git-toplevel / nearest-marker re-anchor: those over-reach, re-homing a root
 * that is legitimately a sub-project inside a larger git repo (or any dir nested
 * under an ancestor that happens to own a `.audit-tools`) up to the outer repo.
 * Climbing out of `.audit-tools` fully resolves the reported bug, and the
 * `auditToolsDir` guard makes the nested tree impossible for any code path that
 * bypasses this resolver — so the correctness property is tool-enforced, not
 * dependent on every caller remembering to anchor first. An explicit
 * `--artifacts-dir` still overrides everything (honored verbatim by the CLIs).
 */
export function resolveRepoRoot(rawRoot: string): string {
  return climbOutOfAuditTools(resolve(rawRoot));
}

/**
 * If `p` lies inside a `.audit-tools/` tree, return the path truncated to the
 * parent of the OUTERMOST `.audit-tools` segment; otherwise return `p` resolved
 * unchanged. Works on win32 (drive-letter) and posix paths; degenerate inputs
 * (a `.audit-tools` at the filesystem/drive root) fall through unchanged.
 */
export function climbOutOfAuditTools(p: string): string {
  const resolved = resolve(p);
  const segments = resolved.split(sep);
  const idx = segments.indexOf(AUDIT_TOOLS_DIRNAME);
  if (idx <= 0) return resolved;
  return segments.slice(0, idx).join(sep) || resolved;
}

/**
 * The directory entries that mark a directory as the root of the tree a run
 * belongs to, checked NEAREST-FIRST (see `discoverRepoRoot`). Both are entries,
 * not necessarily directories: a git worktree / submodule checkout carries
 * `.git` as a FILE, and `warnIfNotGitRepo` already treats that as a repository.
 *
 * `.audit-tools` is listed alongside `.git` (not after it) deliberately: at a
 * given ancestor either marker is decisive, so an existing run's tree is never
 * re-homed past itself to an outer git repo.
 */
export const REPO_ROOT_MARKERS: readonly string[] = [AUDIT_TOOLS_DIRNAME, ".git"];

/**
 * The caller's true working directory. A cwd-changing wrapper spawns the CLI
 * with `cwd` pinned to the PACKAGE root, so `process.cwd()` alone carries no
 * evidence of where the operator actually ran the command; the wrapper stamps
 * `AUDIT_TOOLS_CALLER_CWD` from its own cwd for exactly this reason (see
 * `nodeWorktreeGuard.ts`, which keys its refusal on the same value). Reading it
 * here means default root DISCOVERY and the worktree REFUSAL answer the same
 * question about the same directory.
 */
export function callerWorkingDirectory(): string {
  const stamped = process.env[AUDIT_TOOLS_CALLER_CWD_ENV];
  return stamped && stamped.length > 0 ? stamped : process.cwd();
}

/**
 * The directory the marker climb stops BELOW: the operator's home directory is
 * never a repository root, and a repository is never found by leaving it.
 *
 * This is load-bearing, not defensive tidiness. `~/.audit-tools/` is the tool's
 * own machine-wide cache home (the analyzer cache lives there on every
 * machine), so it is a `REPO_ROOT_MARKERS` hit on EVERY box — an unbounded
 * climb from any directory that is not inside a repository would resolve the
 * home directory as the target repo and audit the operator's whole home tree.
 * Reaching the ceiling means "no repository above here", which falls back to
 * the start dir exactly as an unmarked filesystem root does.
 */
function repoRootCeiling(): string | null {
  try {
    const home = homedir();
    return home ? resolve(home) : null;
  } catch {
    return null;
  }
}

/**
 * Canonical repository root for a run that was NOT given an explicit root:
 * climb out of any `.audit-tools/` the start dir sits inside, then walk up to
 * the nearest ancestor carrying a `REPO_ROOT_MARKERS` entry, stopping below the
 * home directory (`repoRootCeiling`). Every command invoked from anywhere
 * inside one repository therefore resolves the SAME root — the property the
 * host would otherwise have to guarantee by remembering to pass `--root` on
 * every call (auditor-agnostic robustness).
 *
 * This is deliberately NOT what `resolveRepoRoot` does, and the two are not
 * interchangeable. `resolveRepoRoot` anchors an EXPLICITLY SUPPLIED root and
 * must not re-home it: a `--root <X>` naming a sub-project that lives inside a
 * larger git repo means that sub-project, and marker-climbing it up to the
 * outer repo is the over-reach that resolver's doc comment rejects (pinned by
 * `tests/shared/repo-root.test.ts`). Discovery runs only where there is no
 * supplied root to respect, so `--root` remains the exact escape hatch for the
 * sub-project case and for running from outside the target repo entirely.
 *
 * No marker below the ceiling / above the start dir → the start dir is returned
 * unchanged, so a run launched outside any repository behaves exactly as it did
 * before (the `warnIfNotGitRepo` notice on the cwd), never silently re-homed to
 * the home directory or the filesystem root.
 */
export function discoverRepoRoot(
  startDir: string = callerWorkingDirectory(),
): string {
  const start = climbOutOfAuditTools(resolve(startDir));
  const ceiling = repoRootCeiling();
  let current = start;
  for (;;) {
    // Checked BEFORE the markers: the ceiling directory itself is never a
    // discovered root. When the start dir IS the ceiling this returns it
    // anyway (start === current), preserving "the cwd is the root" there.
    if (ceiling !== null && current === ceiling) return start;
    if (REPO_ROOT_MARKERS.some((marker) => existsSync(join(current, marker)))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}
