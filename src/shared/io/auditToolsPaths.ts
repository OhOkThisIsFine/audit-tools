import { dirname, join, resolve, sep } from "node:path";

/**
 * Single source of truth for the on-disk `.audit-tools/` layout shared by both
 * orchestrators. Every path is derived from a passed repository root (or, for
 * the per-artifacts-dir helpers, from an already-resolved artifacts dir) so the
 * literal directory names (`.audit-tools`, `audit`, `remediation`, `steps`,
 * `submissions`) live in exactly one place. CLI arg resolvers route through this
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
/**
 * The single literal directory name for the runtime artifact tree. Single-sourced
 * here so the path builders, the repo-root resolver (`resolveRepoRoot`), and the
 * nested-tree guard all agree on the one spelling.
 */
export const AUDIT_TOOLS_DIRNAME = ".audit-tools";

/**
 * The single literal directory name for tool-created git worktrees under
 * `.audit-tools/` (remediate's per-node implement worktrees; audit's disposable
 * review snapshots). Single-sourced so the path builder and the node-worktree
 * context guard (`nodeWorktreeGuard.ts`) agree on the one spelling.
 */
export const WORKTREES_DIRNAME = "worktrees";

export const AUDIT_REPORT_FILENAME = "audit-report.md";
export const AUDIT_FINDINGS_FILENAME = "audit-findings.json";
export const REMEDIATION_REPORT_FILENAME = "remediation-report.md";
export const REMEDIATION_OUTCOMES_FILENAME = "remediation-outcomes.json";
const VERIFICATION_REPORT_FILENAME = "verification_report.json";

/**
 * `<root>/.audit-tools` (absolute). Refuses to build the tree under a `root`
 * that is itself already inside a `.audit-tools/` directory — that only happens
 * when the caller trusted a drifted cwd, and silently proceeding mints a phantom
 * nested `.audit-tools/.audit-tools/` run forked away from the real one. Callers
 * must anchor the repo root via `resolveRepoRoot()` first; this guard makes the
 * failure mode loud and impossible rather than silent (auditor-agnostic
 * robustness — the phantom tree can't be created by any code path).
 */
export function auditToolsDir(root: string): string {
  const resolved = resolve(root);
  if (resolved.split(sep).includes(AUDIT_TOOLS_DIRNAME)) {
    throw new Error(
      `refusing to build ${AUDIT_TOOLS_DIRNAME} under a path already inside ` +
        `${AUDIT_TOOLS_DIRNAME} (root=${resolved}). Resolve the repository root ` +
        `via resolveRepoRoot() before constructing artifact paths.`,
    );
  }
  return join(resolved, AUDIT_TOOLS_DIRNAME);
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
 * `<root>/.audit-tools/worktrees` — the gitignored home for tool-created git
 * worktrees (remediate's per-node implement worktrees; audit's disposable
 * review snapshots). Single-sourced so every worktree producer/sweeper agrees
 * on the one location.
 */
export function auditToolsWorktreesDir(root: string): string {
  return join(auditToolsDir(root), WORKTREES_DIRNAME);
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
 * mutators acquire THIS lock via `withFileLock` so concurrent next-step and
 * result-ingestion calls can never interleave a load against another writer's
 * partially-written bundle (the staleness-cascade wipe trap). Single-sourced so
 * every mutator agrees on the exact path.
 */
export function artifactTreeLockPath(artifactsDir: string): string {
  return join(artifactsDir, "artifact-tree.lock");
}

/**
 * `<artifactsDir>/submissions` — where host submissions land, one file per
 * tool-minted submission id (`<sha256(submission_id)>.json`). Takes an
 * already-resolved artifacts dir.
 *
 * The name is the ONLY thing a host may not choose: the tool mints the id, the
 * tool derives the path, and the step contract declares it. A submission
 * written anywhere else is read by nothing.
 */
export function submissionsDir(artifactsDir: string): string {
  return join(artifactsDir, "submissions");
}

/**
 * `<artifactsDir>/submissions/expected-submissions.json` — the current
 * statement of which lanes still owe a submission. Deliberately UNREGISTERED
 * (outside `ARTIFACT_DEFINITIONS` and the staleness DAG): it is regenerable
 * bookkeeping rewritten at every emit, and hashing it into the DAG would churn
 * `artifact_metadata` and cascade phantom staleness downstream.
 */
export function expectedSubmissionsPath(artifactsDir: string): string {
  return join(submissionsDir(artifactsDir), "expected-submissions.json");
}

/**
 * `<artifactsDir>/lanes` — tool-WRITTEN lane inputs (lane prompt files,
 * per-kind evidence packets). Kept apart from `submissions/` because the two
 * populations have opposite ownership: the tool authors everything here and a
 * host only reads it, while `submissions/` holds what a host writes back.
 */
export function laneAssetsDir(artifactsDir: string): string {
  return join(artifactsDir, "lanes");
}

/**
 * `<artifactsDir>/scratch/<runId>` — the run-scoped directory host agents are
 * directed to use for any working files they improvise while driving a
 * dispatch (batch lists, helper scripts, notes). Lives under `.audit-tools/`
 * so it is gitignored and outside the audit intake scope by construction —
 * scratch dropped at the audited repo's root instead becomes untracked litter
 * the next audit's manifest walk picks up.
 */
export function hostScratchDir(artifactsDir: string, runId: string): string {
  return join(artifactsDir, "scratch", runId);
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

/**
 * `<root>/.audit-tools/verification_report.json` — the closing-phase
 * verification report (FINDING-027), written at the root artifacts dir
 * alongside the promoted findings/report/outcomes files rather than under
 * either orchestrator's working artifacts dir.
 */
export function verificationReportPath(root: string): string {
  return join(auditToolsDir(root), VERIFICATION_REPORT_FILENAME);
}
