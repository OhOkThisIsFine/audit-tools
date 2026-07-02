import { dirname, join, resolve } from "node:path";

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

/**
 * Canonical deliverable filenames shared by both halves of the pipeline. The
 * audit half renders `audit-report.md` (human) from `audit-findings.json`
 * (machine contract); the remediation half writes `remediation-report.md` /
 * `remediation-outcomes.json`. These live here, in exactly one place, so the
 * synthesis writer, the promote source/dest, the present_report prompt path,
 * and the remediation close writer cannot drift to different spellings — a
 * drift that previously surfaced as a promote-time ENOENT.
 */
export const AUDIT_REPORT_FILENAME = "audit-report.md";
export const AUDIT_FINDINGS_FILENAME = "audit-findings.json";
export const REMEDIATION_REPORT_FILENAME = "remediation-report.md";
export const REMEDIATION_OUTCOMES_FILENAME = "remediation-outcomes.json";

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
 * `<artifactsDir>/artifact-tree.lock` — the single pessimistic lock guarding
 * every artifact-tree read-modify-write (advance/persist/ingest, O2). All
 * mutators acquire THIS lock via `withFileLock` so a concurrent next-step /
 * merge-and-ingest can never interleave a load against another writer's
 * partially-written bundle (the staleness-cascade wipe trap). Single-sourced so
 * every mutator agrees on the exact path.
 */
export function artifactTreeLockPath(artifactsDir: string): string {
  return join(artifactsDir, "artifact-tree.lock");
}

/**
 * `<artifactsDir>/node-claims.json` — the shared cross-process `ClaimRegistry`
 * file for cooperative multi-agent runs (see
 * `spec/multi-ide-concurrent-runs-design.md`). Peers claim the current
 * bundle-mutating obligation (`obligation:<id>`) and — from slice 2 — individual
 * `audit_tasks` (`<task_id>`) here so no two agents run the same unit. Distinct
 * from `artifact-tree.lock` (a short atomicity lock); a claim is a heartbeated
 * work-lease that survives a long executor.
 */
export function nodeClaimsPath(artifactsDir: string): string {
  return join(artifactsDir, "node-claims.json");
}

/**
 * `<artifactsDir>/task-claims.json` — a SEPARATE `ClaimRegistry` file for
 * per-`task_id` audit-task claims (slice 2). Kept distinct from
 * `node-claims.json` (the short-lived, heartbeated `bundle-mutation` mutex)
 * because task claims use a much LONGER lease: they are held across an
 * out-of-process host worker run with no live heartbeat, so their reclaim window
 * must bound a worker's whole runtime. Separate files keep the two lease windows
 * from cross-contaminating (a registry's stale-window is per-instance).
 */
export function taskClaimsPath(artifactsDir: string): string {
  return join(artifactsDir, "task-claims.json");
}

/**
 * `<artifactsDir>/incoming` — the drop directory for upstream worker results
 * and externally supplied evidence. Takes an already-resolved artifacts dir.
 */
export function incomingDir(artifactsDir: string): string {
  return join(artifactsDir, "incoming");
}

/**
 * `<artifactsDir>/audit-report.md` — where synthesis renders the human report
 * and the promote step reads it FROM. Source and write target derive from this
 * one helper so they are byte-identical.
 */
export function auditReportPath(artifactsDir: string): string {
  return join(artifactsDir, AUDIT_REPORT_FILENAME);
}

/** `<artifactsDir>/audit-findings.json` — the canonical machine contract. */
export function auditFindingsPath(artifactsDir: string): string {
  return join(artifactsDir, AUDIT_FINDINGS_FILENAME);
}

/**
 * `<dirname(artifactsDir)>/audit-report.md` — the promote destination, one
 * level up from the working artifacts dir (i.e. `.audit-tools/audit-report.md`
 * for the canonical `.audit-tools/audit/` artifacts dir). This is also where
 * the present_report prompt points and where remediate-code probes first.
 */
export function promotedAuditReportPath(artifactsDir: string): string {
  return join(outputDirFor(artifactsDir), AUDIT_REPORT_FILENAME);
}

/** `<dirname(artifactsDir)>/audit-findings.json` — promoted machine contract. */
export function promotedAuditFindingsPath(artifactsDir: string): string {
  return join(outputDirFor(artifactsDir), AUDIT_FINDINGS_FILENAME);
}

/**
 * The directory deliverables are promoted INTO: the parent of the working
 * artifacts dir. Single-sourced so every promote/present consumer agrees.
 */
export function outputDirFor(artifactsDir: string): string {
  return dirname(artifactsDir);
}
