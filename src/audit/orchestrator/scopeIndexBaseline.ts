/**
 * The live git-index probe behind `repo_manifest.json`'s `scope_index_key`.
 *
 * WHY THIS EXISTS. `buildFileDisposition`'s untracked scope rule reads the git
 * INDEX: the tracked set (`git ls-files`) decides which candidates are in scope.
 * But `file_disposition.json`'s only declared upstream was `repo_manifest.json`,
 * and a manifest is a pure WORKTREE read — its per-file hashes do not move when
 * a file is merely staged (`git add`) or unstaged (`git rm --cached`) with its
 * content untouched. So an index-only change re-staled nothing, the persisted
 * disposition kept the old classification, and a file committed mid-run never
 * entered scope on the next audit until some unrelated content edit churned the
 * manifest.
 *
 * THE FIX IS DAG-NATIVE, not a freshness check: the index state becomes part of
 * `repo_manifest.json`'s CONTENT. `repo_manifest.json` is already
 * `file_disposition.json`'s declared upstream, so an index move now propagates
 * through the existing edge with no new artifact, no new edge, and no change to
 * the constitutional `spec/audit/dependency-map.md`.
 *
 * HOW A LIVE PROBE REACHES THE METADATA. A plain artifact's recorded content
 * hash only moves when something RE-DERIVES it, and nothing re-derives it until
 * it is stale — the chicken-and-egg this probe breaks by riding the mechanism
 * `tooling_manifest.json` already uses: `advanceAudit` re-probes it from live
 * state on every fold and lists it in the always-updated set, so
 * `computeArtifactMetadata` restamps it from live content. Unchanged content
 * keeps its revision (no churn); a moved index bumps it, and
 * `file_disposition.json` goes stale exactly once.
 *
 * READ-SET DIRECTION. The probe is restricted to the manifest's own candidate
 * paths — exactly the set the untracked rule classifies. An `ls-files` entry
 * outside that set (an unrelated file staged elsewhere) cannot change the
 * disposition, and hashing it would churn the whole downstream DAG for nothing.
 * Absent root / absent git / a failed spawn yields `null`, which the caller
 * leaves unset: the manifest then carries no index claim at all, and the
 * pre-existing content-only behaviour is preserved verbatim.
 *
 * RECURSION IS PART OF THE ATOMIC PAIR, not a tuning knob. The rule this probe
 * tracks (`buildFileDisposition`'s untracked classification) reads the index
 * with `--recurse-submodules`, and so does the citation-grounding corpus
 * (`enumerateTrackedFilePaths`) — the flag is ONE decision shared by all three,
 * because "tracked" must mean one thing everywhere or a finding grounds against
 * a file the disposition excluded. A probe without the flag returns a stable,
 * plausible key that simply cannot see a move INSIDE a submodule: the gitlink
 * line is unchanged, the parent's own entries are unchanged, so
 * `scope_index_key` holds still while the recursive tracked set moves — and the
 * stale `file_disposition.json` this probe exists to catch is carried forward
 * silently, for exactly the repos that have first-party submodules.
 */
import {
  hashContent,
  runTrackedAsync,
  TRACKED_CHILD_DEADLINE_MS,
  normalizeRepoPath,
} from "audit-tools/shared";
import type { RepoManifest } from "../types.js";
import { toPosixPath } from "audit-tools/shared";

/**
 * Probe the live git index for the audited candidate set and return a stable
 * content key over the tracked intersection, or `null` when git cannot be read
 * (no root, not a work tree, git absent, non-zero exit, spawn failure). Never
 * throws — this runs inside the advance fold, where a bad manifest must degrade
 * and not take down the run.
 *
 * Sorted and separator-normalized before hashing, so the key is derived from
 * the tracked SET and never from `ls-files` output order.
 */
export async function probeScopeIndexKey(
  root: string,
  candidatePaths: readonly string[],
): Promise<string | null> {
  if (candidatePaths.length === 0) return null;
  let result;
  try {
    result = await runTrackedAsync(["git", "ls-files", "-z", "--recurse-submodules"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: TRACKED_CHILD_DEADLINE_MS,
    });
  } catch {
    return null;
  }
  if (result.error || result.status !== 0) return null;

  const tracked = new Set(
    (result.stdout ?? "")
      .split("\0")
      .filter((path) => path.length > 0)
      .map(normalizeRepoPath),
  );
  const trackedCandidates = candidatePaths
    .map((path) => normalizeRepoPath(toPosixPath(path)))
    .filter((path) => tracked.has(path))
    .sort();
  return hashContent(trackedCandidates.join("\n"));
}

/**
 * A fold's probe cache: the last probe's inputs and its answer.
 *
 * `runSingleAdvanceStep` probes on EVERY dispatch, and a fold dispatches up to
 * `MAX_DRAIN_STEPS` times — a `git` spawn per obligation execution over a value
 * that cannot move underneath it. The fold creates ONE of these and every git
 * probe it makes shares it (`runSingleAdvanceStep` directly, and the
 * submission-polling gates through `runAuditStepUnlocked`), so a `next-step`
 * call spawns `git` once instead of once per obligation.
 *
 * The cache is HELD, not looked up, and the key is the point: it names the
 * probe's WHOLE input — the repo root and the candidate path set — so a probe
 * whose inputs differ cannot replay a stale entry. A step that re-derives the
 * manifest (the auto-fix phase writes into the audited tree, moving `files[]`)
 * mints a different key and re-probes, which is why the re-read the reviewer
 * asked to keep survives: only an identical question is answered from cache.
 * Nothing inside a fold moves the INDEX itself — no deterministic executor
 * stages or unstages, the two directions the rule reads, and the fold is
 * in-process, so no host is running `git add` underneath it.
 *
 * A caller that passes no memo (every bare `advanceAudit`, and the CLI claim
 * path) simply re-probes every time: the cache is an optimization a fold opts
 * into, never a correctness dependency.
 */
export interface ScopeIndexMemo {
  /** The last probe's input key — absent until the first probe. */
  key?: string;
  /** That probe's answer. `null` is a real answer (git unreadable), so the
   *  presence of `key` — never the truthiness of `value` — is the cache test. */
  value?: string | null;
}

/**
 * {@link probeScopeIndexKey}, memoized against `memo` when one is supplied.
 * Behaves identically to the bare probe; a caller with no memo re-probes.
 */
export async function probeScopeIndexKeyCached(
  memo: ScopeIndexMemo | undefined,
  root: string,
  candidatePaths: readonly string[],
): Promise<string | null> {
  const key = `${root}\0${candidatePaths.join("\n")}`;
  if (memo && memo.key === key) return memo.value ?? null;
  const value = await probeScopeIndexKey(root, candidatePaths);
  if (memo) {
    memo.key = key;
    memo.value = value;
  }
  return value;
}

/**
 * Return a copy of the manifest carrying the probed index key. `null` (git
 * unreadable) leaves the manifest untouched rather than stamping a sentinel —
 * a sentinel would be a claim about the index that the probe could not make,
 * and it would hash differently from the unprobed manifest for no reason.
 */
export function withScopeIndexKey(
  repoManifest: RepoManifest | undefined,
  key: string | null,
): RepoManifest | undefined {
  if (!repoManifest || key === null) return repoManifest;
  return { ...repoManifest, scope_index_key: key };
}
