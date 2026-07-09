import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, dirname, isAbsolute } from "node:path";
import { spawnSyncHidden } from "audit-tools/shared";
import { AUDIT_TOOLS_DIRNAME } from "../../../shared/io/auditToolsPaths.js";
import {
  toRepoRelative,
  refSafeSegment,
  gitTopLevel,
  canonicalPathKey,
  gitBranchExists,
  gitEditedFilesForBranch,
} from "./common.js";

// ---------------------------------------------------------------------------
// Worktree dispatch engine
// ---------------------------------------------------------------------------

export interface WorktreeVerifyResult {
  passed: boolean;
  output: string;
}

/**
 * Create an isolated git worktree on a fresh branch at HEAD. Throws on non-zero exit.
 *
 * Refuses when `root` is not ITSELF a git top-level: a bare `git worktree add`
 * with `cwd: root` walks UP to the nearest enclosing repo and silently creates
 * the worktree/branch in that ancestor (observed polluting the monorepo with
 * leaked `remediate-*` branches during the rolling_engine flip). The resolved
 * top-level must equal the target root, or we refuse rather than escape.
 */
export function createWorktree(root: string, worktreePath: string, branchName: string): void {
  const top = gitTopLevel(root);
  if (top === null) {
    throw new Error(
      `Refusing to create a worktree: ${root} is not inside a git repository ` +
        `(git rev-parse --show-toplevel failed). Rolling dispatch requires the target root to be a git repo.`,
    );
  }
  if (canonicalPathKey(top) !== canonicalPathKey(root)) {
    throw new Error(
      `Refusing to create a worktree: the git top-level for ${root} is ${top}, not the target root ` +
        `itself, so 'git worktree add' would escape to an ancestor repo. Initialize a git repo at the ` +
        `target root before rolling dispatch.`,
    );
  }
  const result = spawnSyncHidden(
    "git",
    ["worktree", "add", "-b", branchName, worktreePath, "HEAD"],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    throw new Error(
      `git worktree add failed (exit ${result.status ?? "unknown"}):\n${stderr || stdout}`,
    );
  }
  // Link the main checkout's (gitignored → absent-in-worktree) node_modules so
  // per-node verify can resolve deps. Folded into creation, not left to each
  // caller to remember — a fresh worktree without it silently fails verify with
  // missing-module errors. Best-effort + idempotent (see ensureWorktreeNodeModules).
  ensureWorktreeNodeModules(root, worktreePath);
}

/**
 * Materialize into a fresh worktree any of the node's declared target paths that
 * exist in the main tree but are absent from the worktree — i.e. git-untracked or
 * gitignored files that `git worktree add HEAD` does not bring over. Without this
 * a node whose scope names an untracked config file (the dogfood hit
 * `opencode.json` and an uncommitted `.gemini/commands/*.toml`) cannot see its own
 * target, so the edit silently no-ops. The "absent in worktree" test is the
 * discriminator: a tracked path is already materialized from HEAD, so only the
 * genuinely-missing untracked/ignored declarations are copied — a tracked-but-dirty
 * file keeps its clean-from-HEAD worktree content and is never clobbered. Paths are
 * repo-relative (the declared scope contract); absolute/escaping paths are skipped.
 * Best-effort: a copy failure must not abort the dispatch (logged, not thrown).
 */
export function seedUntrackedDeclaredPaths(
  root: string,
  worktreeRoot: string,
  declaredPaths: Iterable<string>,
): void {
  for (const rel of new Set(declaredPaths)) {
    if (!rel || isAbsolute(rel)) continue;
    // Reject paths that escape the root (defence-in-depth; declared scope is
    // repo-relative and never `..`-prefixed in practice).
    const dst = join(worktreeRoot, rel);
    const src = join(root, rel);
    if (relative(worktreeRoot, dst).startsWith("..")) continue;
    if (!existsSync(src) || existsSync(dst)) continue;
    try {
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
    } catch (err) {
      process.stderr.write(
        `[remediate-code] worktree seed: could not copy untracked declared path ${rel}: ${
          (err as Error).message
        }\n`,
      );
    }
  }
}

/**
 * Remove ONE git worktree, PATH-SCOPED (INV-WTS-1/4). Always addresses only the
 * named `worktreePath` via `git worktree remove --force <path>` — never a global
 * `git worktree prune` that could drop a SIBLING node's registered-but-transiently-
 * absent worktree. `git worktree remove --force` clears the registration even when
 * the directory is already MISSING (a stale admin entry), so this alone replaces
 * the prior global-prune reset step. Best-effort: a genuinely-absent + unregistered
 * path (git reports "is not a working tree" and the dir does not exist) is a silent
 * no-op; any other failure is surfaced on stderr, never thrown.
 */
export function removeWorktree(root: string, worktreePath: string): void {
  const result = spawnSyncHidden(
    "git",
    ["worktree", "remove", "--force", worktreePath],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (result.status === 0) return;
  const stderr = (result.stderr ?? "").trim();
  // "not a working tree" = the path was never a registered worktree. When the
  // directory is ALSO absent there is genuinely nothing to remove → silent no-op.
  // When the directory still exists (an orphaned plain dir) it is a real failure
  // worth surfacing (the caller's rmSync then clears the leftover dir).
  if (/not a working tree/i.test(stderr) && !existsSync(worktreePath)) return;
  process.stderr.write(
    `[remediate-code] worktree remove failed (exit ${result.status ?? "unknown"}): ${stderr}\n`,
  );
}

/**
 * Fully reset a node's isolated worktree + branch so a fresh `createWorktree -b`
 * can run, even when a prior attempt left either behind. This is the idempotent
 * cleanup the in-process driver needs across a `rate_limited` re-queue: the
 * engine re-enters the dispatcher for the SAME block while its branch (and maybe
 * a stale worktree admin entry) still exist, and `git worktree add -b <branch>`
 * would otherwise fail with "branch already exists". Removing the worktree,
 * pruning stale admin records, then force-deleting the branch makes every
 * (re-)dispatch start clean from HEAD. All steps are best-effort (a missing
 * worktree/branch is the expected first-attempt case, not an error). Any partial
 * edits from a throttled prior attempt are intentionally discarded — the
 * re-dispatch redoes the node from HEAD.
 *
 * INV-WTS-1/4 (no sibling clobber, stale-sweep never prunes in-flight work): every
 * step is scoped to THIS node's own `worktreePath` / `branchName`. There is NO
 * global `git worktree prune` — a global prune drops the admin entry of ANY sibling
 * worktree whose directory is transiently absent (a sibling between its own rmSync
 * and re-create), which is the exact data-loss race this module closes. Path-scoped
 * `removeWorktree` clears even a stale registration whose dir is already gone, so
 * the prune is unnecessary. Callers serialize a node's reset/create against its own
 * accept via `worktreeNodeLockPath` (INV-WTS-8), so two operations on the SAME node
 * never interleave, while DIFFERENT nodes never touch each other's path.
 */
export function resetNodeWorktreeAndBranch(
  root: string,
  worktreePath: string,
  branchName: string,
): void {
  // Path-scoped removal: clears the registration (even a stale one whose dir is
  // missing) for THIS node only — never a global prune that could drop a sibling.
  removeWorktree(root, worktreePath);
  // Force-delete the leftover branch from a prior attempt so `-b` recreates it.
  spawnSyncHidden("git", ["branch", "-D", branchName], { cwd: root, shell: false });
  // Force-remove a leftover worktree DIRECTORY: when a prior attempt's worktree
  // became an orphaned dir (registered admin entry gone but files remain),
  // `git worktree remove` reports "is not a working tree" and `git worktree add`
  // then refuses because the path already exists. Deleting the dir makes the
  // re-create succeed. Best-effort, and scoped to this node's own path.
  if (existsSync(worktreePath)) {
    rmSync(worktreePath, { recursive: true, force: true });
  }
}

/**
 * Run each targeted command in the worktree directory. Returns pass/fail and
 * combined output.
 *
 * `targeted_commands` are opaque host-authored command *strings* (e.g.
 * `npm run build`, `grep -c '/packages/' .gitignore`, anything with pipes,
 * quotes, or redirections), NOT pre-tokenized argv. They are run through the
 * platform shell (`spawnSync(..., { shell: true })`, the
 * same path `close.ts` uses for `test_command`/`e2e_command`) so the shell — not
 * a word-split + `spawnSync(shell:false)` — resolves the verb. That is what
 * makes this OS-agnostic: on win32 `cmd.exe` natively execs `.cmd` shims (npm,
 * npx, …) and resolves PATH commands; on darwin/linux `/bin/sh` does. The prior
 * argv path ENOENT'd the *spawn itself* for any verb that wasn't a bare
 * executable (e.g. `grep` on Windows), turning a correct fix into a phantom
 * contract failure that burned the retry budget.
 */
/**
 * INV-WTS-2 escape check: returns a LOUD diagnostic string when `worktreeRoot` is
 * NOT safe to run a build-free verify in — either the cwd was removed (a concurrent
 * sweep deleted the worktree → a bare command would ENOENT or resolve up to MAIN),
 * or git resolves an ENCLOSING top-level distinct from the cwd (the worktree escaped
 * to the main checkout). Returns null when the cwd IS its own git top-level (the
 * healthy isolated-worktree case). A cwd that exists but is not inside any git work
 * tree (`status != 0`, no spawn error) is NOT an escape — only a resolved enclosing
 * top-level is — so that case returns null too (never a false refusal).
 */
function verifyCwdEscapeDiagnostic(worktreeRoot: string): string | null {
  const probe = spawnSyncHidden(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: worktreeRoot, encoding: "utf8", shell: false },
  );
  if (probe.error) {
    return (
      `[remediate-code] verify REFUSED: the verify cwd ${worktreeRoot} no longer exists ` +
      `(${(probe.error as NodeJS.ErrnoException).code ?? "spawn error"}). The worktree was ` +
      `removed out from under the verify (a concurrent sweep/accept); refusing to run a ` +
      `build-free verify that would false-green against unrelated code.`
    );
  }
  if (probe.status === 0) {
    const top = (probe.stdout ?? "").trim();
    if (top.length > 0 && canonicalPathKey(top) !== canonicalPathKey(worktreeRoot)) {
      return (
        `[remediate-code] verify REFUSED: git top-level for ${worktreeRoot} is ${top}, not ` +
        `the cwd itself — the verify cwd is INSIDE an enclosing checkout (a per-node worktree ` +
        `deleted out from under it resolves up to MAIN). Refusing to run a build-free verify ` +
        `that would false-green against unrelated code.`
      );
    }
  }
  return null;
}

export function verifyNodeInWorktree(
  worktreePath: string,
  targetedCommands: string[],
  /**
   * INV-WTS-2: enforce that the verify cwd IS its own git top-level (a per-node
   * ISOLATED worktree). Set by the accept-node path (`acceptNodeWorktree`) — the
   * enforcement point — so a worktree deleted out from under the verify fails LOUD
   * instead of resolving up to the enclosing MAIN checkout and false-greening
   * against unrelated code. Left OFF (default) for the deliberately-main-rooted
   * re-verify callers (triage re-runs a node's `targeted_commands` at the repo root,
   * which is legitimately a subdir of no isolated worktree).
   */
  enforceWorktreeRoot = false,
): WorktreeVerifyResult {
  if (enforceWorktreeRoot) {
    const escape = verifyCwdEscapeDiagnostic(worktreePath);
    if (escape !== null) return { passed: false, output: escape };
  }
  const outputs: string[] = [];
  for (const cmd of targetedCommands) {
    // Windows-aware: force-hide the console window a windowless parent
    // (node under an IDE/agent) would otherwise pop for this shell child —
    // same default `runShellCommand` (utils/commands.ts, now retired) applied.
    const r = spawnSync(cmd, {
      cwd: worktreePath,
      encoding: "utf8",
      shell: true,
      windowsHide: true,
    });
    if (r.error) {
      // Shell itself failed to spawn — surface it as a verify failure with the
      // error text rather than a silent status.
      outputs.push(`$ ${cmd}\n${r.error.message}`);
      return { passed: false, output: outputs.join("\n---\n") };
    }
    const combined = [r.stdout ?? "", r.stderr ?? ""].filter(Boolean).join("\n");
    outputs.push(`$ ${cmd}\n${combined}`);
    if (r.status !== 0) {
      return { passed: false, output: outputs.join("\n---\n") };
    }
  }
  return { passed: true, output: outputs.join("\n---\n") };
}

/** Merge the worktree branch into the current HEAD via cherry-pick. On failure, removes the worktree and returns the error. */
export function mergeWorktree(
  root: string,
  worktreePath: string,
  branchName: string,
): { success: true } | { success: false; error: string } {
  // Get the tip commit of the worktree branch
  const revResult = spawnSyncHidden("git", ["rev-parse", branchName], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (revResult.status !== 0) {
    const errMsg = (revResult.stderr ?? "").trim();
    removeWorktree(root, worktreePath);
    return { success: false, error: `Failed to resolve worktree branch ${branchName}: ${errMsg}` };
  }

  const worktreeTip = revResult.stdout.trim();
  const mergeResult = spawnSyncHidden("git", ["cherry-pick", worktreeTip], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (mergeResult.status !== 0) {
    const stderr = (mergeResult.stderr ?? "").trim();
    // Abort the cherry-pick so the main tree stays clean
    spawnSyncHidden("git", ["cherry-pick", "--abort"], { cwd: root, shell: false });
    removeWorktree(root, worktreePath);
    return { success: false, error: `cherry-pick failed: ${stderr}` };
  }

  removeWorktree(root, worktreePath);
  return { success: true };
}

/**
 * Repo-relative tracked paths in the MAIN checkout that have uncommitted changes
 * AND collide with a path the node's branch edits. A pre-existing dirty tracked
 * file the cherry-pick would touch makes `git cherry-pick` abort with the opaque
 * "Your local changes to the following files would be overwritten by merge" — a
 * condition the node itself cannot fix and that identically re-fails every
 * auto-retry (observed: a docs-only node routed to human triage over unrelated
 * uncommitted WIP on the same file). Detected here so `acceptNodeWorktree` can
 * surface the actionable cause (which file, commit-or-stash) instead of the raw
 * git error. Best-effort: an unavailable diff / status probe returns `[]` (fall
 * through to the normal cherry-pick, which reproduces the original behaviour).
 */
export function dirtyMainTreeCollisions(root: string, branch: string): string[] {
  const edited = gitEditedFilesForBranch(root, branch);
  if (!edited.available || edited.files.size === 0) return [];
  const status = spawnSyncHidden(
    "git",
    ["status", "--porcelain", "--", ...edited.files],
    { cwd: root, encoding: "utf8", shell: false },
  );
  if (status.error || status.status !== 0) return [];
  const dirty: string[] = [];
  for (const line of (status.stdout ?? "").split(/\r?\n/)) {
    // Porcelain v1: two status chars + a space, then the path. Rename entries
    // ("R  old -> new") keep the destination after the arrow.
    const raw = line.slice(3).trim();
    if (raw.length === 0) continue;
    const arrow = raw.lastIndexOf(" -> ");
    const p = (arrow >= 0 ? raw.slice(arrow + 4) : raw).replace(/\\/g, "/");
    if (p.length > 0) dirty.push(p);
  }
  return dirty;
}

/**
 * Rebase a node's worktree branch onto the main checkout's current HEAD (the
 * remediation branch tip) so a sibling that merged AFTER this worktree was created
 * is folded in before this node verifies and merges. Additive edits to a shared
 * file merge automatically (git's per-commit 3-way); a true hunk conflict is a
 * genuine seam that aborts cleanly so the node routes to triage instead of landing
 * a broken merge. The branch is checked out in the worktree, so the rebase runs
 * there. A no-op (branch already on HEAD — the common, no-sibling-merged case)
 * succeeds. Leaves the branch on its pre-rebase commit on abort (so the failed
 * node's work can still be quarantined).
 */
export function rebaseBranchOntoHead(
  root: string,
  worktreePath: string,
  branch: string,
): { ok: true } | { ok: false; error: string } {
  const head = spawnSyncHidden("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", shell: false });
  if (head.error || head.status !== 0) {
    const detail = (head.stderr ?? head.error?.message ?? "git rev-parse failed").toString().trim();
    return { ok: false, error: `could not resolve remediation HEAD for rebase: ${detail}` };
  }
  const target = head.stdout.trim();
  const rebase = spawnSyncHidden("git", ["rebase", target], {
    cwd: worktreePath,
    encoding: "utf8",
    shell: false,
  });
  if (rebase.error || rebase.status !== 0) {
    const detail = [rebase.stdout ?? "", rebase.stderr ?? "", rebase.error?.message ?? ""]
      .filter(Boolean)
      .join("\n")
      .trim();
    // Leave a clean tree: abort the in-progress rebase before the worktree is dropped.
    spawnSyncHidden("git", ["rebase", "--abort"], { cwd: worktreePath, shell: false });
    return {
      ok: false,
      error:
        `rebase onto the current remediation HEAD conflicted (a real seam — two ` +
        `nodes edited the same lines): ${detail}`,
    };
  }
  return { ok: true };
}

/** Worktree path for a remediation block. */
export function worktreePath(root: string, blockId: string, runId: string): string {
  return join(root, AUDIT_TOOLS_DIRNAME, "worktrees", `remediate-${blockId}-${runId}`);
}

export function remediationBranchName(runId: string): string {
  return `remediation/${refSafeSegment(runId, "run")}`;
}

/**
 * Lock path for the base-mutating accept critical section (INV-2/CE-001), keyed on
 * the base repo root + run's remediation branch. DISTINCT from the per-run
 * `rolling-session.lock` (`withFileLock` is non-reentrant — an exclusive `wx`
 * create — so the base lock MUST be a different path than the session lock
 * `advanceHostRolling` already holds, or the nested acquire would self-deadlock).
 * Both rolling drivers (host-subagent + in-process) serialize the rebase →
 * cherry-pick → cross-package check → reset sequence through this single lock.
 */
export function baseBranchLockPath(root: string, runId: string): string {
  return join(root, AUDIT_TOOLS_DIRNAME, "remediation", "runs", refSafeSegment(runId, "run"), "base-branch.lock");
}

/**
 * Per-node worktree lock path (INV-WTS-1/8). Serializes create / reset / remove /
 * accept for ONE node so a concurrent operation on the SAME node never interleaves
 * (and a scoped removal can't race its own re-create). DISTINCT from
 * {@link baseBranchLockPath} (base-branch.lock) and the per-run `rolling-session.lock`
 * — `withFileLock` is a non-reentrant `wx` create, so sharing a path self-deadlocks
 * (INV-WTS-6). Keyed on the block id so two DIFFERENT nodes hold DIFFERENT locks and
 * never contend. INV-WTS-8: whenever both are held, this per-node lock is acquired
 * BEFORE the base-branch lock on every accept path, so the fixed total order makes an
 * AB/BA cross-lock deadlock unreachable by construction.
 */
export function worktreeNodeLockPath(root: string, runId: string, blockId: string): string {
  return join(
    root,
    AUDIT_TOOLS_DIRNAME,
    "remediation",
    "runs",
    refSafeSegment(runId, "run"),
    `worktree-${refSafeSegment(blockId, "node")}.lock`,
  );
}

/** Durable ref under which a failed-but-committed node's commit is preserved. */
export function quarantineRef(runId: string, blockId: string): string {
  return `refs/remediation-quarantine/${refSafeSegment(runId, "run")}/${refSafeSegment(blockId, "node")}`;
}

/**
 * Preserve a failed-but-committed node's work so it can never be lost. A node that
 * committed real edits to its worktree branch but then failed verify / the
 * write-scope gate / the cherry-pick is about to have its worktree removed and (on
 * the next re-dispatch) its branch force-deleted — orphaning the commit. The dogfood
 * lost a verified fix exactly this way (the worktree was pruned before recovery).
 * Point a durable ref at the branch tip: a ref under refs/remediation-quarantine/
 * survives `git branch -D` and `git worktree prune`, so the work stays reachable for
 * a manual `git cherry-pick`. Best-effort; returns the ref + commit, or null.
 */
export function quarantineFailedNodeCommit(
  root: string,
  branch: string,
  runId: string,
  blockId: string,
): { ref: string; commit: string } | null {
  const rev = spawnSyncHidden("git", ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (rev.status !== 0) return null;
  const commit = (rev.stdout ?? "").trim();
  const ref = quarantineRef(runId, blockId);
  const upd = spawnSyncHidden("git", ["update-ref", ref, commit], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (upd.status !== 0) {
    process.stderr.write(
      `[remediate-code] could not quarantine ${branch}: ${(upd.stderr ?? "").trim()}\n`,
    );
    return null;
  }
  process.stderr.write(
    `[remediate-code] preserved failed node ${blockId} commit ${commit.slice(0, 8)} at ${ref} for recovery\n`,
  );
  return { ref, commit };
}

/**
 * Preserve a failed-but-UNCOMMITTED node's worktree edits before the worktree is
 * removed. The verify / scope / merge-fail paths quarantine an already-committed
 * branch tip; this is the missing twin for the commit-REFUSAL path: when
 * `commitWorktree` fails loudly (e.g. a generated artifact landed under the write
 * scope — the genuine CE-003 fail-loud), the worker's real source edits are still
 * sitting uncommitted in the worktree and would be destroyed by `removeWorktree`.
 * Stage everything and land a preservation commit on the node's ISOLATED branch
 * (never cherry-picked into main — it exists only so a durable quarantine ref can
 * point at the otherwise-lost work), then quarantine that commit. A guard that
 * destroys good work is worse than the bug it guards. Best-effort; returns the
 * quarantine ref + commit, or null when there was nothing to preserve / it failed.
 */
export function quarantineUncommittedWorktreeEdits(
  root: string,
  worktreeRoot: string,
  branch: string,
  runId: string,
  blockId: string,
): { ref: string; commit: string } | null {
  // Stage tracked modifications + new (non-ignored) source files. `git add -A`
  // honours .gitignore, so the incidental ignored churn (node_modules/dist) and
  // the offending generated artifact stay out — what we preserve is the worker's
  // real source work.
  const add = spawnSyncHidden("git", ["add", "-A"], {
    cwd: worktreeRoot,
    encoding: "utf8",
    shell: false,
  });
  if (add.status !== 0) return null;
  // Nothing staged → no uncommitted edits to preserve.
  const staged = spawnSyncHidden("git", ["diff", "--cached", "--quiet"], {
    cwd: worktreeRoot,
    shell: false,
  });
  if (staged.status === 0) return null;
  const commit = spawnSyncHidden(
    "git",
    ["commit", "-m", `remediate-quarantine ${blockId} (${runId}) — fail-loud preserve`],
    { cwd: worktreeRoot, encoding: "utf8", shell: false },
  );
  if (commit.status !== 0) {
    process.stderr.write(
      `[remediate-code] could not preserve uncommitted edits for ${blockId}: ${(commit.stderr ?? "").trim()}\n`,
    );
    return null;
  }
  return quarantineFailedNodeCommit(root, branch, runId, blockId);
}

/**
 * Point a node's durable quarantine ref straight at a captured commit OID, with no
 * live branch dependency (INV-WTS-3/7 clobber recovery). Used when a concurrent
 * sweep/accept has already reset or deleted the node's branch ref toward base so
 * `quarantineFailedNodeCommit` (which rev-parses the branch) can no longer resolve
 * the work — the captured OID from the node's own accept-outcome is still a
 * reachable commit object, so preserving it here keeps the honest committed work
 * recoverable instead of silently lost. Best-effort; returns the ref + commit, or
 * null when the update-ref failed.
 */
export function quarantineCommitByOid(
  root: string,
  runId: string,
  blockId: string,
  commitOid: string,
): { ref: string; commit: string } | null {
  if (!commitOid) return null;
  const ref = quarantineRef(runId, blockId);
  const upd = spawnSyncHidden("git", ["update-ref", ref, commitOid], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (upd.status !== 0) {
    process.stderr.write(
      `[remediate-code] could not quarantine ${blockId} commit ${commitOid.slice(0, 8)}: ${(upd.stderr ?? "").trim()}\n`,
    );
    return null;
  }
  process.stderr.write(
    `[remediate-code] preserved clobbered node ${blockId} commit ${commitOid.slice(0, 8)} at ${ref} for recovery\n`,
  );
  return { ref, commit: commitOid };
}

/** Clear a node's quarantine ref (e.g. once a later re-dispatch landed successfully). Best-effort. */
export function clearQuarantinedCommit(root: string, runId: string, blockId: string): void {
  spawnSyncHidden("git", ["update-ref", "-d", quarantineRef(runId, blockId)], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
}

/** Quarantined failed-node commits still preserved for a run, for recovery surfacing in the report. */
export function listQuarantinedCommits(
  root: string,
  runId: string,
): Array<{ block: string; ref: string; commit: string }> {
  const prefix = `refs/remediation-quarantine/${refSafeSegment(runId, "run")}/`;
  const res = spawnSyncHidden("git", ["for-each-ref", "--format=%(refname) %(objectname)", prefix], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (res.status !== 0 || !res.stdout) return [];
  const out: Array<{ block: string; ref: string; commit: string }> = [];
  for (const line of res.stdout.split("\n")) {
    const [ref, commit] = line.trim().split(/\s+/);
    if (!ref || !commit) continue;
    out.push({ block: ref.slice(prefix.length), ref, commit });
  }
  return out;
}

/**
 * Ensure the main checkout is on the dedicated remediation branch BEFORE any node
 * commit is cherry-picked, so accepted work lands there and the user's base branch
 * is NEVER modified — the run leaves a feature branch for review (it does not merge
 * back). Idempotent across waves: creates the branch from the current HEAD (the base)
 * the first time, checks it out on later waves. Best-effort on a non-git root (the
 * worktree dispatch flow can't run there anyway): returns null without throwing so
 * non-git callers/tests are unaffected. Returns the branch name on success.
 */
/** Sidecar recording the base branch the run was launched from (B5). */
export function remediationBaseBranchPath(artifactsDir: string): string {
  return join(artifactsDir, "remediation-base-branch.json");
}

/**
 * The base branch this run was launched from, recorded when the remediation
 * branch was first created. `null` when unrecorded (e.g. a detached HEAD at
 * launch, or a branch created by a prior run) — the opt-in merge-to-base
 * closing action degrades to "merge manually" rather than guessing a target.
 */
export function readRemediationBaseBranch(artifactsDir: string): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(remediationBaseBranchPath(artifactsDir), "utf8"),
    );
    return typeof parsed?.base_branch === "string" && parsed.base_branch.length > 0
      ? parsed.base_branch
      : null;
  } catch {
    return null;
  }
}

export function ensureRemediationBranchCheckedOut(
  root: string,
  runId: string,
  artifactsDir?: string,
): string | null {
  const top = gitTopLevel(root);
  if (top === null || canonicalPathKey(top) !== canonicalPathKey(root)) return null;
  const branch = remediationBranchName(runId);
  const current = spawnSyncHidden("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (current.status === 0 && (current.stdout ?? "").trim() === branch) return branch;
  const branchExisted = gitBranchExists(root, branch);
  const args = branchExisted ? ["checkout", branch] : ["checkout", "-b", branch];
  const co = spawnSyncHidden("git", args, { cwd: root, encoding: "utf8", shell: false });
  if (co.status !== 0) {
    process.stderr.write(
      `[remediate-code] could not switch to remediation branch ${branch}: ${(co.stderr ?? "").trim()}\n`,
    );
    return null;
  }
  // First creation: record the branch we came from as the merge-back target (B5).
  // Only a real branch name — a detached HEAD reports "HEAD" and is skipped.
  if (!branchExisted && artifactsDir) {
    const base = current.status === 0 ? (current.stdout ?? "").trim() : "";
    if (base && base !== "HEAD" && base !== branch) {
      try {
        writeFileSync(
          remediationBaseBranchPath(artifactsDir),
          JSON.stringify({ base_branch: base }, null, 2),
        );
      } catch {
        // best-effort: an unrecorded base degrades to manual merge, never throws
      }
    }
  }
  process.stderr.write(
    `[remediate-code] remediation changes land on branch ${branch} (base branch left untouched)\n`,
  );
  return branch;
}

/**
 * Stage and commit all of a worktree's edits onto its branch. The TOOL owns this
 * commit (never the worker/host) so that the branch has a real commit for two
 * downstream invariants: `gitEditedFilesForBranch` (the write-scope ground truth,
 * `HEAD...<branch>`) and `mergeWorktree`'s cherry-pick both operate on the worker's
 * changes rather than an empty diff against HEAD. Gitignored paths (node_modules,
 * .audit-tools artifacts, the result file written to the main artifacts dir) are
 * excluded by `git add -A` honoring .gitignore, so the commit captures exactly the
 * source edits. Returns `committed:false` (not an error) when the worker made no
 * tracked edits — there is then nothing to verify or merge.
 */
/**
 * Source-file extensions a worker is allowed to CREATE as a brand-new untracked
 * file that `.gitignore` happens to shadow. A new source file (a .ts the build
 * compiles, a .js shim, a source .json fixture/config) is real work that MUST land
 * even though `git add -A` honours `.gitignore` and would silently drop it
 * (CE-003/CE-004 — the dogfood lost a gitignored friction-dir file exactly this
 * way). A new
 * file with any OTHER suffix under write scope is a GENERATED artifact (`.tsbuildinfo`,
 * an emitted `.d.ts`, a coverage dump, …) — committing it would land a stale build
 * output, so those FAIL LOUDLY rather than commit a half-change.
 */
const SOURCE_NEW_FILE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
]);

/**
 * A new untracked-ignored file is a SOURCE file (force-add it) iff its extension
 * is in {@link SOURCE_NEW_FILE_EXTENSIONS} AND it is not a generated declaration
 * (`.d.ts` / `.d.mts` / `.d.cts`) — a generated `.d.ts` has a `.ts` suffix but is
 * build output, so it must be excluded from the source set.
 */
function isSourceNewFile(rel: string): boolean {
  const lower = rel.toLowerCase();
  if (/\.d\.[cm]?ts$/.test(lower)) return false;
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return false;
  return SOURCE_NEW_FILE_EXTENSIONS.has(lower.slice(dot));
}

/**
 * Whether a repo-relative path falls UNDER one of the block's declared write
 * paths. A declared path matches a new file when it is the file itself, a
 * directory prefix of it (declared `src/x` matches `src/x/new.ts`), or a glob
 * whose pre-wildcard directory prefix contains it (a leading-wildcard glob like
 * a friction-dir pattern matches `src/a/friction/new.ts`). Declared paths and the
 * candidate are normalized to
 * repo-relative forward-slash form so the comparison is OS-agnostic.
 */
function isUnderWritePaths(rel: string, declaredWritePaths: string[], root: string): boolean {
  const target = toRepoRelative(rel, root);
  for (const raw of declaredWritePaths) {
    const declared = toRepoRelative(raw, root);
    if (declared === target) return true;
    // Glob: reduce a wildcard pattern to the leading literal dir segment(s)
    // before the first wildcard and treat that as a containing prefix.
    const wildcard = declared.search(/[*?[]/);
    const literalPrefix = (wildcard >= 0 ? declared.slice(0, wildcard) : declared)
      .replace(/\/+$/, "");
    if (literalPrefix.length === 0) {
      // A leading-wildcard glob (a friction-dir style pattern) — match on the
      // trailing literal segment appearing anywhere in the candidate's path.
      const trailing = declared.replace(/^[*?/]+/, "").replace(/\/+$/, "");
      if (trailing.length > 0 && (target === trailing || target.includes(`/${trailing}/`) || target.includes(`${trailing}/`))) {
        return true;
      }
      continue;
    }
    if (target === literalPrefix || target.startsWith(`${literalPrefix}/`)) return true;
  }
  return false;
}

/**
 * Force-add worker-created NEW files that `.gitignore` shadows so genuine new
 * source work lands in the commit. `git add -A` (and any diff) honour `.gitignore`
 * and can ONLY be enumerated via `git ls-files --others --ignored
 * --exclude-standard`. Only files UNDER the block's declared write scope are
 * considered: a source-extension one is `git add -f`'d so it lands; a non-source
 * one (generated artifact under a source dir) FAILS LOUDLY rather than committing
 * build output. An untracked-ignored file OUTSIDE the write scope is incidental
 * churn (node_modules created by running npm in the worktree, dist/, .audit-tools/,
 * another module's output) — `git add -A` already skips it, so it is skipped here
 * too (it must NOT trip a fail-loud; doing so falsely rejected every node whose
 * worker ran npm in its worktree). `declaredWritePaths` undefined → the lifecycle
 * unit-test path with no scope: skip force-add entirely (legacy behaviour).
 */
function forceAddNewSourceFiles(
  worktreeRoot: string,
  declaredWritePaths: string[] | undefined,
): { ok: true } | { ok: false; error: string } {
  if (declaredWritePaths === undefined) return { ok: true };
  const ls = spawnSyncHidden(
    "git",
    ["ls-files", "--others", "--ignored", "--exclude-standard"],
    { cwd: worktreeRoot, encoding: "utf8", shell: false },
  );
  if (ls.error || ls.status !== 0) {
    return {
      ok: false,
      error: `git ls-files (untracked-ignored enumeration) failed: ${
        (ls.stderr ?? ls.error?.message ?? "").toString().trim()
      }`,
    };
  }
  const newFiles = (ls.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, "/"))
    .filter((l) => l.length > 0);
  const toForceAdd: string[] = [];
  for (const rel of newFiles) {
    // Only files UNDER the node's declared write scope are candidates. An
    // untracked-ignored file OUTSIDE the write scope is incidental churn the
    // worker did not author as part of this change — node_modules (e.g.
    // `node_modules/.bin/esbuild` created by running npm/vitest in the worktree),
    // `dist/`, `.audit-tools/`, or another module's output. `git add -A` already
    // skips all of it; it must NOT trip a fail-loud (doing so falsely rejected
    // every node whose worker ran npm in its worktree). Skip it.
    if (!isUnderWritePaths(rel, declaredWritePaths, worktreeRoot)) continue;
    if (isSourceNewFile(rel)) {
      toForceAdd.push(rel);
      continue;
    }
    // Under the declared write scope but NOT a source extension: a generated
    // artifact (e.g. a `.tsbuildinfo` / generated `.d.ts`) a worker dropped under
    // a source dir. This is the genuine CE-003 case — fail loudly rather than
    // committing build output.
    return {
      ok: false,
      error:
        `Worker created a new non-source (generated) file under its write scope: ${rel}. ` +
        `Only source-extension new files are committed; a generated artifact must not land. ` +
        `Refusing to commit a half-change.`,
    };
  }
  for (const rel of toForceAdd) {
    const add = spawnSyncHidden("git", ["add", "-f", "--", rel], {
      cwd: worktreeRoot,
      encoding: "utf8",
      shell: false,
    });
    if (add.status !== 0) {
      return { ok: false, error: `git add -f ${rel} failed: ${(add.stderr ?? "").trim()}` };
    }
  }
  return { ok: true };
}

export function commitWorktree(
  worktreeRoot: string,
  message: string,
  declaredWritePaths?: string[],
): { committed: boolean; error?: string } {
  // Force-add worker-created new SOURCE files that `.gitignore` shadows (and fail
  // loudly on a generated-artifact / out-of-scope new file) BEFORE `git add -A`,
  // which on its own silently drops every untracked-ignored path (CE-003/CE-004).
  const forced = forceAddNewSourceFiles(worktreeRoot, declaredWritePaths);
  if (!forced.ok) {
    return { committed: false, error: forced.error };
  }
  const add = spawnSyncHidden("git", ["add", "-A"], {
    cwd: worktreeRoot,
    encoding: "utf8",
    shell: false,
  });
  if (add.status !== 0) {
    return { committed: false, error: `git add failed: ${(add.stderr ?? "").trim()}` };
  }
  // `git diff --cached --quiet` exits 0 when nothing is staged → no worker edits.
  const staged = spawnSyncHidden("git", ["diff", "--cached", "--quiet"], {
    cwd: worktreeRoot,
    shell: false,
  });
  if (staged.status === 0) {
    return { committed: false };
  }
  const commit = spawnSyncHidden("git", ["commit", "-m", message], {
    cwd: worktreeRoot,
    encoding: "utf8",
    shell: false,
  });
  if (commit.status !== 0) {
    return { committed: false, error: `git commit failed: ${(commit.stderr ?? "").trim()}` };
  }
  return { committed: true };
}

/**
 * Make the main checkout's installed `node_modules` available to a worktree. A
 * fresh `git worktree add` checks out only tracked files, and `node_modules` is
 * gitignored, so per-node verify commands (`npm run check`, focused tests) would
 * otherwise fail with missing dependencies. Best-effort junction/symlink to the
 * main root's `node_modules`; on failure it logs and the verify step surfaces the
 * missing-deps error rather than crashing the dispatch. NOTE: workspace package
 * symlinks inside `node_modules/@audit-tools/*` point back into the MAIN checkout,
 * so cross-package runtime resolution sees the main tree — the authoritative
 * cross-package re-check is the central post-merge build/gate, not this fast
 * per-node verify (which gates obvious breakage early).
 */
export function ensureWorktreeNodeModules(mainRoot: string, worktreeRoot: string): void {
  const target = join(mainRoot, "node_modules");
  const link = join(worktreeRoot, "node_modules");
  if (!existsSync(target) || existsSync(link)) return;
  try {
    symlinkSync(target, link, "junction");
  } catch (err) {
    process.stderr.write(
      `[remediate-code] worktree node_modules link failed (${worktreeRoot}): ${String(err)}\n`,
    );
  }
}
