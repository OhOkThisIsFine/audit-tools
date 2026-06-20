#!/usr/bin/env node
// Single-package release helper for `audit-tools`. Bumps the version, tags `vX.Y.Z`,
// pushes, creates a GitHub Release (which triggers the OIDC trusted-publishing
// workflow), then waits for the publish run + npm registry propagation.
//
// Usage: node scripts/release-and-publish.mjs <patch|minor|major> [--bump-only] [--dry-run]

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { shouldLogPollAttempt } from "./poll-log-throttle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const packageJsonPath = resolve(repoRoot, "package.json");
const allowedBumps = new Set(["patch", "minor", "major"]);
const bump = process.argv[2] ?? "patch";
const bumpOnly = process.argv.includes("--bump-only");
const dryRun = process.argv.includes("--dry-run");
// --no-wait: tag + push + create the Release, then return WITHOUT blocking on the
// publish CI run + npm propagation (~minutes). CI still publishes asynchronously;
// confirm with `npm view audit-tools version` before reinstalling the global bin.
const noWait = process.argv.includes("--no-wait");
const pollIntervalMs = 5_000;
const releaseRunTimeoutMs = 10 * 60 * 1000;
const registryTimeoutMs = 2 * 60 * 1000;

if (!allowedBumps.has(bump)) {
  console.error(
    `Unsupported release bump '${bump}'. Expected one of: ${Array.from(allowedBumps).join(", ")}.`,
  );
  process.exit(1);
}

function commandName(name) {
  return process.platform === "win32" ? `${name}.cmd` : name;
}

function getRemoteName() {
  const remotes = run("git", ["remote"], { capture: true }).stdout.trim().split(/\r?\n/);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length > 0 && remotes[0].length > 0) return remotes[0];
  throw new Error("No git remotes found.");
}

function quoteForCmd(arg) {
  if (arg.length === 0) return '""';
  if (!/[\s"]/u.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function resolveSpawn(command, args) {
  if (!(process.platform === "win32" && /\.(cmd|bat)$/i.test(command))) {
    return { command, args };
  }
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", [command, ...args].map(quoteForCmd).join(" ")],
  };
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function run(command, args, options = {}) {
  const resolved = resolveSpawn(command, args);
  const result = spawnSync(resolved.command, resolved.args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(
      detail.length > 0
        ? `${command} ${args.join(" ")} failed: ${detail}`
        : `${command} ${args.join(" ")} failed with exit code ${result.status}.`,
    );
  }
  return result;
}

function runJson(command, args) {
  const result = run(command, args, { capture: true });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Failed to parse JSON from ${command} ${args.join(" ")}: ${result.stdout}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }
}

function readPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function getRepoSlug() {
  const remoteName = getRemoteName();
  const remoteUrl = run("git", ["remote", "get-url", remoteName], { capture: true }).stdout.trim();
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
  if (!httpsMatch) {
    throw new Error(`Unable to determine GitHub repository from remote URL: ${remoteUrl}`);
  }
  return `${httpsMatch[1]}/${httpsMatch[2]}`;
}

function ensureCleanWorktree() {
  const status = run("git", ["status", "--porcelain", "--ignore-submodules=all"], {
    capture: true,
  }).stdout.trim();
  if (status.length > 0) {
    throw new Error(
      "Release publishing requires a clean git worktree. Commit, stash, or discard local changes first.",
    );
  }
}

function getDefaultBranch() {
  const remoteName = getRemoteName();
  const symref = spawnSync("git", ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!symref.error && symref.status === 0) {
    return symref.stdout.trim().replace(new RegExp(`^refs/remotes/${remoteName}/`), "");
  }
  const lsRemote = spawnSync("git", ["ls-remote", "--symref", remoteName, "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!lsRemote.error && lsRemote.status === 0) {
    const match = lsRemote.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
    if (match) return match[1];
  }
  return "main";
}

function ensureMainBranch() {
  const branch = run("git", ["branch", "--show-current"], { capture: true }).stdout.trim();
  const defaultBranch = getDefaultBranch();
  if (branch !== defaultBranch) {
    throw new Error(
      `Release publishing expects the default branch ('${defaultBranch}'), but current branch is '${branch}'.`,
    );
  }
  return branch;
}

function bumpVersionAndTag(npm) {
  run(npm, ["version", bump, "--no-git-tag-version"]);
  const packageAfter = readPackageJson();
  const tag = `v${packageAfter.version}`;

  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", `release: ${tag}`]);
  run("git", ["tag", "-a", tag, "-m", tag]);

  return { packageAfter, tag };
}

// Skew tolerance (ms) applied to the created_at > tagPushedAtMs fallback gate:
// a genuine run can be stamped a few seconds before the local push instant
// (clock skew, run row created as the push lands), so allow a small grace.
const RELEASE_RUN_SKEW_MS = 5_000;

// Pure, deterministic run selector. Given the raw list of workflow runs and the
// tag identity (name + push timestamp + tag-commit SHA), returns the matching
// run object or null. Independent of input array order.
//
// Selection rules:
//   1. Identity gate — only runs whose head_branch===tag OR display_title===tag.
//   2. Prefer head_sha===headSha (the tag commit). Among those, newest by
//      created_at, tiebreak greatest run_number then id.
//   3. If headSha is absent or nothing matches by SHA, fall back to runs whose
//      created_at is strictly after (tagPushedAtMs - skew), newest first.
//   4. Never return a run by array position / name alone — return null if
//      nothing qualifies the identity + freshness gate.
export function selectReleaseRun(runs, { tag, tagPushedAtMs, headSha } = {}) {
  if (!Array.isArray(runs)) return null;

  const sameTag = runs.filter(
    (runEntry) =>
      runEntry != null &&
      (runEntry.head_branch === tag || runEntry.display_title === tag),
  );
  if (sameTag.length === 0) return null;

  const createdAtMs = (runEntry) => {
    const parsed = Date.parse(runEntry?.created_at ?? "");
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  const newerFirst = (a, b) => {
    const byCreated = createdAtMs(b) - createdAtMs(a);
    if (byCreated !== 0) return byCreated;
    const byRunNumber = (b.run_number ?? 0) - (a.run_number ?? 0);
    if (byRunNumber !== 0) return byRunNumber;
    return (b.id ?? 0) - (a.id ?? 0);
  };

  if (headSha != null) {
    const bySha = sameTag.filter((runEntry) => runEntry.head_sha === headSha);
    if (bySha.length > 0) {
      return [...bySha].sort(newerFirst)[0];
    }
  }

  const threshold =
    typeof tagPushedAtMs === "number" && Number.isFinite(tagPushedAtMs)
      ? tagPushedAtMs - RELEASE_RUN_SKEW_MS
      : Number.NEGATIVE_INFINITY;
  const fresh = sameTag.filter((runEntry) => createdAtMs(runEntry) > threshold);
  if (fresh.length === 0) return null;
  return [...fresh].sort(newerFirst)[0];
}

async function waitForReleaseRun(repoSlug, tag, { tagPushedAtMs, headSha } = {}) {
  run("gh", ["workflow", "view", "publish-package.yml"]);
  const deadline = Date.now() + releaseRunTimeoutMs;
  const startedAt = Date.now();
  let attempt = 0;
  let lastLoggedStatusKey = null;
  while (Date.now() < deadline) {
    attempt += 1;
    const response = runJson("gh", [
      "api",
      `repos/${repoSlug}/actions/workflows/publish-package.yml/runs?event=release&per_page=20`,
    ]);
    const match = selectReleaseRun(response.workflow_runs, {
      tag,
      tagPushedAtMs,
      headSha,
    });
    if (match) {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `[release] publish run for ${tag} found after ${elapsedSec}s (${attempt} ${attempt === 1 ? "attempt" : "attempts"}).`,
      );
      return match;
    }
    const statusKey = "pending";
    if (shouldLogPollAttempt(attempt, statusKey, lastLoggedStatusKey)) {
      console.log(
        `[release] waiting for publish run ${tag}: attempt ${attempt}, elapsed ${Date.now() - startedAt}ms`,
      );
      lastLoggedStatusKey = statusKey;
    }
    await sleep(pollIntervalMs);
  }
  const pushedAtIso =
    typeof tagPushedAtMs === "number" && Number.isFinite(tagPushedAtMs)
      ? new Date(tagPushedAtMs).toISOString()
      : "unknown";
  throw new Error(
    `Timed out waiting for publish-package release run for ${tag} ` +
      `(tag pushed at ${pushedAtIso}; no run matched by SHA or post-push timestamp — ` +
      `refusing to match a stale same-name run).`,
  );
}

async function waitForRunCompletion(repoSlug, runId) {
  const deadline = Date.now() + releaseRunTimeoutMs;
  const startedAt = Date.now();
  let attempt = 0;
  let lastLoggedStatusKey = null;
  while (Date.now() < deadline) {
    attempt += 1;
    const runEntry = runJson("gh", ["api", `repos/${repoSlug}/actions/runs/${runId}`]);
    if (runEntry.status === "completed") {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      if (runEntry.conclusion !== "success") {
        throw new Error(
          `Publish workflow failed with conclusion '${runEntry.conclusion}'. Inspect ${runEntry.html_url}.`,
        );
      }
      console.log(
        `[release] publish run completed after ${elapsedSec}s (${attempt} ${attempt === 1 ? "attempt" : "attempts"}).`,
      );
      return runEntry;
    }
    const statusKey = `${runEntry.status ?? "unknown"}/${runEntry.conclusion ?? "pending"}`;
    if (shouldLogPollAttempt(attempt, statusKey, lastLoggedStatusKey)) {
      console.log(
        `[release] publish run ${runEntry.html_url ?? runId}: attempt ${attempt}, elapsed ${Date.now() - startedAt}ms, status ${runEntry.status ?? "unknown"}, conclusion ${runEntry.conclusion ?? "pending"}`,
      );
      lastLoggedStatusKey = statusKey;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for publish workflow run ${runId} to complete.`);
}

async function waitForRegistryVersion(packageName, version) {
  const deadline = Date.now() + registryTimeoutMs;
  const startedAt = Date.now();
  let attempt = 0;
  let lastResult = "not checked";
  let lastLoggedStatusKey = null;
  while (Date.now() < deadline) {
    attempt += 1;
    const resolved = resolveSpawn(commandName("npm"), ["view", `${packageName}@${version}`, "version"]);
    const result = spawnSync(resolved.command, resolved.args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!result.error && result.status === 0) {
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `[release] ${packageName}@${version} resolved from registry after ${elapsedSec}s (${attempt} ${attempt === 1 ? "attempt" : "attempts"}).`,
      );
      return result.stdout.trim();
    }
    lastResult = result.error
      ? result.error.message
      : (result.stderr || result.stdout || `exit ${result.status}`).trim();
    const statusKey = "pending";
    if (shouldLogPollAttempt(attempt, statusKey, lastLoggedStatusKey)) {
      console.log(
        `[release] waiting for npm registry ${packageName}@${version}: attempt ${attempt}, elapsed ${Date.now() - startedAt}ms, last result: ${lastResult.slice(0, 200)}`,
      );
      lastLoggedStatusKey = statusKey;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${packageName}@${version} to resolve from the npm registry.`);
}

async function main() {
  const npm = commandName("npm");
  const repoSlug = getRepoSlug();
  const packageBefore = readPackageJson();

  console.log(`[release] repository: ${repoSlug}`);
  console.log(`[release] package: ${packageBefore.name}@${packageBefore.version}`);

  if (dryRun) {
    console.log(`[release] --dry-run: would bump ${bump}, tag v<next>, push, GitHub Release, await publish.`);
    return;
  }

  ensureCleanWorktree();
  const releaseBranch = bumpOnly ? null : ensureMainBranch();

  if (bumpOnly) {
    console.log(`[release] bumping ${bump} version`);
    const { packageAfter, tag } = bumpVersionAndTag(npm);
    console.log(`[release] created ${tag} for ${packageAfter.name}@${packageAfter.version}.`);
    return;
  }

  // Local pre-tag gate is a fast typecheck only — the authoritative full-suite
  // gate (check + test + smokes) runs on Linux in publish-package.yml before the
  // upload, and the /ship preflight already ran it locally. Re-running the whole
  // verify:release here a third time only delayed the tag.
  console.log("[release] running local pre-tag gate (check)");
  run(npm, ["run", "check"]);

  console.log(`[release] bumping ${bump} version`);
  const { packageAfter, tag } = bumpVersionAndTag(npm);
  const remoteName = getRemoteName();

  console.log(`[release] pushing ${releaseBranch} (${tag})`);
  run("git", ["push", remoteName, releaseBranch]);

  // Resolve the tag commit SHA so the publish-run waiter can key on run identity
  // (head_sha) rather than the reusable display name. Degrade to timestamp-only
  // selection if rev-parse fails.
  let headSha = null;
  try {
    headSha = run("git", ["rev-parse", `${tag}^{commit}`], { capture: true }).stdout.trim() || null;
  } catch (error) {
    console.log(
      `[release] could not resolve tag commit SHA for ${tag}; falling back to timestamp-only ` +
        `run selection (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  // Capture the push instant immediately BEFORE pushing the tag: any genuine
  // publish run is created at or after this moment, so it gates out stale
  // same-name runs from an earlier reverted release of the same version.
  const tagPushedAtMs = Date.now();
  console.log(`[release] pushing tag ${tag}`);
  run("git", ["push", remoteName, tag]);

  console.log(`[release] creating GitHub Release ${tag}`);
  run("gh", ["release", "create", tag, "--title", tag, "--generate-notes"]);

  if (noWait) {
    console.log(
      `[release] --no-wait: GitHub Release ${tag} created; publish-package CI will publish ` +
        `${packageAfter.name}@${packageAfter.version} asynchronously. ` +
        `Confirm with: npm view ${packageAfter.name} version`,
    );
    return;
  }

  console.log(`[release] waiting for publish-package release run for ${tag}`);
  const runEntry = await waitForReleaseRun(repoSlug, tag, { tagPushedAtMs, headSha });
  console.log(`[release] publish run detected: ${runEntry.html_url}`);

  const completedRun = await waitForRunCompletion(repoSlug, runEntry.id);
  console.log(`[release] publish run completed: ${completedRun.html_url}`);

  console.log(`[release] waiting for ${packageAfter.name}@${packageAfter.version} on npm`);
  await waitForRegistryVersion(packageAfter.name, packageAfter.version);

  console.log(`[release] published ${packageAfter.name}@${packageAfter.version} successfully.`);
}

// Only run the release flow when invoked directly as the entry script. Importing
// this module (e.g. unit-testing the pure `selectReleaseRun`) must not execute
// `main()` — which would push/tag/publish.
const invokedDirectly =
  process.argv[1] != null &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await main();
}
