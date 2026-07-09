import { join } from "node:path";
import { spawnSyncHidden } from "audit-tools/shared";
import { withFileLock } from "audit-tools/shared";
import { isLoopCorePath } from "audit-tools/shared";
import { runCommand } from "../../utils/commands.js";
import { mergedBaseCheckArgv, mergedGuardSuiteArgv } from "../gateCommands.js";
import { readJsonFile, writeJsonFile, readOptionalJsonFile } from "audit-tools/shared";
import type { RemediationBlock } from "../../state/types.js";
import type { ProviderSlot, RollingDispatchResult } from "audit-tools/shared";
import {
  runDir,
  worktreeBranchForBlock,
  gitEditedFilesForBranch,
} from "./common.js";
import {
  removeWorktree,
  commitWorktree,
  quarantineUncommittedWorktreeEdits,
  quarantineFailedNodeCommit,
  clearQuarantinedCommit,
  rebaseBranchOntoHead,
  dirtyMainTreeCollisions,
  mergeWorktree,
  baseBranchLockPath,
  worktreeNodeLockPath,
  resetNodeWorktreeAndBranch,
  createWorktree,
  seedUntrackedDeclaredPaths,
  worktreePath,
  verifyNodeInWorktree,
} from "./worktreeLifecycle.js";
import {
  deriveVerifyCommandsFromBranch,
  selfContainedVerifyCommands,
  buildFreeVerifyCommands,
} from "./verifyCommands.js";
import { enforceAcceptWriteScope } from "./writeScope.js";

/** Worker transport outcome (mirrors shared `RollingDispatchResult["outcome"]`). */
export type NodeWorkerOutcome = "success" | "error" | "rate_limited" | "timeout";

export interface AcceptNodeWorktreeParams {
  root: string;
  runId: string;
  blockId: string;
  /** The node's isolated worktree directory. */
  worktreeRoot: string;
  /** The node's worktree branch (`worktreeBranchForBlock`). */
  branch: string;
  /** The worker's transport outcome from the node dispatcher. */
  workerOutcome: NodeWorkerOutcome;
  /**
   * Per-node verify commands. OMIT (leave `undefined`) for the real rolling drivers:
   * the gate then DERIVES the verify from the node's actually-touched test files
   * post-commit ({@link deriveVerifyCommandsFromBranch}) — correct paths/runner by
   * construction, never the whole suite. Pass `[]` to skip the gate (lifecycle unit
   * tests on a minimal temp repo), or an explicit list to force specific commands.
   */
  targetedCommands?: string[];
  /**
   * The node's own `targeted_commands` (the auditor/finding-specified verification),
   * run IN ADDITION to the derived commands — filtered to the build-free subset and
   * deduped against the derive. The derive gives correct-paths-by-construction; these
   * add the fix-specific regression checks the derive misses when a fix touches no test
   * (task_7d35176d). Omit / `[]` → derive-only (the prior behaviour). Ignored when
   * `targetedCommands` is an explicit override (the lifecycle unit-test path).
   */
  additionalVerifyCommands?: string[];
  /**
   * Accept-time write-scope inputs (OBL-DS-06). The write-scope gate runs HERE —
   * after the verify, BEFORE the cherry-pick — so an out-of-scope or seam-conflicting
   * edit is PREVENTED from landing in the main tree rather than reported post-hoc once
   * it is already merged. REQUIRED (not optional): both rolling drivers always derive
   * it from the plan, so a production caller can never silently skip the gate — that
   * enforcement is the type, not host discretion (E1). A lifecycle test that does not
   * exercise scope passes `{ allBlockScopes: [] }`: an empty registry owns nothing, so
   * every edit is unowned-and-granted → the gate is a sound no-op, never a skip.
   */
  scope: {
    /** Every block's declared write scope, for amendment ownership adjudication. */
    allBlockScopes: Array<{ block_id: string; write_paths: string[] }>;
  };
  /**
   * The block's OWN declared write paths (INV-1). Threaded into `commitWorktree`
   * so worker-created new SOURCE files under scope are force-added past
   * `.gitignore` and a generated-artifact / out-of-scope new file fails loudly.
   * Omit (lifecycle unit tests with no scope) → no new-file inclusion.
   */
  writePaths?: string[];
  /**
   * The cross-package check command (argv) run in the MAIN checkout AFTER the
   * cherry-pick lands (INV-2): a RED check rolls the base back to its captured HEAD
   * OID. When omitted, the command is PINNED — derived from the repo via
   * `mergedBaseCheckArgv` (the `check`-layer of the tool-owned gate set), not a
   * hardcoded string — and skipped (`null`) on a non-monorepo target. Tests inject a
   * deterministic pass/fail argv (a `t.mock.module` seam is unusable under tsx/esm).
   * Pass `null` to skip the merged-base check entirely (legacy lifecycle unit tests
   * on a minimal repo with no check script).
   */
  mergedBaseCheckCommand?: string[] | null;
  /**
   * The cross-cutting invariant/contract GUARD suite command (argv), run in the MAIN
   * checkout AFTER the merged-base check passes but ONLY when the node's edits touched
   * a loop-core path (`isLoopCorePath`) — a RED guard rolls the base back to its
   * captured HEAD OID, exactly like the merged-base check. When omitted, the command is
   * PINNED — derived from the repo via `mergedGuardSuiteArgv` (the `verify:guards`
   * script), not a hardcoded string — and skipped (`null`) on a non-monorepo target.
   * Tests inject a deterministic pass/fail argv (a `t.mock.module` seam is unusable
   * under tsx/esm). Pass `null` to skip the loop-core guard entirely (legacy lifecycle
   * unit tests on a minimal repo with no guard script).
   */
  mergedGuardCommand?: string[] | null;
  /**
   * True ONLY when the node's OWN result file has an item_results entry with status
   * "resolved" (never "resolved_no_change") — i.e. the node itself claims a real edit.
   * Drives the stray-worktree guard below: a claimed edit whose designated worktree
   * has zero commits beyond base means the Agent tool's own `isolation:"worktree"`
   * spawned a SECOND unrelated worktree the subagent actually edited in. OMIT to
   * preserve the existing no-op contract (the benign `resolved_no_change` / lifecycle
   * unit-test path every other caller relies on today).
   */
  nodeClaimsEdit?: boolean;
}

export interface AcceptNodeWorktreeResult {
  /** The LIFECYCLE outcome (verify/merge applied), distinct from the worker transport outcome. */
  outcome: NodeWorkerOutcome;
  verifyPassed: boolean;
  merged: boolean;
  /**
   * On a failure outcome, the captured failing command + its output — the verify
   * stdout/stderr (`$ <cmd>\n<output>`), or the git commit / cherry-pick error text.
   * Persisted into the accept-outcome sidecar so triage can see the root cause
   * instead of an `outcome:error` with no captured stderr. Absent on success.
   */
  diagnostic?: string;
  /**
   * The node's OWN committed branch-tip OID, captured at commit time (INV-WTS-7).
   * Present iff the node actually committed edits; ABSENT when the worker made no
   * tracked change (the genuine `resolved_no_change` precondition). A captured OID
   * that later reads as an empty branch at merge time is a CLOBBER, never a genuine
   * no-change — the live branch state is never trusted over this captured OID.
   */
  committedOid?: string;
  /**
   * The MAIN-branch HEAD OID that landed this node's cherry-pick (INV-WTS-3),
   * present only on `merged:true`. Its reachability from the live remediation-branch
   * HEAD (`git merge-base --is-ancestor`) is the node-identity ancestry probe the
   * disposition reconcile uses — a sibling/pre-existing file at the same path can
   * never make it pass, and a rolled-back/clobbered landing fails it.
   */
  landedHeadOid?: string;
  /**
   * Set when the accept guard suspects a STRAY worktree: the node's result claimed a
   * real edit (`nodeClaimsEdit`) but its designated worktree had zero commits beyond
   * base — the Agent tool's own `isolation:"worktree"` was passed for this node,
   * spawning a second unrelated worktree the subagent actually edited in. Absent on
   * every other outcome, including the genuine no-op no-commit case.
   */
  strayWorktreeSuspected?: boolean;
  /**
   * Repo-relative paths this node ACTUALLY cherry-picked into the main tree —
   * captured PRE-merge from the node's own branch diff (`gitEditedFilesForBranch`
   * against `HEAD...branch`, BEFORE `mergeWorktree`'s cherry-pick; the same probe
   * reads empty afterward, since the change is then already contained in HEAD).
   * Present only on `merged:true`. This is the ground truth the close phase's
   * staging manifest is built from (`state.applied_edit_surface` — see
   * `mergeImplementResultsIntoState` in marshal.ts and `collectStagingFiles` in
   * `src/remediate/phases/close.ts`), never the worker's self-reported files.
   */
  editedFiles?: string[];
}

/**
 * The shared post-worker "accept node" lifecycle, extracted so BOTH rolling
 * drivers reuse identical correctness: the in-process provider engine
 * (`driveRollingImplementDispatch`) calls it inline once the worker returns; the
 * host-subagent driver calls it from the `accept-node` callback once a host
 * subagent finishes.
 *
 * Given a completed worker run in an isolated worktree, this: (1) TOOL-commits
 * the worker's edits onto the branch (deterministic, never the worker/host) so
 * the branch diff is the write-scope ground truth; (2) runs the per-node verify
 * IN the worktree BEFORE accepting; (3) merges via cherry-pick only on a passing
 * verify; and (4) drops the worktree on any failure so the main tree is never
 * dirtied by an unverified change. It returns the LIFECYCLE outcome (which the
 * caller records for the deterministic merge); the caller still returns the
 * worker's TRANSPORT outcome to the rolling engine (so a `rate_limited` worker
 * re-queues, while a verify-failure is adjudicated by the merge → triage).
 *
 * SAFETY: the main tree is touched only through `mergeWorktree` (cherry-pick of a
 * verified branch, aborts cleanly on conflict). No state mutation here — the
 * caller persists via `mergeImplementResults`.
 *
 * INV-WTS-8 (single total lock-acquisition order): the WHOLE accept is serialized
 * through this node's own {@link worktreeNodeLockPath} FIRST, and the base-mutating
 * section acquires {@link baseBranchLockPath} nested INSIDE it — never the other way
 * around. The per-node lock is acquired before the base lock on every accept path, so
 * the one fixed order makes an AB/BA cross-lock deadlock unreachable by construction
 * (CE-008). The per-node lock also serializes this node's removeWorktree/reset against
 * a concurrent same-node operation (INV-WTS-1). Both lock paths are distinct (INV-WTS-6)
 * so the non-reentrant `withFileLock` never self-deadlocks.
 */
export async function acceptNodeWorktree(
  params: AcceptNodeWorktreeParams,
): Promise<AcceptNodeWorktreeResult> {
  return withFileLock(
    worktreeNodeLockPath(params.root, params.runId, params.blockId),
    () => acceptNodeWorktreeLocked(params),
  );
}

/** The accept-node body, run while the per-node worktree lock (INV-WTS-8) is held. */
async function acceptNodeWorktreeLocked(
  params: AcceptNodeWorktreeParams,
): Promise<AcceptNodeWorktreeResult> {
  const { root, runId, blockId, worktreeRoot: wt, branch, workerOutcome, targetedCommands, additionalVerifyCommands } = params;
  let verifyPassed = false;
  let merged = false;
  // The node's own committed branch-tip OID (INV-WTS-7). Captured immediately after
  // a successful commit and threaded into every downstream return so the disposition
  // reconcile can tell a genuine no-change (no captured OID) from a clobbered
  // genuine-edit node (captured OID + later-empty branch) — the live branch state is
  // never trusted over this value.
  let committedOid: string | undefined;

  if (workerOutcome === "rate_limited") {
    // Piece D — quota-death worktree preservation: a worker that died on a host
    // session-limit is a RETRYABLE pause, not a failure. Leave its worktree INTACT
    // (do NOT removeWorktree) so nothing is destroyed during the pause; the node
    // redoes clean on resume (the re-entry `resetNodeWorktreeAndBranch` handles the
    // clean redo). Nothing to land now — return the outcome so the rolling engine
    // records the pause + strands the node pending.
    return { outcome: workerOutcome, verifyPassed, merged };
  }

  if (workerOutcome !== "success") {
    // Real worker failure (error / timeout): nothing to land; drop the worktree so
    // the main tree is never dirtied by an unverified change, preserve the outcome.
    removeWorktree(root, wt);
    return { outcome: workerOutcome, verifyPassed, merged };
  }

  const commit = commitWorktree(wt, `remediate ${blockId} (${runId})`, params.writePaths);
  if (commit.error) {
    // Could not commit the worker's edits (e.g. a generated-artifact-under-scope
    // fail-loud) → cannot safely LAND it, but the worker's real source edits are
    // still uncommitted in the worktree. Preserve them under a durable quarantine
    // ref BEFORE removing the worktree (P0 data-loss: a guard must not destroy the
    // good work alongside the offending artifact), mirroring the verify/scope/
    // merge-fail quarantine paths below.
    quarantineUncommittedWorktreeEdits(root, wt, branch, runId, blockId);
    removeWorktree(root, wt);
    return { outcome: "error", verifyPassed, merged, diagnostic: commit.error };
  }
  if (!commit.committed) {
    // Worker reported success but made no tracked edits — nothing to verify or merge.
    // The deterministic merge adjudicates the result file (resolved_no_change needs
    // evidence). NO committedOid is captured: this is the genuine no-change
    // precondition (INV-WTS-7) — the branch legitimately has no commit of its own.
    removeWorktree(root, wt);
    if (params.nodeClaimsEdit) {
      // The node's OWN result claims a real ("resolved") edit, yet its DESIGNATED
      // worktree has zero commits beyond base — that is impossible for a genuine
      // no-op and is the classic stray-worktree symptom: the Agent tool's own
      // `isolation:"worktree"` was passed when dispatching this node, spawning a
      // SECOND unrelated worktree the subagent actually edited in. Fail loud rather
      // than silently stranding the real work in that stray tree.
      return {
        outcome: "error",
        verifyPassed,
        merged,
        diagnostic:
          `node ${blockId}'s result reports a resolved (real-edit) finding, but its ` +
          `designated worktree \`${wt}\` has NO commits beyond base — the Agent ` +
          `tool's own isolation:"worktree" was passed when dispatching this node, ` +
          `spawning a SECOND unrelated worktree the subagent edited in. Never pass ` +
          `isolation:"worktree" to the Agent tool for a remediate implement node — ` +
          `the dispatch plan already creates the node's own worktree.`,
        strayWorktreeSuspected: true,
      };
    }
    return { outcome: "success", verifyPassed, merged };
  }

  // Capture the node's own committed branch tip (INV-WTS-7). The node DID commit, so
  // any later reconcile that reads its branch as empty is a clobber, not a no-change.
  const committedRev = spawnSyncHidden("git", ["rev-parse", branch], {
    cwd: root,
    encoding: "utf8",
    shell: false,
  });
  if (!committedRev.error && committedRev.status === 0) {
    committedOid = committedRev.stdout.trim();
  }

  // Base-mutating critical section (INV-2/INV-3/CE-001/CE-002/CE-005) under a DISTINCT
  // base-branch lock — NOT the per-run rolling-session.lock `advanceHostRolling` holds
  // (withFileLock is non-reentrant, so a same-path nested acquire would self-deadlock).
  // Acquired exactly ONCE here so BOTH rolling drivers serialize the rebase →
  // cherry-pick → cross-package check → reset sequence through one lock. The base HEAD
  // OID is captured before the cherry-pick so a RED merged-base check rolls the base
  // back bit-identically. The lock is released on EVERY exit path (success, verify
  // fail, scope fail, check fail, subprocess fail) by withFileLock's finally.
  return withFileLock(baseBranchLockPath(root, runId), async () => {
    // Rebase the node's branch onto the current remediation HEAD BEFORE verify, so a
    // sibling that merged after this worktree was created is folded in. Verify, the
    // write-scope gate, and the cherry-pick then all operate on the FINAL to-be-merged
    // content (green-at-merge; the later cherry-pick can no longer conflict). A true
    // hunk conflict here is a genuine seam — preserve the work and route to triage
    // rather than land a broken merge.
    const rebase = rebaseBranchOntoHead(root, wt, branch);
    if (!rebase.ok) {
      quarantineFailedNodeCommit(root, branch, runId, blockId);
      removeWorktree(root, wt);
      return { outcome: "error", verifyPassed, merged, diagnostic: rebase.error };
    }

    // Pre-flight: a dirty tracked file in the MAIN checkout that collides with a
    // path this node edits makes the later cherry-pick abort with an opaque
    // "local changes would be overwritten by merge" — a condition the node cannot
    // fix and that re-fails identically on every auto-retry. Detect it up front
    // (before the expensive verify) and surface the actionable cause; preserve the
    // committed work under quarantine like every sibling error path so nothing is
    // lost while the host commits/stashes the unrelated WIP.
    const collisions = dirtyMainTreeCollisions(root, branch);
    if (collisions.length > 0) {
      quarantineFailedNodeCommit(root, branch, runId, blockId);
      removeWorktree(root, wt);
      const paths = collisions.map((c) => `\`${c}\``).join(", ");
      const it = collisions.length > 1 ? "them" : "it";
      return {
        outcome: "error",
        verifyPassed,
        merged,
        diagnostic:
          `main tree has uncommitted changes to ${paths} — commit or stash ${it} ` +
          `before merging this node (the cherry-pick would otherwise abort with ` +
          `"local changes would be overwritten by merge"). This is unrelated to the ` +
          `node's own fix; the node's work is preserved under its quarantine ref.`,
      };
    }

    // Verify commands: when the host omits them (real rolling drivers), DERIVE them
    // from the just-committed branch's touched test files — correct paths/runner by
    // construction, only this node's own tests, never the whole suite. An explicit
    // list (or `[]` to skip) overrides; both used by lifecycle unit tests. task_7d35176d:
    // run the derive AND the node's own build-free `targeted_commands` (deduped) — the
    // auditor's fix-specific regression checks the derive misses when a fix touches no
    // test. `additionalVerifyCommands` is ignored on the explicit-override path.
    const baseCommands =
      targetedCommands === undefined
        ? deriveVerifyCommandsFromBranch(root, branch)
        : targetedCommands;
    let verifyCommands: string[];
    if (targetedCommands === undefined) {
      // Self-contained per-node verify (2026-07-03): the derived `baseCommands` come
      // from this node's ACTUAL branch edits (self-contained by construction), but the
      // node's host/auditor-authored `additionalVerifyCommands` can reference a sibling
      // node's not-yet-created deliverable → a guaranteed-fail deadlock. Drop any such
      // cross-node command (deferred to the integration/close gate). Own paths = the
      // node's declared write set ∪ the files it actually edited on its branch.
      const edited = gitEditedFilesForBranch(root, branch);
      const ownPaths = [
        ...(params.writePaths ?? []),
        ...(edited.available ? edited.files : []),
      ];
      const additional = selfContainedVerifyCommands(
        buildFreeVerifyCommands(additionalVerifyCommands),
        ownPaths,
        wt,
      );
      verifyCommands = [...new Set([...baseCommands, ...additional])];
    } else {
      verifyCommands = baseCommands;
    }
    const verify =
      verifyCommands.length > 0
        ? // INV-WTS-2: enforce the worktree-root guard on the per-node verify so a
          // worktree deleted out from under it fails LOUD instead of resolving up to MAIN.
          verifyNodeInWorktree(wt, verifyCommands, true)
        : { passed: true, output: "" };
    verifyPassed = verify.passed;
    if (!verify.passed) {
      // Verify failed: do not merge; drop the worktree so the main tree stays clean.
      // The node DID commit real edits, so preserve them under a durable quarantine
      // ref before the worktree/branch go away — a tool-verify false-negative must
      // not destroy a good fix (the dogfood lost one this way). Carry the failing
      // command + output so triage isn't blind on outcome:error.
      quarantineFailedNodeCommit(root, branch, runId, blockId);
      removeWorktree(root, wt);
      return { outcome: "error", verifyPassed, merged, diagnostic: verify.output };
    }

    // Write-scope gate (OBL-DS-06), BEFORE the cherry-pick: an out-of-scope or
    // seam-conflicting edit must never land in the main tree, so it is adjudicated
    // against the branch's git diff (the ground truth) here rather than reported
    // after `mergeWorktree` already merged it. The gate routes the node's ACTUAL
    // out-of-declared edits (git diff, never a self-report): an edit to a file no
    // sibling block owns widens the effective scope, while one owned by another
    // block blocks as a seam conflict.
    const decision = enforceAcceptWriteScope({
      root,
      branch,
      blockId,
      allBlockScopes: params.scope.allBlockScopes,
    });
    if (decision.blocked) {
      // Scope-blocked but the node committed real work — preserve it for recovery.
      quarantineFailedNodeCommit(root, branch, runId, blockId);
      removeWorktree(root, wt);
      return { outcome: "error", verifyPassed, merged: false, diagnostic: decision.reason };
    }

    // Capture the base HEAD OID BEFORE the cherry-pick so a RED merged-base check can
    // roll the base back to a bit-identical state.
    const baseHeadBefore = spawnSyncHidden("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    if (baseHeadBefore.error || baseHeadBefore.status !== 0) {
      quarantineFailedNodeCommit(root, branch, runId, blockId);
      removeWorktree(root, wt);
      return {
        outcome: "error",
        verifyPassed,
        merged,
        diagnostic: `could not capture base HEAD before merge: ${
          (baseHeadBefore.stderr ?? baseHeadBefore.error?.message ?? "").toString().trim()
        }`,
      };
    }
    const baseOid = baseHeadBefore.stdout.trim();

    // Capture the node's committed edited files BEFORE the cherry-pick — while the
    // `HEAD...branch` diff is still meaningful. After the pick the branch's change is
    // contained in HEAD, so the same probe reads EMPTY; the loop-core guard gate + its
    // scoped clean below must be driven off this pre-merge snapshot.
    const nodeEditedFiles = gitEditedFilesForBranch(root, branch);

    // mergeWorktree cherry-picks the verified branch and removes the worktree (on
    // success AND on conflict-abort), so no explicit cleanup is needed afterwards.
    const mergeRes = mergeWorktree(root, wt, branch);
    merged = mergeRes.success;
    if (!mergeRes.success) {
      // Cherry-pick conflict: the committed work would otherwise be orphaned — preserve it.
      quarantineFailedNodeCommit(root, branch, runId, blockId);
      return { outcome: "error", verifyPassed, merged, diagnostic: mergeRes.error };
    }

    // Merged-base-green (INV-2): the cherry-pick landed in the MAIN checkout, where
    // node_modules is faithful (the worktree's @audit-tools junction resolves to main
    // and is unfaithful, so the per-node worktree verify cannot catch a cross-package
    // break). Run the REAL cross-package check in the main tree. On RED, roll the base
    // back to its captured OID bit-identically, scoped-clean the cherry-pick's emitted
    // untracked files, quarantine, and fail — never leave a broken base for the sibling.
    const checkArgv =
      params.mergedBaseCheckCommand === undefined
        ? mergedBaseCheckArgv(root)
        : params.mergedBaseCheckCommand;
    if (checkArgv !== null) {
      // Paths the just-landed pick touched, so the scoped clean nukes only those
      // (never unrelated untracked state). Resolved BEFORE the check runs.
      const pickedFiles = gitEditedFilesForBranch(root, branch);
      // argv via runCommand → runTracked scrubs CLAUDECODE / CLAUDE_CODE_* and applies
      // the shared Windows `.cmd` wrapping — never `shell: true`.
      const [checkCmd, ...checkArgs] = checkArgv;
      const check = runCommand(checkCmd, checkArgs, { cwd: root, encoding: "utf8" });
      const checkFailed = !!check.error || check.status !== 0;
      if (checkFailed) {
        const detail = check.error
          ? check.error.message
          : [check.stdout ?? "", check.stderr ?? ""].filter(Boolean).join("\n");
        // Roll the base back to its pre-pick OID, bit-identical.
        spawnSyncHidden("git", ["reset", "--hard", baseOid], { cwd: root, shell: false });
        // Scoped clean: remove only the cherry-pick / check-emitted untracked files
        // under the paths the pick touched — never a blanket `git clean` that could
        // nuke unrelated untracked state.
        if (pickedFiles.available && pickedFiles.files.size > 0) {
          spawnSyncHidden(
            "git",
            ["clean", "-fdq", "--", ...[...pickedFiles.files]],
            { cwd: root, shell: false },
          );
        }
        quarantineFailedNodeCommit(root, branch, runId, blockId);
        return {
          outcome: "error",
          verifyPassed,
          merged: false,
          diagnostic: `$ ${checkArgv.join(" ")}\n${detail}`,
        };
      }
    }

    // Loop-core cross-cutting GUARD (per-node): the merged-base check above catches a
    // cross-PACKAGE type break, but a cross-FILE invariant/contract regression (a broken
    // guard test in another area) still escapes the node's own targeted verify. Run the
    // cross-cutting invariant suite in the MAIN checkout HERE — but ONLY when this node's
    // edits touched a loop-core path, so the cheap majority of nodes never pay for it. A
    // RED guard rolls the base back to its captured OID bit-identically, scoped-cleans the
    // pick's untracked files, quarantines, and fails — never leaving a broken base.
    const guardEdited = nodeEditedFiles;
    const touchesLoopCore =
      guardEdited.available && [...guardEdited.files].some((f) => isLoopCorePath(f));
    if (touchesLoopCore) {
      const guardArgv =
        params.mergedGuardCommand === undefined
          ? mergedGuardSuiteArgv(root)
          : params.mergedGuardCommand;
      if (guardArgv !== null) {
        const [guardCmd, ...guardArgs] = guardArgv;
        const res = runCommand(guardCmd, guardArgs, { cwd: root, encoding: "utf8" });
        const guardFailed = !!res.error || res.status !== 0;
        if (guardFailed) {
          const detail = res.error
            ? res.error.message
            : [res.stdout ?? "", res.stderr ?? ""].filter(Boolean).join("\n");
          // Roll the base back to its pre-pick OID, bit-identical.
          spawnSyncHidden("git", ["reset", "--hard", baseOid], { cwd: root, shell: false });
          // Scoped clean: remove only the pick / guard-emitted untracked files under the
          // paths the pick touched — never a blanket `git clean`.
          if (guardEdited.available && guardEdited.files.size > 0) {
            spawnSyncHidden(
              "git",
              ["clean", "-fdq", "--", ...[...guardEdited.files]],
              { cwd: root, shell: false },
            );
          }
          quarantineFailedNodeCommit(root, branch, runId, blockId);
          return {
            outcome: "error",
            verifyPassed,
            merged: false,
            diagnostic: `$ ${guardArgv.join(" ")}\n${detail}`,
          };
        }
      }
    }

    // Capture the MAIN-branch HEAD OID that landed this node's cherry-pick (INV-WTS-3).
    // Its reachability from the live HEAD is the node-identity ancestry probe the
    // disposition reconcile uses — never a bare path-existence check.
    const landedHead = spawnSyncHidden("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      shell: false,
    });
    const landedHeadOid =
      !landedHead.error && landedHead.status === 0 ? landedHead.stdout.trim() : undefined;

    // Landed successfully and the merged base is green: clear any quarantine ref left
    // by a prior failed attempt for this node so the recovery report lists only
    // genuinely-unrecovered work.
    clearQuarantinedCommit(root, runId, blockId);
    return {
      outcome: "success",
      verifyPassed,
      merged,
      committedOid,
      landedHeadOid,
      // nodeEditedFiles was captured pre-pick (above) — still valid here, the
      // pick landed the SAME diff it describes.
      ...(nodeEditedFiles.available ? { editedFiles: [...nodeEditedFiles.files].sort() } : {}),
    };
  });
}

/**
 * Sidecar path for a node's tool-owned accept (verify/merge) outcome. Written by
 * BOTH rolling drivers as each node is accepted, read by `mergeImplementResults`.
 * Block ids here follow the same filename-safe convention as the per-node result
 * files in the same dir.
 */
export function nodeAcceptOutcomePath(
  artifactsDir: string,
  runId: string,
  blockId: string,
): string {
  return join(runDir(artifactsDir, runId, "implement"), `accept-outcome-${blockId}.json`);
}

/**
 * Persist a node's `acceptNodeWorktree` lifecycle outcome so finalization can tell
 * a node whose edits actually LANDED (merged) from one that self-reported "resolved"
 * but failed tool-owned verify / merge (OBL-DS-06: never trust the worker's self
 * report). Both rolling drivers (host-subagent `advanceHostRolling` and in-process
 * `driveRollingImplementDispatch`) call this; the interim main-tree path writes none,
 * so the merge-state gate is inert there.
 */
export async function recordNodeAcceptOutcome(
  artifactsDir: string,
  runId: string,
  blockId: string,
  result: AcceptNodeWorktreeResult,
): Promise<void> {
  await writeJsonFile(nodeAcceptOutcomePath(artifactsDir, runId, blockId), {
    schema_version: "remediate-code-implement/node-accept-outcome/v1alpha1",
    block_id: blockId,
    outcome: result.outcome,
    verify_passed: result.verifyPassed,
    merged: result.merged,
    // Only present on a failure outcome; gives triage the failing command + output.
    ...(result.diagnostic !== undefined ? { diagnostic: result.diagnostic } : {}),
    // INV-WTS-3/7: the node's captured commit identity, ground truth the disposition
    // reconcile trusts over any live branch/path read.
    ...(result.committedOid !== undefined ? { committed_oid: result.committedOid } : {}),
    ...(result.landedHeadOid !== undefined ? { landed_head_oid: result.landedHeadOid } : {}),
    ...(result.strayWorktreeSuspected !== undefined
      ? { stray_worktree_suspected: result.strayWorktreeSuspected }
      : {}),
    // Ground truth for the close-phase staging manifest (see AcceptNodeWorktreeResult.editedFiles).
    ...(result.editedFiles !== undefined ? { edited_files: result.editedFiles } : {}),
  });
}

/** Load a node's recorded accept outcome, or null when none was written. */
export async function loadNodeAcceptOutcome(
  artifactsDir: string,
  runId: string,
  blockId: string,
): Promise<AcceptNodeWorktreeResult | null> {
  const raw = await readOptionalJsonFile<{
    outcome: NodeWorkerOutcome;
    verify_passed: boolean;
    merged: boolean;
    diagnostic?: string;
    committed_oid?: string;
    landed_head_oid?: string;
    stray_worktree_suspected?: boolean;
    edited_files?: string[];
  }>(nodeAcceptOutcomePath(artifactsDir, runId, blockId));
  if (!raw) return null;
  return {
    outcome: raw.outcome,
    verifyPassed: raw.verify_passed,
    merged: raw.merged,
    ...(raw.diagnostic !== undefined ? { diagnostic: raw.diagnostic } : {}),
    ...(raw.committed_oid !== undefined ? { committedOid: raw.committed_oid } : {}),
    ...(raw.landed_head_oid !== undefined ? { landedHeadOid: raw.landed_head_oid } : {}),
    ...(raw.stray_worktree_suspected !== undefined
      ? { strayWorktreeSuspected: raw.stray_worktree_suspected }
      : {}),
    ...(raw.edited_files !== undefined ? { editedFiles: raw.edited_files } : {}),
  };
}

/**
 * The per-node worktree worker an in-process driver launches: it edits within the
 * node's isolated worktree (cwd-confined), writes its result file, and returns the
 * transport outcome. `makeProviderNodeDispatcher` is the live implementation; tests
 * inject a stub. Structurally identical to `nextStep`'s `ProgrammaticNodeDispatcher`.
 */
export type WorktreeNodeWorker = (args: {
  block: RemediationBlock;
  slot: ProviderSlot;
  worktreeRoot: string;
  resultPath: string;
}) => Promise<RollingDispatchResult<{ block_id: string }>>;

/** One node's worktree-lifecycle result: the worker transport outcome + the accept lifecycle. */
export interface NodeWorktreeExecution {
  /** Worker transport outcome the rolling engine consumes (success/error/rate_limited/timeout). */
  result: RollingDispatchResult<{ block_id: string }>;
  /** Tool-owned accept outcome (commit→verify→merge), already persisted via recordNodeAcceptOutcome. */
  accept: AcceptNodeWorktreeResult;
}

/**
 * Run ONE node's full in-process lifecycle in an isolated worktree — shared by BOTH
 * in-process callers (the reactive `driveRollingImplementDispatch` engine and the
 * A-8 hybrid executor) so they create / commit / verify / merge identically:
 *
 *   reset + create the node's worktree → link node_modules → seed declared targets →
 *   launch the worker (`dispatchNode`) → `acceptNodeWorktree` (tool-commit, rebase,
 *   verify, write-scope gate, cherry-pick) → persist the accept outcome.
 *
 * Claim ownership is the CALLER's concern (the reactive engine claims through the
 * shared registry; the hybrid executor is handed a coordinator-minted claim), so
 * this fn neither claims nor releases — it returns the worker transport result AND
 * the accept lifecycle outcome and lets the caller record `nodeOutcomes` / release.
 * Any thrown error degrades to a dropped worktree + a persisted `error` accept
 * outcome, never an unhandled rejection into the engine.
 */
export async function executeNodeInWorktree(args: {
  block: RemediationBlock;
  slot: ProviderSlot;
  root: string;
  artifactsDir: string;
  runId: string;
  resultPath: string;
  /** Untracked declared targets to seed into the worktree (the node's write set or write∪read). */
  seedPaths: string[];
  /** Every block's declared write scope, for the accept-time write-scope gate (OBL-DS-06). */
  allBlockScopes: Array<{ block_id: string; write_paths: string[] }>;
  /** The node's own targeted_commands, run IN ADDITION to the derived verify (task_7d35176d). */
  additionalVerifyCommands?: string[];
  dispatchNode: WorktreeNodeWorker;
}): Promise<NodeWorktreeExecution> {
  const { block, slot, root, artifactsDir, runId, resultPath, seedPaths, allBlockScopes, additionalVerifyCommands, dispatchNode } = args;
  const branch = worktreeBranchForBlock(block.block_id, runId);
  const wt = worktreePath(root, block.block_id, runId);
  try {
    // Idempotent reset of any worktree dir AND leftover branch from a prior attempt
    // (a `rate_limited` re-queue re-enters for the same block with its branch still
    // present), then create this node's isolated worktree (createWorktree also links
    // the main checkout's node_modules so verify can resolve deps), and seed
    // untracked declared targets a committed-files-only worktree can't see.
    //
    // INV-WTS-1/8: serialize this node's reset→create→seed through its OWN
    // worktree lock so a concurrent same-node operation can't race the scoped
    // removal against the re-create. A DIFFERENT node holds a DIFFERENT lock (keyed
    // on block_id), so sibling nodes never contend and are never clobbered. This is
    // a SEPARATE critical section from the accept's (released before the worker runs
    // and re-acquired inside acceptNodeWorktree), so the non-reentrant lock never
    // self-deadlocks.
    await withFileLock(worktreeNodeLockPath(root, runId, block.block_id), async () => {
      resetNodeWorktreeAndBranch(root, wt, branch);
      createWorktree(root, wt, branch);
      seedUntrackedDeclaredPaths(root, wt, seedPaths);
    });
    const result = await dispatchNode({ block, slot, worktreeRoot: wt, resultPath });
    // Shared post-worker lifecycle. Verify commands are DERIVED from the node's
    // actually-touched tests inside acceptNodeWorktree (post-commit) — omit them so a
    // host-authored path can't mis-verify. The write-scope gate adjudicates the node's
    // ACTUAL git edits against every block's declared scope.
    const accept = await acceptNodeWorktree({
      root,
      runId,
      blockId: block.block_id,
      worktreeRoot: wt,
      branch,
      workerOutcome: result.outcome,
      additionalVerifyCommands,
      scope: { allBlockScopes },
      // The block's OWN declared write paths (INV-1 new-file inclusion).
      writePaths: allBlockScopes.find((b) => b.block_id === block.block_id)?.write_paths ?? [],
    });
    await recordNodeAcceptOutcome(artifactsDir, runId, block.block_id, accept);
    return { result, accept };
  } catch (err) {
    removeWorktree(root, wt);
    const accept: AcceptNodeWorktreeResult = { outcome: "error", verifyPassed: false, merged: false };
    await recordNodeAcceptOutcome(artifactsDir, runId, block.block_id, accept);
    return {
      result: {
        packet: { id: block.block_id, payload: { block_id: block.block_id }, estimatedTokens: 0, complexity: 0.5 },
        outcome: "error",
        error: err,
      },
      accept,
    };
  }
}
