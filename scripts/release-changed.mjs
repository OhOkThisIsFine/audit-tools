#!/usr/bin/env node

import { spawnSync } from "node:child_process";

// `internalDeps` lists the other workspaces (by label) this package depends on.
// The dependents are built, packed, and tested against the LOCAL shared
// workspace, so a shared change must cascade to them. Order matters: shared is
// listed first so build/gate/publish proceed in dependency order.
const packages = [
  {
    label: "shared",
    workspace: "@audit-tools/shared",
    packageName: "@audit-tools/shared",
    path: "packages/shared",
    tagPrefix: "shared-",
    internalDeps: [],
  },
  {
    label: "audit-code",
    workspace: "auditor-lambda",
    packageName: "auditor-lambda",
    path: "packages/audit-code",
    tagPrefix: "audit-code-",
    internalDeps: ["shared"],
  },
  {
    label: "remediate-code",
    workspace: "remediator-lambda",
    packageName: "remediator-lambda",
    path: "packages/remediate-code",
    tagPrefix: "remediate-code-",
    internalDeps: ["shared"],
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
    env: options.env ?? process.env,
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

// Escape RegExp metacharacters so a remote name containing one (e.g. a
// `+`/`*`/`(`/`[`) is matched literally rather than breaking the prefix-strip.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getDefaultBranch(remoteName) {
  const symref = maybeRun("git", ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`]);
  if (symref) return symref.replace(new RegExp(`^refs/remotes/${escapeRegExp(remoteName)}/`), "");

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
  return { remoteName, branch };
}

// Change detection and the per-package release scripts both operate on the local
// branch tip, and publishing pushes it. Fetch the branch itself (not just tags)
// and require local == remote so we never under-detect changes against a stale
// HEAD or silently publish unpushed local commits.
function ensureInSyncWithRemote(remoteName, branch) {
  run("git", ["fetch", remoteName, branch]);

  const localSha = output("git", ["rev-parse", "HEAD"]);
  const remoteSha = output("git", ["rev-parse", `${remoteName}/${branch}`]);
  if (localSha === remoteSha) return;

  // `--left-right` against `remote...local`: left count = behind, right = ahead.
  const counts = output("git", [
    "rev-list",
    "--left-right",
    "--count",
    `${remoteSha}...${localSha}`,
  ]);
  const [behind, ahead] = counts.split(/\s+/u).map(Number);
  throw new Error(
    `Local '${branch}' is out of sync with ${remoteName}/${branch} ` +
      `(${ahead} ahead, ${behind} behind). Release publishing pushes the current ` +
      `branch, so sync first: 'git pull --ff-only ${remoteName} ${branch}', and ` +
      `push or drop any local commits before releasing.`,
  );
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
let remoteName, branch;
if (!dryRun) {
  ({ remoteName, branch } = ensureDefaultBranch());
  ensureInSyncWithRemote(remoteName, branch);
}
fetchTags();

const changedLabels = new Set();
const reasons = new Map();

for (const pkg of packages) {
  const baseline = baselineTag(pkg);
  const hasChanges = changedSince(baseline.tag, pkg.path);

  console.log(
    `${pkg.label}: ${hasChanges ? "changed" : "unchanged"} since ${baseline.tag ?? "<none>"} (${baseline.source})`,
  );

  if (hasChanges) {
    changedLabels.add(pkg.label);
    reasons.set(pkg.label, "direct changes");
  }
}

// Cascade: a package must republish if any of its internal dependencies changed,
// because dependents are built/tested against the local shared workspace and pin
// it as "*". Iterate to a fixpoint so transitive dependencies cascade too.
let grew = true;
while (grew) {
  grew = false;
  for (const pkg of packages) {
    if (changedLabels.has(pkg.label)) continue;
    const changedDeps = pkg.internalDeps.filter((dep) => changedLabels.has(dep));
    if (changedDeps.length > 0) {
      changedLabels.add(pkg.label);
      reasons.set(pkg.label, `depends on changed: ${changedDeps.join(", ")}`);
      console.log(`${pkg.label}: included because ${changedDeps.join(", ")} changed`);
      grew = true;
    }
  }
}

// Preserve dependency order (shared first) for build, gate, and publish.
const changed = packages.filter((pkg) => changedLabels.has(pkg.label));

if (changed.length === 0) {
  console.log("No package changes detected. Nothing to publish.");
  process.exit(0);
}

console.log(
  `Packages selected for ${bump} publish: ${changed
    .map((pkg) => `${pkg.label} (${reasons.get(pkg.label)})`)
    .join(", ")}`,
);

if (dryRun) {
  console.log("Dry run only. No packages published.");
  process.exit(0);
}

const npm = commandName("npm");

// Build @audit-tools/shared up front. Every dependent typechecks against
// shared/dist and the packaged smoke test packs it from disk, so it must exist
// and be current even when shared itself is not part of this release.
console.log("Building @audit-tools/shared (dependents resolve types and pack from shared/dist)...");
run(npm, ["run", "build", "-w", "@audit-tools/shared"]);

// Front-load every gate before publishing anything. Releases are not atomic
// across packages — each publish pushes a tag and a GitHub Release that triggers
// CI — so verifying all changed packages first prevents a late failure from
// leaving an earlier package half-published.
const startTime = Date.now();
for (const pkg of changed) {
  console.log(`Pre-flight gate: ${pkg.label} (verify:release)...`);
  const t0 = Date.now();
  run(npm, ["--workspace", pkg.workspace, "run", "verify:release"]);
  console.log(`Pre-flight gate: ${pkg.label} done (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// Publish in dependency order. The gate already ran above, so tell each
// per-package release script to skip its internal verify:release rather than
// repeat the slow build + test + packaged-smoke pass.
const publishEnv = { ...process.env, AUDIT_TOOLS_RELEASE_GATE_VERIFIED: "1" };

// Re-check sync immediately before publishing to close the window between the
// initial fetch (above) and the actual publish calls. Any concurrent push that
// arrived during the gate phase will be detected here.
ensureInSyncWithRemote(remoteName, branch);

// The per-package publish (bump + commit + tag + push + GitHub Release) is NOT
// atomic across packages: a failure after the first leaves earlier packages
// published while later ones are not, and npm has no rollback. There is therefore
// no compensation step — the only safe recovery is *resume*. To make that
// resumable rather than a confusing dead end, report exactly which packages
// already published and which remain on failure, with the resume command, so a
// re-run continues from the failure point instead of starting over.
const published = [];
for (let i = 0; i < changed.length; i++) {
  const pkg = changed[i];
  console.log(`Publishing ${pkg.label} with ${bump} bump...`);
  try {
    run(npm, ["--workspace", pkg.workspace, "run", `release:${bump}:publish`], {
      env: publishEnv,
    });
  } catch (err) {
    const remaining = changed.slice(i).map((p) => p.label);
    console.error(
      `\nRelease is non-atomic and npm has no rollback. ${pkg.label} failed to publish.\n` +
        (published.length > 0
          ? `Already published this run (do NOT re-bump): ${published.join(", ")}.\n`
          : "No packages were published this run.\n") +
        `Not yet published: ${remaining.join(", ")}.\n` +
        `Resume: fix the cause, then 'git pull --ff-only ${remoteName} ${branch}' and re-run this command — ` +
        `change detection skips the already-published packages and continues with ${remaining.join(", ")}.`,
    );
    throw err;
  }
  published.push(pkg.label);
}
const elapsed = Math.round((Date.now() - startTime) / 1000);
console.log(`Release complete. ${changed.map(pkg => pkg.label).join(", ")} published in ${elapsed}s.`);
