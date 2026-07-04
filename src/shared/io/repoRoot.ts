import { resolve, sep } from "node:path";
import { AUDIT_TOOLS_DIRNAME } from "./auditToolsPaths.js";

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
