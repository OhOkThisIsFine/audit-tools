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

async function waitForReleaseRun(repoSlug, tag) {
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
    const match = response.workflow_runs?.find(
      (runEntry) => runEntry?.head_branch === tag || runEntry?.display_title === tag,
    );
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
  throw new Error(`Timed out waiting for publish-package release run for ${tag}.`);
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
  const runEntry = await waitForReleaseRun(repoSlug, tag);
  console.log(`[release] publish run detected: ${runEntry.html_url}`);

  const completedRun = await waitForRunCompletion(repoSlug, runEntry.id);
  console.log(`[release] publish run completed: ${completedRun.html_url}`);

  console.log(`[release] waiting for ${packageAfter.name}@${packageAfter.version} on npm`);
  await waitForRegistryVersion(packageAfter.name, packageAfter.version);

  console.log(`[release] published ${packageAfter.name}@${packageAfter.version} successfully.`);
}

await main();
