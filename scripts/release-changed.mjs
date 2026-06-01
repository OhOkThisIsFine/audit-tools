#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const packages = [
  {
    label: "shared",
    workspace: "@audit-tools/shared",
    packageName: "@audit-tools/shared",
    path: "packages/shared",
    tagPrefix: "shared-",
  },
  {
    label: "audit-code",
    workspace: "auditor-lambda",
    packageName: "auditor-lambda",
    path: "packages/audit-code",
    tagPrefix: "audit-code-",
  },
  {
    label: "remediate-code",
    workspace: "remediator-lambda",
    packageName: "remediator-lambda",
    path: "packages/remediate-code",
    tagPrefix: "remediate-code-",
  },
];

const allowedBumps = new Set(["patch", "minor", "major"]);
let bump = "patch";
let dryRun = false;

for (const arg of process.argv.slice(2)) {
  if (arg === "--dry-run") {
    dryRun = true;
  } else if (arg.startsWith("--bump=")) {
    bump = arg.slice("--bump=".length);
  } else if (allowedBumps.has(arg)) {
    bump = arg;
  } else {
    throw new Error(`Unknown argument: ${arg}`);
  }
}

if (!allowedBumps.has(bump)) {
  throw new Error(`Unsupported bump '${bump}'. Use patch, minor, or major.`);
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

function spawn(command, args, options = {}) {
  const resolved = resolveSpawn(command, args);
  return spawnSync(resolved.command, resolved.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function run(command, args, options = {}) {
  const result = spawn(command, args, options);

  if (result.error) throw result.error;

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

function maybeRun(command, args) {
  const result = spawn(command, args, { capture: true });
  return !result.error && result.status === 0 ? result.stdout.trim() : null;
}

function output(command, args) {
  return run(command, args, { capture: true }).stdout.trim();
}

function ensureCleanWorktree() {
  const status = output("git", ["status", "--porcelain", "--ignore-submodules=all"]);
  if (status.length > 0) {
    throw new Error("Release requires a clean worktree. Commit, stash, or discard changes first.");
  }
}

function getRemoteName() {
  const remotes = output("git", ["remote"]).split(/\r?\n/).filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length > 0) return remotes[0];
  throw new Error("No git remotes found.");
}

function getDefaultBranch(remoteName) {
  const symref = maybeRun("git", ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`]);
  if (symref) return symref.replace(new RegExp(`^refs/remotes/${remoteName}/`), "");

  const lsRemote = maybeRun("git", ["ls-remote", "--symref", remoteName, "HEAD"]);
  const match = lsRemote?.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
  if (match) return match[1];

  return "main";
}

function ensureDefaultBranch() {
  const remoteName = getRemoteName();
  const branch = output("git", ["branch", "--show-current"]);
  const defaultBranch = getDefaultBranch(remoteName);
  if (branch !== defaultBranch) {
    throw new Error(`Release publishing expects the default branch ('${defaultBranch}'), but current branch is '${branch}'.`);
  }
}

function fetchTags() {
  run("git", ["fetch", getRemoteName(), "--tags", "--force"]);
}

function tagExists(tag) {
  return maybeRun("git", ["rev-parse", "--verify", `refs/tags/${tag}`]) !== null;
}

function latestTagByPattern(pattern) {
  const tags = output("git", ["tag", "--list", pattern, "--sort=-v:refname"])
    .split(/\r?\n/)
    .filter(Boolean);

  return tags[0] ?? null;
}

function publishedVersion(packageName) {
  const npm = commandName("npm");
  const version = maybeRun(npm, ["view", packageName, "version"]);
  return version && version.length > 0 ? version : null;
}

function baselineTag(pkg) {
  const version = publishedVersion(pkg.packageName);
  if (version) {
    const tag = `${pkg.tagPrefix}v${version}`;
    if (tagExists(tag)) return { tag, source: `npm ${pkg.packageName}@${version}` };
    console.warn(`${pkg.label}: published npm version ${version} exists, but tag ${tag} was not found.`);
  }

  const fallbackTag = latestTagByPattern(`${pkg.tagPrefix}v*`);
  if (fallbackTag) return { tag: fallbackTag, source: "latest matching git tag" };

  return { tag: null, source: "no previous publish tag" };
}

function changedSince(tag, path) {
  if (tag === null) return true;

  const changedFiles = output("git", [
    "diff",
    "--name-only",
    `${tag}..HEAD`,
    "--",
    path,
  ]);

  return changedFiles.length > 0;
}

ensureCleanWorktree();
if (!dryRun) ensureDefaultBranch();
fetchTags();

const changed = [];

for (const pkg of packages) {
  const baseline = baselineTag(pkg);
  const hasChanges = changedSince(baseline.tag, pkg.path);

  console.log(
    `${pkg.label}: ${hasChanges ? "changed" : "unchanged"} since ${baseline.tag ?? "<none>"} (${baseline.source})`,
  );

  if (hasChanges) changed.push(pkg);
}

if (changed.length === 0) {
  console.log("No package changes detected. Nothing to publish.");
  process.exit(0);
}

console.log(`Packages selected for ${bump} publish: ${changed.map((pkg) => pkg.label).join(", ")}`);

if (dryRun) {
  console.log("Dry run only. No packages published.");
  process.exit(0);
}

const npm = commandName("npm");

for (const pkg of changed) {
  console.log(`Publishing ${pkg.label} with ${bump} bump...`);
  run(npm, ["--workspace", pkg.workspace, "run", `release:${bump}:publish`]);
}
