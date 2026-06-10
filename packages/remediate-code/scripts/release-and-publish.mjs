#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const packageJsonPath = resolve(repoRoot, "package.json");
const TAG_PREFIX = "remediate-code-";
const allowedBumps = new Set(["patch", "minor", "major"]);
const bump = process.argv[2] ?? "patch";
const bumpOnly = process.argv.includes("--bump-only");
const dryRun = process.argv.includes("--dry-run");
const pollIntervalMs = 5_000;
// Heartbeat cadence for poll logging: with 5s polls, every 12th attempt is
// roughly one log line per minute in steady state.
const POLL_LOG_EVERY_N_ATTEMPTS = 12;
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

function getRemoteName() {
  const remotes = run("git", ["remote"], { capture: true }).stdout.trim().split(/\r?\n/);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length > 0 && remotes[0].length > 0) return remotes[0];
  throw new Error("No git remotes found.");
}

// Pure poll-log throttle: log the first attempt, any genuine status transition
// (normalized status/conclusion enum only), and an every-Nth-attempt heartbeat.
// Decision depends only on the arguments and POLL_LOG_EVERY_N_ATTEMPTS.
function shouldLogPollAttempt(attempt, statusKey, lastLoggedStatusKey) {
  if (attempt === 1) return true;
  if (statusKey !== lastLoggedStatusKey) return true;
  return attempt % POLL_LOG_EVERY_N_ATTEMPTS === 0;
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
    const detail = options.capture
      ? (result.stderr || result.stdout || "").trim()
      : "";
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
    throw new Error(
      `Failed to parse JSON from ${command} ${args.join(" ")}: ${result.stdout}`,
      { cause: error instanceof Error ? error : undefined },
    );
  }
}

function readPackageJson() {
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

function getRepoSlug() {
  const remoteName = getRemoteName();
  const remoteUrl = run("git", ["remote", "get-url", remoteName], {
    capture: true,
  }).stdout.trim();
  const httpsMatch = remoteUrl.match(
    /github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/,
  );
  if (!httpsMatch) {
    throw new Error(
      `Unable to determine GitHub repository from remote URL: ${remoteUrl}`,
    );
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
  const symref = spawnSync(
    "git",
    ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!symref.error && symref.status === 0) {
    return symref.stdout.trim().replace(new RegExp(`^refs/remotes/${remoteName}/`), "");
  }
  const lsRemote = spawnSync(
    "git",
    ["ls-remote", "--symref", remoteName, "HEAD"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (!lsRemote.error && lsRemote.status === 0) {
    const match = lsRemote.stdout.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
    if (match) return match[1];
  }
  return "main";
}

function ensureMainBranch() {
  const branch = run("git", ["branch", "--show-current"], {
    capture: true,
  }).stdout.trim();
  const defaultBranch = getDefaultBranch();
  if (branch !== defaultBranch) {
    throw new Error(
      `Release publishing expects the default branch ('${defaultBranch}'), but current branch is '${branch}'.`,
    );
  }
  const remoteName = getRemoteName();
  run("git", ["fetch", remoteName, defaultBranch]);
  const localHead = run("git", ["rev-parse", "HEAD"], {
    capture: true,
  }).stdout.trim();
  const remoteHead = run("git", ["rev-parse", `${remoteName}/${defaultBranch}`], {
    capture: true,
  }).stdout.trim();
  if (localHead !== remoteHead) {
    throw new Error(
      `Release publishing requires ${defaultBranch} to be synced with ${remoteName}/${defaultBranch}. Local ${localHead} != remote ${remoteHead}.`,
    );
  }
  return defaultBranch;
}

function bumpVersionAndTag(npm) {
  run(npm, ["version", bump, "--no-git-tag-version"]);

  const packageAfter = readPackageJson();
  const tag = `${TAG_PREFIX}v${packageAfter.version}`;

  run("git", ["add", "package.json", "package-lock.json", "../../package-lock.json"]);
  run("git", ["commit", "-m", `release: ${tag}`]);
  run("git", ["tag", "-a", tag, "-m", tag]);

  return { packageAfter, tag };
}

async function waitForReleaseRun(repoSlug, tag) {
  run("gh", ["workflow", "view", "publish-package.yml"]);
  const deadline = Date.now() + releaseRunTimeoutMs;
  const startMs = Date.now();
  let attempt = 0;
  let lastLoggedStatusKey = null;
  while (Date.now() < deadline) {
    attempt++;
    const response = runJson("gh", [
      "api",
      `repos/${repoSlug}/actions/workflows/publish-package.yml/runs?event=release&per_page=20`,
    ]);
    const match = response.workflow_runs?.find(
      (runEntry) =>
        runEntry?.head_branch === tag || runEntry?.display_title === tag,
    );
    if (match) {
      const elapsedSec = Math.round((Date.now() - startMs) / 1000);
      console.log(
        `[release] publish run for ${tag} found after ${elapsedSec}s (${attempt} ${attempt === 1 ? "attempt" : "attempts"}).`,
      );
      return match;
    }
    const statusKey = "pending";
    if (shouldLogPollAttempt(attempt, statusKey, lastLoggedStatusKey)) {
      const elapsedSec = Math.round((Date.now() - startMs) / 1000);
      console.log(
        `[release] waiting for publish-package release run for ${tag} (${elapsedSec}s elapsed, attempt ${attempt}); retrying in ${pollIntervalMs / 1000}s...`,
      );
      lastLoggedStatusKey = statusKey;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for publish-package release run for ${tag}.`,
  );
}

async function waitForRunCompletion(repoSlug, runId) {
  const deadline = Date.now() + releaseRunTimeoutMs;
  const startMs = Date.now();
  let attempt = 0;
  let lastLoggedStatusKey = null;
  while (Date.now() < deadline) {
    attempt++;
    const runEntry = runJson("gh", [
      "api",
      `repos/${repoSlug}/actions/runs/${runId}`,
    ]);
    if (runEntry.status === "completed") {
      const elapsedSec = Math.round((Date.now() - startMs) / 1000);
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
      const elapsedSec = Math.round((Date.now() - startMs) / 1000);
      console.log(
        `[release] publish run status: ${runEntry.status} (${elapsedSec}s elapsed, attempt ${attempt}); retrying in ${pollIntervalMs / 1000}s...`,
      );
      lastLoggedStatusKey = statusKey;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for publish workflow run ${runId} to complete.`,
  );
}

async function waitForRegistryVersion(packageName, version) {
  const deadline = Date.now() + registryTimeoutMs;
  const startMs = Date.now();
  let attempt = 0;
  let lastLoggedStatusKey = null;
  while (Date.now() < deadline) {
    attempt++;
    const resolved = resolveSpawn(commandName("npm"), [
      "view",
      `${packageName}@${version}`,
      "version",
    ]);
    const result = spawnSync(resolved.command, resolved.args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (!result.error && result.status === 0) {
      const elapsedSec = Math.round((Date.now() - startMs) / 1000);
      console.log(
        `[release] ${packageName}@${version} resolved from registry after ${elapsedSec}s (${attempt} ${attempt === 1 ? "attempt" : "attempts"}).`,
      );
      return result.stdout.trim();
    }
    const statusKey = "pending";
    if (shouldLogPollAttempt(attempt, statusKey, lastLoggedStatusKey)) {
      const elapsedSec = Math.round((Date.now() - startMs) / 1000);
      console.log(
        `[release] ${packageName}@${version} not yet in registry (${elapsedSec}s elapsed, attempt ${attempt}); retrying in ${pollIntervalMs / 1000}s...`,
      );
      lastLoggedStatusKey = statusKey;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for ${packageName}@${version} to resolve from the npm registry.`,
  );
}

async function main() {
  const npm = commandName("npm");
  const repoSlug = getRepoSlug();
  const packageBefore = readPackageJson();

  console.log(`[release] repository: ${repoSlug}`);
  console.log(
    `[release] package: ${packageBefore.name}@${packageBefore.version}`,
  );

  ensureCleanWorktree();
  const defaultBranch = ensureMainBranch();

  if (dryRun) {
    console.log(
      `[release] dry run: would ${bumpOnly ? "bump" : "verify, bump, tag, push, create a GitHub Release, and wait for npm publish"} for ${packageBefore.name}@${packageBefore.version} on ${defaultBranch}.`,
    );
    return;
  }

  if (bumpOnly) {
    // Bump the version and commit package.json / package-lock.json locally.
    // Do NOT create a git tag here — the tag is created (and pushed) during the
    // full release flow so that a dangling local tag can never conflict with a
    // subsequent run or a remote tag that was already pushed.
    console.log(
      `[release] bumping ${bump} version (local commit only, no tag)`,
    );
    run(npm, ["version", bump, "--no-git-tag-version"]);
    const packageAfter = readPackageJson();
    const newTag = `${TAG_PREFIX}v${packageAfter.version}`;
    run("git", ["add", "package.json", "package-lock.json", "../../package-lock.json"]);
    run("git", ["commit", "-m", `release: ${newTag}`]);
    console.log(
      `[release] bumped to ${packageAfter.name}@${packageAfter.version}. Run without --bump-only to tag and publish.`,
    );
    return;
  }

  // The monorepo orchestrator (scripts/release-changed.mjs) front-loads
  // verify:release for every changed package before publishing any of them, then
  // sets this flag so we don't repeat the slow gate. Default is to run it.
  if (process.env.AUDIT_TOOLS_RELEASE_GATE_VERIFIED === "1") {
    console.log("[release] release gate pre-verified by orchestrator; skipping verify:release");
  } else {
    console.log("[release] running release gate");
    run(npm, ["run", "verify:release"]);
  }

  console.log(`[release] bumping ${bump} version`);
  const { packageAfter, tag } = bumpVersionAndTag(npm);

  const remoteName = getRemoteName();

  console.log(`[release] pushing ${defaultBranch} (${tag})`);
  run("git", ["push", remoteName, defaultBranch]);

  console.log(`[release] pushing tag ${tag}`);
  run("git", ["push", remoteName, tag]);

  console.log(`[release] creating GitHub Release ${tag}`);
  try {
    run("gh", ["release", "create", tag, "--title", tag, "--generate-notes"]);
  } catch (err) {
    console.error(`[release] creating GitHub Release failed: ${err.message}`);
    console.log(`[release] rolling back remote tag ${tag}...`);
    try {
      run("git", ["push", remoteName, `:refs/tags/${tag}`]);
      console.log(`[release] remote tag ${tag} deleted.`);
    } catch (rollbackErr) {
      console.error(
        `[release] rollback failed — remote tag ${tag} may need manual deletion: ${rollbackErr.message}`,
      );
    }
    try {
      run("git", ["tag", "-d", tag]);
      console.log(`[release] local tag ${tag} deleted.`);
    } catch (rollbackErr) {
      console.error(
        `[release] rollback failed — local tag ${tag} may need manual deletion: ${rollbackErr.message}`,
      );
    }
    throw err;
  }

  console.log(`[release] waiting for publish-package release run for ${tag}`);
  const runEntry = await waitForReleaseRun(repoSlug, tag);
  console.log(`[release] publish run detected: ${runEntry.html_url}`);

  const completedRun = await waitForRunCompletion(repoSlug, runEntry.id);
  console.log(`[release] publish run completed: ${completedRun.html_url}`);

  console.log(
    `[release] waiting for ${packageAfter.name}@${packageAfter.version} on npm`,
  );
  await waitForRegistryVersion(packageAfter.name, packageAfter.version);

  console.log(
    `[release] published ${packageAfter.name}@${packageAfter.version} successfully.`,
  );
}

await main();
