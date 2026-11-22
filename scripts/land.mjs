#!/usr/bin/env node
// sites-pinned: tests/shared/land-through-pull-request.test.ts
// `npm run land` — land this checkout's HEAD on the remote default branch.
//
// Branch protection binds admins (owner decision 2026-10-04), so a direct
// `git push <remote> HEAD:main` is refused: the commit carries no required
// status yet. This command runs the one landing protocol
// (`scripts/shared/landThroughPullRequest.mjs`): a pull request from a
// landing branch unique to HEAD, the required checks on that exact commit, then a
// fast-forward of the default branch to it.
//
// It refuses before any remote write when:
//   - the worktree has uncommitted changes (the landed commit would not be
//     what the suite ran on),
//   - HEAD does not descend from the remote default branch (not a fast-forward),
//   - HEAD already equals it (nothing to land), or
//   - no full-suite green stamp covers HEAD's tree — the same rule
//     `.claude/hooks/push-gate.mjs` applies to a direct push, which a push made
//     from inside this script would otherwise escape.
import { spawnSync } from "node:child_process";
import { guardArgv } from "./shared/argvGuard.mjs";
import { suiteQualificationVerdict } from "./shared/suiteGreenStamp.mjs";
import {
  CI_CONCLUSION_WAIT_MS,
  CI_POLL_MS,
  deleteLandingBranch,
  landThroughPullRequest,
} from "./shared/landThroughPullRequest.mjs";

const args = guardArgv(process.argv.slice(2), {
  name: "land",
  usage: 'npm run land -- [--title "<pull request title>"] [--body "<pull request body>"]',
  values: ["--title", "--body"],
});

/** @param {string[]} gitArgs */
function git(gitArgs) {
  const result = spawnSync("git", gitArgs, { encoding: "utf8", windowsHide: true });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

/** @param {string} message @returns {never} */
function refuse(message) {
  process.stderr.write(`land: ${message}\n`);
  process.exit(1);
}

const top = git(["rev-parse", "--show-toplevel"]);
if (!top.ok) refuse("not inside a git checkout.");
const root = top.out;

const remotes = git(["remote"]).out.split(/\r?\n/).filter(Boolean);
const remote = remotes.includes("origin") ? "origin" : remotes[0];
if (!remote) refuse("this checkout has no git remote.");
const url = git(["remote", "get-url", remote]).out;
const slug = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
if (!slug) refuse(`cannot read a GitHub repository from the remote URL ${url}.`);
const repoSlug = `${slug[1]}/${slug[2]}`;

const dirty = git(["status", "--porcelain"]);
if (!dirty.ok || dirty.out) refuse("the worktree has uncommitted changes; commit or remove them first.");

// Fetch need not refresh the cached remote HEAD. Bind the landing base to the
// server's advertised branch and commit instead of guessing from local refs.
const advertised = git(["ls-remote", "--symref", remote, "HEAD"]);
const head = advertised.ok && advertised.out.match(
  /^ref: refs\/heads\/([^\s]+)\tHEAD\r?\n([0-9a-f]{40}|[0-9a-f]{64})\tHEAD$/,
);
if (!head || !git(["check-ref-format", `refs/heads/${head[1]}`]).ok) {
  refuse(`could not verify the default branch of ${remote} from its advertised HEAD.`);
}
const [, defaultBranch, advertisedCommit] = head;

if (!git(["fetch", "--quiet", remote]).ok) refuse(`could not fetch ${remote}.`);
const fetched = git(["show-ref", "--verify", "--hash", `refs/remotes/${remote}/${defaultBranch}`]);
if (!fetched.ok || fetched.out !== advertisedCommit) {
  refuse(`${remote}/${defaultBranch} does not match its advertised HEAD after fetch; retry with an up-to-date fetch configuration.`);
}
const target = fetched.out;
const sha = git(["rev-parse", "HEAD"]).out;
if (sha === target) refuse(`HEAD already equals ${remote}/${defaultBranch}; nothing to land.`);
if (!git(["merge-base", "--is-ancestor", target, sha]).ok) {
  refuse(`HEAD does not descend from ${remote}/${defaultBranch}; rebase onto it, run the suite again, then land.`);
}

const tree = git(["rev-parse", "HEAD^{tree}"]).out;
const verdict = suiteQualificationVerdict(root, tree, { concernsBlock: true });
if (!verdict.ok) refuse(`${verdict.reason}. Run \`npm test\` on this exact tree, then land.`);

// A landing branch unique to this commit: a retry of the same commit reuses its
// branch and pull request, a rebased commit gets a fresh one (no forced push),
// and the checkout's own branch is never pushed or deleted by the landing.
const current = git(["branch", "--show-current"]).out || "detached HEAD";
const branch = `land/${sha.slice(0, 12)}`;
const commits = git(["log", "--format=%s", `${target}..${sha}`]).out.split(/\r?\n/).filter(Boolean);
const title = args.has("--title")
  ? String(args.get("--title"))
  : commits.length === 1
    ? commits[0]
    : `land: ${current} (${commits.length} commits)`;
const body = args.has("--body") ? String(args.get("--body")) : commits.map((subject) => `- ${subject}`).join("\n");

let landed;
try {
  landed = await landThroughPullRequest({
    cwd: root,
    repoSlug,
    remote,
    sha,
    branch,
    defaultBranch,
    title,
    body,
    waitMs: CI_CONCLUSION_WAIT_MS,
    pollMs: CI_POLL_MS,
  });
} catch (error) {
  refuse(error instanceof Error ? error.message.replace(/^land: /, "") : String(error));
}
console.log(`[land] ${sha.slice(0, 12)} is on ${remote}/${defaultBranch}${landed.prUrl ? ` (${landed.prUrl})` : ""}.`);
// The commit is on the default branch now; the cleanup reports and never fails it.
if (landed.prUrl) {
  await deleteLandingBranch({ cwd: root, repoSlug, remote, branch, prUrl: landed.prUrl, pollMs: CI_POLL_MS });
}
