// sites-pinned: tests/remediate/host-handoff-corroboration.test.ts, tests/remediate/host-handoff.test.ts
import {
  AUDIT_TOOLS_DIRNAME,
  compareCodeUnits,
  isGitRepo,
  normalizeRepoPath,
  repoRelativePath,
  runTrackedAsync,
  TRACKED_CHILD_DEADLINE_MS,
  type IngestionCheckId,
} from "audit-tools/shared";
import {
  type RemediationRequiredTestVerdicts,
  requiredTestIssue,
  rerunRequiredTests,
} from "./requiredTests.js";
import type {
  CurrentRemediationHostState,
  RemediationHostIngestIssue,
  RemediationHostResult,
  RemediationHostWorkItem,
} from "./internal.js";

function pathIsAllowedByWriteScope(
  root: string,
  candidate: string,
  allowedFiles: readonly string[],
): boolean {
  let normalized: string;
  try {
    normalized = repoRelativePath(root, candidate, "landed file");
  } catch {
    return false;
  }
  if (normalized !== candidate) return false;
  return allowedFiles.some((allowed) =>
    allowed.endsWith("/")
      ? normalized.startsWith(allowed)
      : normalized === allowed,
  );
}

export type CorroboratedHostResult =
  | {
      readonly ok: true;
      readonly changedFiles: readonly string[];
      /**
       * True only when the baseline→landed ancestry check was WAIVED under an
       * orphaned baseline. The caller must record the acceptance on the
       * submission ledger before it lands.
       */
      readonly usedRecovery: boolean;
    }
  | {
      readonly ok: false;
      readonly code: RemediationHostIngestIssue["code"];
      readonly check: IngestionCheckId;
      readonly message: string;
    };

// The corroboration probes below run while the remediation state lock (and, on
// the fold path, the phase lock) is held — ASYNC with the shared deadline
// (INV-SSF), so the held lock's mtime heartbeat keeps beating through each
// probe and a git that never answers cannot hang the ingest.
export async function gitCommitExists(root: string, commit: string): Promise<boolean> {
  const result = await runTrackedAsync(
    ["git", "rev-parse", "--verify", "--quiet", `${commit}^{commit}`],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  return !result.error && result.status === 0;
}

// INV-WTS-3 (landed-node ancestry): a landed node's commit must be an ancestor
// of the ref it claims to have landed on. `git merge-base --is-ancestor` exits 0
// exactly when that holds.
export async function gitCommitIsAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await runTrackedAsync(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  return !result.error && result.status === 0;
}

/**
 * Is this commit ORPHANED — unreachable from anything the repository still
 * keeps?
 *
 * "Not an ancestor of HEAD" is NOT orphanhood. A baseline sitting on an
 * unmerged `feature` branch while the work landed on trunk fails the ancestry
 * test exactly like a rewritten-away commit does, and treating that as orphaned
 * would hand the relaxation to the ordinary cross-branch case — precisely the
 * stale-worker situation the ancestry check exists to catch.
 *
 * So orphanhood is the CONJUNCTION of two probes: `git for-each-ref --contains`
 * lists every branch/tag/remote ref whose history contains the commit (empty
 * output = no live ref keeps it), and the HEAD ancestry check rides alongside
 * it.
 *
 * A THIRD source of reachability sits outside `for-each-ref` entirely: the
 * HEADs of this repository's OTHER worktrees, checked into no ref at all. In a
 * linked worktree git DETACHES HEAD (or parks a per-worktree branch), so a
 * baseline that is the live HEAD of a sibling worktree — exactly the state a
 * parallel remediation lane is in — would be reported as contained by nothing,
 * i.e. orphaned, and the relaxation would be handed out for a commit the
 * repository is actively keeping. `git worktree list --porcelain` enumerates
 * every worktree with its current HEAD, so it is read and compared. The linked
 * worktree's own HEAD is included by this probe, which is why the ordinary
 * detached-HEAD case needs no separate arm.
 *
 * RESIDUAL, deliberately not closed: that probe compares HEAD for EQUALITY, so
 * it covers a worktree detached at the baseline ONLY when its HEAD *is* the
 * baseline. A sibling worktree detached at a DESCENDANT of the baseline — a
 * lane that landed further commits on top — keeps the baseline reachable while
 * matching no ref and no worktree HEAD, and is still reported orphaned. Closing
 * it means an ancestry probe per enumerated worktree HEAD; the residual is
 * stated here rather than left as an implied full cover.
 *
 * A failed scan is not evidence of orphanhood — any probe that cannot answer
 * fails closed, so a git that cannot answer never unlocks the relaxation.
 */
export async function gitCommitIsOrphaned(
  root: string,
  commit: string,
): Promise<boolean> {
  if (await gitCommitIsAncestor(root, commit, "HEAD")) return false;
  const result = await runTrackedAsync(
    ["git", "for-each-ref", "--contains", commit, "--format=%(refname)"],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  if (result.error || result.status !== 0) return false;
  if (result.stdout.trim().length > 0) return false;
  // Reached only when no REF keeps the commit. Every worktree HEAD is then
  // checked, so the detached (and per-worktree-branch) HEADs git does not
  // enumerate as refs are still seen.
  const worktrees = await runTrackedAsync(
    ["git", "worktree", "list", "--porcelain"],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  if (worktrees.error || worktrees.status !== 0) return false;
  return !worktrees.stdout
    .split("\n")
    .filter((line) => line.startsWith("HEAD "))
    .some((line) => line.slice("HEAD ".length).trim() === commit);
}

export async function gitChangedFilesOfCommit(
  root: string,
  commit: string,
): Promise<readonly string[] | null> {
  const result = await runTrackedAsync(
    [
      "git",
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      commit,
    ],
    { cwd: root, encoding: "utf8", timeout: TRACKED_CHILD_DEADLINE_MS },
  );
  if (result.error || result.status !== 0) return null;
  return [...new Set(result.stdout.split("\0").filter(Boolean))].sort(
    compareCodeUnits,
  );
}

/**
 * Every repo-relative path the tree shows as touched since `baseline` — the
 * commits baseline→HEAD, the working tree's own deviation from HEAD (staged and
 * unstaged alike), and the untracked files git considers repository content.
 *
 * All three legs are needed to falsify a no-change claim, and they enumerate the
 * three ways a host can have edited: committed (leg 1), edited a TRACKED file
 * and left it uncommitted (leg 2), and CREATED a file (leg 3). A new `src/*.ts`
 * is a real edit and the most natural shape a remediation takes; without leg 3
 * the cheapest way to smuggle one past a no-change claim was simply never to
 * `git add` it. `null` means git could not answer, which callers must treat as
 * "cannot corroborate" rather than as "nothing changed".
 *
 * The untracked leg honours `--exclude-standard`, so it enumerates only what git
 * itself treats as content — a repo's `.gitignore`d build and coverage output is
 * already invisible to it. Two exemptions cover the remainder, both ground
 * truth rather than the host's word:
 *
 *  - THIS TOOL'S OWN ARTIFACT TREE ({@link AUDIT_TOOLS_DIRNAME}) is subtracted
 *    here, explicitly. In a real repository the tool writes a managed
 *    `.gitignore` block covering it, so it never reaches this probe at all; the
 *    explicit subtraction is what makes that independent of whether the block
 *    has been written yet, so a bare root (a fixture, a first run) cannot
 *    manufacture a false refusal out of the tool's own workload, prompt and
 *    result documents.
 *  - PRE-EXISTING untracked strays are excused by the caller's `excusedPaths`,
 *    for free: `run_start_dirty` is captured from `stagedAndUntracked` before
 *    any remediation edit exists, so it already enumerates untracked files.
 *    What survives both is an untracked file that appeared DURING the run — the
 *    only untracked class that can be this host's edit.
 */
export async function gitChangedFilesSince(
  root: string,
  baseline: string,
): Promise<readonly string[] | null> {
  const files = new Set<string>();
  for (const args of [
    // baseline → HEAD: what the host committed.
    ["diff", "--name-only", "-z", baseline, "HEAD"],
    // HEAD → working tree: what the host edited and did not commit.
    ["diff", "--name-only", "-z", "HEAD"],
    // Never added: what the host CREATED. `--exclude-standard` keeps git's own
    // ignore rules authoritative.
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    const probe = await runTrackedAsync(["git", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: TRACKED_CHILD_DEADLINE_MS,
    });
    if (probe.error || probe.status !== 0) return null;
    for (const file of probe.stdout.split("\0").filter(Boolean)) {
      if (isAuditToolsArtifactPath(file)) continue;
      files.add(file);
    }
  }
  return [...files].sort(compareCodeUnits);
}

/** Whether a repo-relative path lives inside this tool's own artifact tree. */
export function isAuditToolsArtifactPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return (
    normalized === AUDIT_TOOLS_DIRNAME ||
    normalized.startsWith(`${AUDIT_TOOLS_DIRNAME}/`)
  );
}

/**
 * Corroborate an explicit `resolved_no_change` decision against the repository.
 *
 * A no-change decision used to be accepted on its evidence STRINGS alone, with
 * only the required tests re-run — so a host that had in fact edited and then
 * declared "nothing to do" was recorded as verified-no-change, and the edit
 * rode into the run unattributed. The claim is mechanically falsifiable, so it
 * is FALSIFIED.
 *
 * The scope of the falsification is the FULL write-scope corroboration every
 * other acceptance path gets, NOT a narrowing to this item's `allowed_files`.
 * `corroborateHostResult` refuses a landed commit that touched anything outside
 * `allowed_files`; a no-change decision that narrowed the check to files INSIDE
 * `allowed_files` would be the inverse rule — the out-of-scope edit, the more
 * serious of the two, would be the one silently admitted. So EVERY path the
 * tree shows as moved since the workload baseline refuses the claim.
 *
 * `excusedPaths` is the only exemption, and it is ground truth rather than the
 * host's word: `run_start_dirty` (already dirty before the run began, so not
 * evidence that this host edited anything — and because it is captured from
 * `stagedAndUntracked`, it excuses pre-existing UNTRACKED strays too) unioned
 * with the accepted edit surface — `applied_edit_surface` plus whatever this
 * same ingest has already corroborated and accepted, so a sibling work item's
 * legitimately landed files do not falsify this item's claim.
 *
 * Fails CLOSED, like every other corroboration here: a git that cannot answer
 * refuses the claim rather than admitting it.
 */
export async function corroborateNoChangeClaim(params: {
  readonly root: string;
  readonly workItem: RemediationHostWorkItem;
  /** Repo-relative paths whose movement is already accounted for. */
  readonly excusedPaths: ReadonlySet<string>;
}): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: RemediationHostIngestIssue["code"];
      readonly check: IngestionCheckId;
      readonly message: string;
    }
> {
  const { root, workItem, excusedPaths } = params;
  if (!(await isGitRepo(root))) return { ok: true };
  const baseline = workItem.baseline_commit;
  if (!(await gitCommitExists(root, baseline))) {
    return {
      ok: false,
      code: "commit_missing",
      check: "no_change_corroboration",
      message:
        "resolved_no_change cannot be corroborated: baseline_commit does not resolve to a real commit",
    };
  }
  const changed = await gitChangedFilesSince(root, baseline);
  if (changed === null) {
    return {
      ok: false,
      code: "commit_missing",
      check: "no_change_corroboration",
      message:
        "resolved_no_change cannot be corroborated: git could not enumerate the changes since the workload baseline",
    };
  }
  const violating = changed.filter(
    (path) => !excusedPaths.has(normalizeRepoPath(path)),
  );
  if (violating.length > 0) {
    const inScope = violating.filter((path) =>
      pathIsAllowedByWriteScope(root, path, workItem.allowed_files),
    );
    const outOfScope = violating.filter(
      (path) => !pathIsAllowedByWriteScope(root, path, workItem.allowed_files),
    );
    return {
      ok: false,
      code: "changed_files_mismatch",
      check: "no_change_corroboration",
      message:
        "resolved_no_change is contradicted by the tree — these files changed since the " +
        `workload baseline: ${violating.join(", ")}` +
        (outOfScope.length > 0
          ? ` (outside the prompt-bound allowed_files: ${outOfScope.join(", ")}` +
            (inScope.length > 0 ? `; inside: ${inScope.join(", ")})` : ")")
          : ""),
    };
  }
  return { ok: true };
}

export async function corroborateHostResult(params: {
  readonly root: string;
  readonly state: CurrentRemediationHostState;
  readonly workItem: RemediationHostWorkItem;
  readonly result: RemediationHostResult;
  readonly verdicts: RemediationRequiredTestVerdicts | null;
  /** See `ingestRemediationHostResults`'s `recovery` option. */
  readonly recovery: boolean;
}): Promise<CorroboratedHostResult> {
  const { root, state, workItem, result, verdicts } = params;
  const baseline = workItem.baseline_commit;
  const landed = result.landed_commit;
  let usedRecovery = false;
  if (!(await gitCommitExists(root, baseline))) {
    return {
      ok: false,
      code: "baseline_missing",
      check: "landed_commit",
      message: "the work item's baseline_commit is not in this repository",
    };
  }
  if (!(await gitCommitExists(root, landed))) {
    return {
      ok: false,
      code: "commit_missing",
      check: "landed_commit",
      message: "landed_commit is not a commit in this repository",
    };
  }
  if (landed === baseline) {
    return {
      ok: false,
      code: "landed_commit_invalid",
      check: "landed_commit",
      message:
        "landed_commit is the baseline commit; name the commit that carries this item's edits",
    };
  }
  if (!(await gitCommitIsAncestor(root, baseline, landed))) {
    if (!params.recovery) {
      // An ORPHANED baseline (no ref contains it, HEAD cannot reach it) is a
      // fault in the run, not in the work: no commit could ever descend from
      // it. The spawn-free recovery verb is its named repair.
      if (await gitCommitIsOrphaned(root, baseline)) {
        return {
          ok: false,
          code: "baseline_orphaned",
          check: "landed_commit",
          message:
            "the work item's baseline_commit is orphaned (history was rewritten under the run); " +
            "the operator can run `recover-ingest` to accept the landed work",
        };
      }
      return {
        ok: false,
        code: "baseline_not_ancestor",
        check: "landed_commit",
        message: "the trusted workload baseline is not an ancestor of the claimed landed commit",
      };
    }
    // The relaxation is precondition-bound: it applies ONLY when the trusted
    // baseline is genuinely ORPHANED — contained by no ref AND unreachable from
    // HEAD (see gitCommitIsOrphaned). That is the one state in which no landed
    // commit could ever descend from it, so the item is unacceptable under
    // every preparable binding. A baseline the repository still keeps — on an
    // unmerged branch, a tag, a remote ref, or HEAD itself — is a HEALTHY
    // binding, and a landed commit that does not descend from it is exactly the
    // stale-worker case the ancestry check exists to catch; recovery refuses it
    // identically to the normal lane.
    if (!(await gitCommitIsOrphaned(root, baseline))) {
      return {
        ok: false,
        code: "baseline_not_ancestor",
        check: "landed_commit",
        message:
          "the trusted workload baseline is not an ancestor of the claimed landed commit, " +
          "and the baseline is NOT orphaned (a ref still contains it, or it is reachable " +
          "from HEAD), so the stale-worker protection stands and recovery cannot waive it",
      };
    }
    usedRecovery = true;
  }
  if (!(await gitCommitIsAncestor(root, landed, "HEAD"))) {
    return {
      ok: false,
      code: "commit_not_landed",
      check: "landed_commit",
      message: "landed_commit is not reachable from the repository HEAD",
    };
  }
  const actualFiles = await gitChangedFilesOfCommit(root, landed);
  if (!actualFiles || actualFiles.length === 0) {
    return {
      ok: false,
      code: "landed_commit_invalid",
      check: "landed_commit",
      message: "landed_commit changes no file; name the commit that carries this item's edits",
    };
  }
  const outOfScope = actualFiles.filter(
    (path) => !pathIsAllowedByWriteScope(root, path, workItem.allowed_files),
  );
  if (outOfScope.length > 0) {
    return {
      ok: false,
      code: "changed_files_mismatch",
      check: "write_scope",
      message:
        "the landed commit changed files outside the prompt-bound allowed_files: " +
        outOfScope.join(", "),
    };
  }
  const runStartDirty = new Set(
    (state.run_start_dirty ?? []).map(normalizeRepoPath),
  );
  const dirtyOverlap = actualFiles.filter((path) =>
    runStartDirty.has(normalizeRepoPath(path)),
  );
  if (dirtyOverlap.length > 0) {
    return {
      ok: false,
      code: "run_start_dirty_overlap",
      check: "run_start_dirt",
      message: `landed files overlap pre-existing run-start dirt: ${dirtyOverlap.join(", ")}`,
    };
  }
  const failedTests = await rerunRequiredTests(
    root,
    workItem.required_tests,
    verdicts,
  );
  if (failedTests.length > 0) {
    const issue = requiredTestIssue(workItem, failedTests);
    return { ok: false, code: issue.code, check: "required_tests", message: issue.message };
  }
  return { ok: true, changedFiles: actualFiles, usedRecovery };
}
