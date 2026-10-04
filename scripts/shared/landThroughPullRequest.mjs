// sites-pinned: tests/shared/land-through-pull-request.test.ts
// The ONE way a commit reaches the protected default branch.
//
// Branch protection on `main` requires the `checks` status and binds admins
// (`enforce_admins`, owner decision 2026-10-04), so GitHub refuses a push of a
// commit that does not already carry every required status. CI attaches that
// status only to a push to `main` or to a pull request, so the landing path is:
//
//   1. push the commit to a landing branch of its own (the caller names it;
//      it must be unique to this commit, e.g. `land/<sha>` or `release/<tag>`),
//   2. open (or reuse) a pull request from that branch into the default
//      branch — this starts CI,
//   3. wait until every REQUIRED status on that exact commit has concluded,
//   4. fast-forward the default branch to that same commit — GitHub accepts it
//      because the statuses exist on the commit, and marks the pull request
//      merged.
// Afterwards, `deleteLandingBranch` removes the landing branch once GitHub
// reports the pull request merged. It is a separate step so nothing the caller
// still has to do (a tag push, a release) waits on GitHub's merged-state update.
//
// The commit pushed to `main` is byte-for-byte the commit CI judged: no merge
// commit, no rebase, so a tag made locally before landing still names it.
// A commit the default branch already contains is reported as landed and
// nothing is pushed, so a failed caller is retried by running it again. Both the release script (its version-bump commit) and
// `scripts/land.mjs` (a lap's work) land through here, so the protocol has one
// home.
//
// The required statuses are READ from branch protection, never restated here:
// a check-run context (with its pinned app, when protection pins one) or a
// commit-status context added to protection is waited on without an edit here.
import { spawnSync } from "node:child_process";
import { compareCodeUnits } from "./primitives.mjs";

// Bounded wait for CI runs on one commit, shared by the release script's
// pre-tag gate and this landing protocol. Moved here unchanged from
// `scripts/release-and-publish.mjs`: 30 minutes covers the whole gate+test
// matrix on every supported Node major with room to spare; a run still in
// flight past it is named as such rather than reported as absent.
export const CI_CONCLUSION_WAIT_MS = 30 * 60 * 1000;
// The release script's poll interval for GitHub Actions, shared unchanged.
export const CI_POLL_MS = 5_000;

// Consecutive-failure budget for `gh api` polls (401/403/5xx/network/timeout,
// etc.), moved here unchanged from `scripts/release-and-publish.mjs`. The status
// on GitHub is ground truth, so a single transient poll fault must never abort a
// healthy wait — see the 2026-07-09 v0.32.44 incident where a mid-wait `Bad
// credentials (HTTP 401)` blip killed a release that went on to publish cleanly.
// Back off and re-poll on every failure; only give up after this many
// CONSECUTIVE failures (any successful poll resets the counter) — by which
// point the backoff has spanned several minutes and something durable, not
// transient, is wrong. A definitive answer (a red check) still fails fast.
export const MAX_CONSECUTIVE_POLL_FAILURES = 10;
const POLL_FAILURE_BACKOFF_STEP_MS = 5_000;
const POLL_FAILURE_BACKOFF_CAP_MS = 30_000;

/** @param {number} consecutiveFailures */
export function pollFailureBackoffMs(consecutiveFailures) {
  return Math.min(POLL_FAILURE_BACKOFF_STEP_MS * consecutiveFailures, POLL_FAILURE_BACKOFF_CAP_MS);
}

/** Conclusions GitHub counts as satisfying a required check run. */
const PASSING = new Set(["success", "skipped", "neutral"]);

/**
 * The required statuses in a `required_status_checks` protection object:
 * `checks[]` (with the app each is pinned to, when GitHub records one) and the
 * legacy `contexts` list. Sorted by context so the order is content-derived.
 * @param {any} protection
 * @returns {{context: string, appId: number | null}[]}
 */
export function requiredStatusChecks(protection) {
  const byContext = new Map();
  for (const check of Array.isArray(protection?.checks) ? protection.checks : []) {
    if (typeof check?.context !== "string" || !check.context) continue;
    const appId = Number.isInteger(check.app_id) && check.app_id > 0 ? check.app_id : null;
    byContext.set(check.context, { context: check.context, appId });
  }
  for (const context of Array.isArray(protection?.contexts) ? protection.contexts : []) {
    if (typeof context === "string" && context && !byContext.has(context)) {
      byContext.set(context, { context, appId: null });
    }
  }
  return [...byContext.values()].sort((a, b) => compareCodeUnits(a.context, b.context));
}

/**
 * The verdict of the required statuses on one commit. A required status is
 * satisfied by a check run (`GET /repos/{slug}/commits/{sha}/check-runs`) of
 * that name — from the pinned app when protection pins one, the latest run
 * deciding (a re-run supersedes the run before it) — or, for a context with no
 * pinned app, by a commit status (`GET /repos/{slug}/commits/{sha}/status`).
 * `unlisted` names the contexts for which nothing at all exists yet.
 * @param {any[]} checkRuns
 * @param {any[]} statuses
 * @param {{context: string, appId: number | null}[]} required
 * @returns {{state: "green" | "red" | "pending", failed: string[], pending: string[], unlisted: string[]}}
 */
export function evaluateRequiredChecks(checkRuns, statuses, required) {
  const failed = [];
  const pending = [];
  const unlisted = [];
  for (const { context, appId } of required) {
    let latest = null;
    for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
      if (run?.name !== context) continue;
      if (appId !== null && run?.app?.id !== appId) continue;
      if (!latest || Number(run.id) > Number(latest.id)) latest = run;
    }
    const status =
      appId === null
        ? (Array.isArray(statuses) ? statuses : []).find((entry) => entry?.context === context)
        : undefined;
    if (latest) {
      if (latest.status !== "completed") pending.push(context);
      else if (!PASSING.has(latest.conclusion)) failed.push(`${context} (${latest.conclusion})`);
    } else if (status) {
      if (status.state === "success") continue;
      if (status.state === "pending") pending.push(context);
      else failed.push(`${context} (${status.state})`);
    } else {
      pending.push(context);
      unlisted.push(context);
    }
  }
  if (failed.length > 0) return { state: "red", failed, pending, unlisted };
  return { state: pending.length > 0 ? "pending" : "green", failed, pending, unlisted };
}

/** @param {string} command @param {string[]} args @param {string} cwd */
function defaultRunCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, shell: false });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
}

/**
 * Land `sha` on `defaultBranch` through a pull request from `branch`.
 *
 * `runCommand`, `sleep` and `now` are seams for the test; production uses the
 * defaults. `waitMs` bounds the wait for the required statuses to conclude,
 * measured from the first poll. A red required status refuses at once, naming
 * the pull request.
 *
 * @param {{
 *   cwd: string, repoSlug: string, remote: string, sha: string, branch: string,
 *   defaultBranch: string, title: string, body: string, waitMs: number, pollMs: number,
 *   runCommand?: (command: string, args: string[], cwd: string) => {status: number, stdout: string, stderr: string},
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, log?: (line: string) => void,
 * }} options
 * @returns {Promise<{prUrl: string, alreadyLanded: boolean}>}
 */
export async function landThroughPullRequest({
  cwd,
  repoSlug,
  remote,
  sha,
  branch,
  defaultBranch,
  title,
  body,
  waitMs,
  pollMs,
  runCommand = defaultRunCommand,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  now = () => Date.now(),
  log = (line) => console.log(line),
}) {
  // A full commit id only: an empty or partial one would turn the pushes below
  // into `:refs/heads/<branch>` — a branch DELETE.
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`land: "${sha}" is not a full commit id; nothing was pushed.`);
  const short = sha.slice(0, 12);
  const must = (command, args, what) => {
    const result = runCommand(command, args, cwd);
    if (result.status !== 0) {
      throw new Error(`land: ${what} failed — \`${command} ${args.join(" ")}\`: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result.stdout.trim();
  };
  /** A poll that tolerates transient GitHub faults within the consecutive-failure budget. */
  let consecutiveFailures = 0;
  const poll = async (args, what) => {
    for (;;) {
      const result = runCommand("gh", args, cwd);
      if (result.status === 0) {
        consecutiveFailures = 0;
        return JSON.parse(result.stdout || "null");
      }
      consecutiveFailures += 1;
      const message = result.stderr.trim() || result.stdout.trim();
      if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`land: ${what} failed ${consecutiveFailures} times in a row: ${message}`);
      }
      log(`[land] ${what} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_POLL_FAILURES} consecutive), retrying: ${message}`);
      await sleep(pollFailureBackoffMs(consecutiveFailures));
    }
  };

  // Already landed (a retry after the fast-forward succeeded and a later step
  // failed): the merged pull request and its deleted branch must not be
  // recreated — `gh pr create` would refuse a branch with no new commits.
  must("git", ["fetch", "--quiet", remote, defaultBranch], `the fetch of ${remote}/${defaultBranch}`);
  if (runCommand("git", ["merge-base", "--is-ancestor", sha, `refs/remotes/${remote}/${defaultBranch}`], cwd).status === 0) {
    log(`[land] ${short} is already on ${remote}/${defaultBranch}; nothing to land.`);
    return { prUrl: "", alreadyLanded: true };
  }

  log(`[land] pushing ${short} to ${remote}/${branch}`);
  must("git", ["push", remote, `${sha}:refs/heads/${branch}`], "the landing-branch push");

  const open = JSON.parse(
    must(
      "gh",
      ["pr", "list", "--repo", repoSlug, "--head", branch, "--base", defaultBranch, "--state", "open", "--json", "url"],
      "the pull request lookup",
    ) || "[]",
  );
  const prUrl =
    Array.isArray(open) && typeof open[0]?.url === "string"
      ? open[0].url
      : (must(
          "gh",
          ["pr", "create", "--repo", repoSlug, "--base", defaultBranch, "--head", branch, "--title", title, "--body", body],
          "the pull request creation",
        ).split(/\r?\n/).pop() ?? "");
  log(`[land] pull request: ${prUrl}`);

  // Only GitHub's own "Branch not protected" answer means no status is
  // required. Any other failure — a 404 for a token that may not read the
  // protection included — refuses, rather than guessing the branch is open.
  const protection = runCommand(
    "gh",
    ["api", `repos/${repoSlug}/branches/${defaultBranch}/protection/required_status_checks`],
    cwd,
  );
  let required = [];
  if (protection.status === 0) {
    required = requiredStatusChecks(JSON.parse(protection.stdout));
  } else if (!/Branch not protected/i.test(protection.stderr + protection.stdout)) {
    throw new Error(
      `land: cannot read the required status checks of ${defaultBranch}: ${(protection.stderr || protection.stdout).trim()}. ` +
        `Nothing reached ${defaultBranch}: ${prUrl}`,
    );
  }

  const start = now();
  let announced = false;
  for (;;) {
    const runs = await poll(["api", `repos/${repoSlug}/commits/${sha}/check-runs?per_page=100`], "the check-run query");
    const combined = await poll(["api", `repos/${repoSlug}/commits/${sha}/status`], "the commit-status query");
    const verdict = evaluateRequiredChecks(runs?.check_runs, combined?.statuses, required);
    if (verdict.state === "green") break;
    if (verdict.state === "red") {
      throw new Error(
        `land: required check(s) failed on ${short}: ${verdict.failed.join(", ")}. ` +
          `Nothing reached ${defaultBranch}. Fix it, then land again: ${prUrl}`,
      );
    }
    if (now() - start >= waitMs) {
      const never =
        verdict.unlisted.length > 0
          ? ` No run of ${verdict.unlisted.join(", ")} was ever listed for this commit: CI did not start ` +
            `(a workflow trigger that excludes this change, or a workflow that failed to queue).`
          : "";
      throw new Error(
        `land: required check(s) ${verdict.pending.join(", ")} did not conclude on ${short} within ` +
          `${Math.round(waitMs / 1000)}s.${never} Nothing reached ${defaultBranch}. Read the pull request, then land again: ${prUrl}`,
      );
    }
    if (!announced) {
      log(`[land] waiting for required check(s) ${verdict.pending.join(", ")} on ${short}`);
      announced = true;
    }
    await sleep(pollMs);
  }

  log(`[land] required checks green — fast-forwarding ${remote}/${defaultBranch} to ${short}`);
  const forwarded = runCommand("git", ["push", remote, `${sha}:refs/heads/${defaultBranch}`], cwd);
  if (forwarded.status !== 0) {
    throw new Error(
      `land: the fast-forward of ${defaultBranch} to ${short} was refused: ${(forwarded.stderr || forwarded.stdout).trim()}. ` +
        `If ${defaultBranch} moved past this commit's base, this commit can never fast-forward it: rebase it and ` +
        `land the new commit (a lap), or delete the local tag and bump commit and release again (a release). ${prUrl}`,
    );
  }
  return { prUrl, alreadyLanded: false };
}

/**
 * Delete a landing branch once GitHub reports its pull request merged.
 *
 * GitHub marks the pull request merged asynchronously after the push to its
 * base, and deleting the head branch before that can close it as unmerged. No
 * measurement bounds that delay, so the wait has no time limit (owner rule:
 * no limit from feel); only the consecutive-failure budget ends it. It never
 * throws: the commit already landed, and a branch left behind costs a stale
 * ref only, so every outcome is reported, not raised.
 *
 * @param {{
 *   cwd: string, repoSlug: string, remote: string, branch: string, prUrl: string, pollMs: number,
 *   runCommand?: (command: string, args: string[], cwd: string) => {status: number, stdout: string, stderr: string},
 *   sleep?: (ms: number) => Promise<void>, log?: (line: string) => void,
 * }} options
 * @returns {Promise<boolean>} true when the branch was deleted
 */
export async function deleteLandingBranch({
  cwd,
  repoSlug,
  remote,
  branch,
  prUrl,
  pollMs,
  runCommand = defaultRunCommand,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  log = (line) => console.log(line),
}) {
  let failures = 0;
  let announced = false;
  for (;;) {
    const view = runCommand("gh", ["pr", "view", prUrl, "--repo", repoSlug, "--json", "state"], cwd);
    if (view.status !== 0) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        log(`[land] could not read the state of ${prUrl} (${failures} failures in a row); ${remote}/${branch} was left in place.`);
        return false;
      }
      await sleep(pollFailureBackoffMs(failures));
      continue;
    }
    failures = 0;
    const state = JSON.parse(view.stdout || "null")?.state;
    if (state === "MERGED") break;
    if (state === "CLOSED") {
      log(`[land] ${prUrl} is closed without a merge; ${remote}/${branch} was left in place.`);
      return false;
    }
    if (!announced) {
      log(`[land] waiting for GitHub to mark ${prUrl} merged before deleting ${remote}/${branch}`);
      announced = true;
    }
    await sleep(pollMs);
  }
  const removed = runCommand("git", ["push", remote, "--delete", branch], cwd);
  if (removed.status !== 0) {
    log(`[land] could not delete ${remote}/${branch}: ${removed.stderr.trim()}`);
    return false;
  }
  return true;
}
