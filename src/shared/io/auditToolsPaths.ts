import { join, resolve } from "node:path";

/**
 * Single source of truth for the on-disk `.audit-tools/` layout shared by both
 * orchestrators. Every path is derived from a passed repository root (or, for
 * the per-artifacts-dir helpers, from an already-resolved artifacts dir) so the
 * literal directory names (`.audit-tools`, `audit`, `remediation`, `steps`,
 * `incoming`) live in exactly one place. CLI arg resolvers route through this
 * module instead of re-spelling the join literals — that is what keeps the two
 * tools from drifting and what the CLI-args guard test enforces.
 *
 * Rebasing rule: the default artifacts dir is ALWAYS rebased onto the supplied
 * root. A `--root <X>` with no explicit `--artifacts-dir` must resolve under
 * `<X>/.audit-tools/...`, never under the process CWD. Callers that accept an
 * explicit artifacts-dir override should honor the override verbatim and fall
 * back to these helpers only for the default.
 */

/** `<root>/.audit-tools` (absolute). */
export function auditToolsDir(root: string): string {
  return resolve(root, ".audit-tools");
}

/** `<root>/.audit-tools/audit` — audit-code's default artifacts dir (absolute). */
export function auditArtifactsDir(root: string): string {
  return join(auditToolsDir(root), "audit");
}

/**
 * `<root>/.audit-tools/remediation` — remediate-code's default artifacts dir
 * (absolute).
 */
export function remediationArtifactsDir(root: string): string {
  return join(auditToolsDir(root), "remediation");
}

/**
 * `<artifactsDir>/steps` — where each orchestrator writes `current-step.json`
 * and `current-prompt.md`. Takes an already-resolved artifacts dir (audit or
 * remediation), not a root, because both halves share this child name.
 */
export function stepsDir(artifactsDir: string): string {
  return join(artifactsDir, "steps");
}

/**
 * `<artifactsDir>/incoming` — the drop directory for upstream worker results
 * and externally supplied evidence. Takes an already-resolved artifacts dir.
 */
export function incomingDir(artifactsDir: string): string {
  return join(artifactsDir, "incoming");
}
