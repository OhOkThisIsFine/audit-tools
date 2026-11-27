#!/usr/bin/env node
// sites-pinned: tests/shared/packaged-smoke-single-pack.test.ts, tests/audit/publish-source-contract.test.ts
// The single pack behind both packaged smokes.
//
// Both packaged smokes install the SAME single audit-tools package, and packing it
// (prepack build + tar) is the slowest step of `verify:checks`. Packing it once per
// smoke doubled that step for zero extra coverage. The pack now has one owner: the
// `pack:smoke` gate step produces the tarball, and each smoke resolves through
// `resolveSmokeTarball`, reusing that artifact when it is still current and packing
// for itself when it is not — a standalone smoke run must never depend on gate order.
//
// Currency is decided mechanically, not by trusting the caller's ordering: the cached
// tarball is reused only while it is newer than every input that could change its
// contents. Those inputs are derived from config rather than a hand-kept list —
// package.json's `files` (what ships) plus tsconfig's `include` (what prepack rebuilds
// into dist/) — and directories are stat'd alongside files so a deletion invalidates
// too. Anything else forces a repack, so a reused tarball can never be a false green.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSpawn } from "./spawn-shell.mjs";
import { hashContent } from './primitives.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CACHE_MANIFEST = "pack-manifest.json";
// A fresh release-only directory pins one pack; neither smoke may repack it.
const RELEASE_PACK_DIR = "AUDIT_TOOLS_RELEASE_PACK_DIR";

/**
 * Per-checkout cache dir under the OS temp root — keyed by repo path so parallel
 * worktrees never trade tarballs, and outside the repo so the pack can never dirty
 * a tree the release gate requires clean.
 */
function cacheDirFor(repoRoot) {
  const key = hashContent(repoRoot, { length: 12 });
  return join(tmpdir(), `audit-tools-smoke-pack-${key}`);
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Roots whose contents decide whether a packed tarball is still current: everything
 * `files` ships, everything tsconfig's `include` compiles into dist/, and the two
 * config files themselves. Glob tails are trimmed to the literal prefix — walking the
 * whole subtree is strictly more conservative than matching the pattern.
 */
function inputRoots(repoRoot) {
  const pkg = readJsonOrNull(join(repoRoot, "package.json")) ?? {};
  const tsconfig = readJsonOrNull(join(repoRoot, "tsconfig.json")) ?? {};
  const patterns = [
    ...(Array.isArray(pkg.files) ? pkg.files : []),
    ...(Array.isArray(tsconfig.include) ? tsconfig.include : []),
    "package.json",
    "tsconfig.json",
  ];
  const roots = new Set();
  for (const pattern of patterns) {
    const literal = pattern.split(/[*?]/u)[0].replace(/[\\/]+$/u, "");
    if (literal.length > 0) roots.add(literal);
  }
  return [...roots].map((rel) => join(repoRoot, rel));
}

/** Newest mtime across an input root (files AND directories, so deletions count). */
function newestMtimeMs(root) {
  let newest = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    let stats;
    try {
      stats = statSync(current);
    } catch {
      continue; // An optional root (e.g. an unbuilt dist/) is simply not an input yet.
    }
    if (stats.mtimeMs > newest) newest = stats.mtimeMs;
    if (!stats.isDirectory()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      pending.push(join(current, entry.name));
    }
  }
  return newest;
}

function newestInputMtimeMs(repoRoot) {
  return inputRoots(repoRoot).reduce((newest, root) => Math.max(newest, newestMtimeMs(root)), 0);
}

/**
 * The cached entry, or null when there is nothing usable. Every field a consumer reads
 * is validated here — a half-written manifest or a version bump degrades to a repack,
 * never to a smoke that installs something it cannot describe.
 */
function readCachedPack(cacheDir, version) {
  const manifest = readJsonOrNull(join(cacheDir, CACHE_MANIFEST));
  if (
    !manifest ||
    manifest.version !== version ||
    typeof manifest.filename !== "string" ||
    manifest.metadata?.filename !== manifest.filename ||
    basename(manifest.filename) !== manifest.filename ||
    !Array.isArray(manifest.metadata?.files)
  ) {
    return null;
  }
  const tarballPath = join(cacheDir, manifest.filename);
  if (!existsSync(tarballPath)) return null;
  return { tarballPath, metadata: manifest.metadata };
}

/**
 * Drop tarballs the manifest no longer points at (a version bump leaves the old one
 * behind). Deliberately not a wipe of the cache dir: a concurrently running sibling
 * smoke may be installing from a tarball right now, and a same-version repack simply
 * overwrites the same filename with identical content.
 */
function pruneCache(cacheDir, keepFilename) {
  for (const entry of readdirSync(cacheDir)) {
    if (entry.endsWith(".tgz") && entry !== keepFilename) {
      rmSync(join(cacheDir, entry), { force: true });
    }
  }
}

// `npm publish --dry-run` leaks dry-run flags, registry overrides and auth tokens into
// child npm invocations; a smoke nested under it needs a REAL tarball, so strip the
// inherited npm_config_* overrides plus publish credentials and force dry-run back off.
function isolatedNpmEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.startsWith("npm_config_") ||
      normalizedKey === "node_auth_token" ||
      normalizedKey === "npm_token"
    ) {
      continue;
    }
    env[key] = value;
  }
  env.npm_config_dry_run = "false";
  env.NPM_CONFIG_DRY_RUN = "false";
  return env;
}

/**
 * `npm pack --json` prints its payload after any lifecycle-script output, so the
 * stdout is scanned for the first line that starts a parseable JSON value instead of
 * being fed to JSON.parse whole (prepack's build notices would break that).
 */
function parsePackJson(stdout) {
  const text = stdout.replace(/\r\n/gu, "\n");
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("[") || line.startsWith("{")) {
      try {
        return JSON.parse(text.slice(offset));
      } catch {
        // Not the payload start — keep scanning.
      }
    }
    offset += line.length + 1;
  }
  return null;
}

/**
 * Pack the package into `cacheDir`. Lifecycle scripts stay ENABLED on purpose: prepack
 * rebuilds dist/, so the tarball always matches current source even when the caller is
 * a standalone smoke run with no build step ahead of it.
 */
function packWithNpm({ repoRoot, cacheDir, requireScripts = false }) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["pack", "--json", "--pack-destination", cacheDir];
  if (requireScripts) args.push("--ignore-scripts=false");
  const resolved = resolveSpawn(npm, args);
  const result = spawnSync(resolved.command, resolved.args, /** @type {any} */ ({
    cwd: repoRoot,
    encoding: "utf8",
    env: isolatedNpmEnv(),
    windowsHide: true,
  }));
  if (result.status !== 0) {
    // prepack failures (tsc errors, the no-suite-running build guard) land on either
    // stream, so both are surfaced — a bare exit code is not a diagnosable gate failure.
    throw new Error(
      [
        `npm pack failed with exit code ${result.status}`,
        result.error?.message,
        (result.stderr ?? "").trim(),
        (result.stdout ?? "").trim().slice(-1000),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const payload = parsePackJson(result.stdout ?? "");
  // npm pack --json returns either an array (older npm) or an object (npm 12+).
  const entries = Array.isArray(payload) ? payload : Object.values(payload ?? {});
  const metadata = entries[0];
  if (entries.length !== 1 || !metadata || typeof metadata.filename !== "string") {
    throw new Error(
      `npm pack --json did not return exactly one tarball's metadata: ${(result.stdout ?? "").slice(0, 500)}`,
    );
  }
  return { tarballPath: join(cacheDir, metadata.filename), metadata };
}

/**
 * Resolve the tarball both packaged smokes install: the cached one while it is still
 * current, a freshly packed one otherwise.
 *
 * @param {{ repoRoot?: string, cacheDir?: string, pack?: (ctx: {repoRoot: string, cacheDir: string}) => {tarballPath: string, metadata: object} }} [options]
 *   `pack` is a test seam (defaults to the real `npm pack`) so the reuse rule is
 *   unit-testable without minutes of real packing.
 * @returns {{ tarballPath: string, metadata: object, packed: boolean }}
 */
export function resolveSmokeTarball(options = {}) {
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const cacheDir = options.cacheDir ?? cacheDirFor(repoRoot);
  const pack = options.pack ?? packWithNpm;
  const pkg = readJsonOrNull(join(repoRoot, "package.json"));
  const version = pkg?.version;
  // The version keys the cache entry; without one there is nothing to key on, and a
  // checkout whose package.json will not parse has a bigger problem than a stale pack.
  if (typeof version !== "string") {
    throw new Error(`no package version in ${join(repoRoot, "package.json")} — cannot key the smoke tarball`);
  }

  if (process.env[RELEASE_PACK_DIR]) {
    return { ...readReleasePack(process.env[RELEASE_PACK_DIR], pkg), packed: false };
  }

  return packOrReuse({ repoRoot, cacheDir, pack, version });
}

function readReleasePack(cacheDir, pkg) {
  const cached = readCachedPack(cacheDir, pkg.version);
  if (!cached || cached.metadata.name !== pkg.name || cached.metadata.version !== pkg.version) {
    throw new Error("Missing or mismatched release tarball; only pack:smoke may create it.");
  }
  const digest = createHash("sha512").update(readFileSync(cached.tarballPath)).digest("base64");
  if (cached.metadata.integrity !== `sha512-${digest}`) {
    throw new Error("Release tarball does not match the original npm pack integrity.");
  }
  return cached;
}

function packOrReuse({ repoRoot, cacheDir, pack, version }) {
  const cached = readCachedPack(cacheDir, version);
  if (cached && statSync(cached.tarballPath).mtimeMs > newestInputMtimeMs(repoRoot)) {
    return { ...cached, packed: false };
  }

  mkdirSync(cacheDir, { recursive: true });
  // Drop the manifest first: a pack that dies half-way must leave no pointer to a
  // partial tarball for the next consumer to install.
  rmSync(join(cacheDir, CACHE_MANIFEST), { force: true });
  const { tarballPath, metadata } = pack({ repoRoot, cacheDir });
  const filename = basename(tarballPath);
  writeFileSync(
    join(cacheDir, CACHE_MANIFEST),
    JSON.stringify({ version, filename, metadata }, null, 2) + "\n",
  );
  pruneCache(cacheDir, filename);
  return { tarballPath, metadata, packed: true };
}

function prepareReleasePack(cacheDir) {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
  if (existsSync(join(cacheDir, CACHE_MANIFEST))) {
    throw new Error("A release pack has already been prepared; use a fresh release pack directory.");
  }
  const result = packOrReuse({
    repoRoot: REPO_ROOT,
    cacheDir,
    pack: (ctx) => packWithNpm({ ...ctx, requireScripts: true }),
    version: pkg.version,
  });
  readReleasePack(cacheDir, pkg);
  return result;
}

// `pack:smoke` gate step: produce the tarball the smokes that follow will install.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const releaseDir = process.env[RELEASE_PACK_DIR];
    if (process.argv[2] === "--verify-release") {
      if (!releaseDir) throw new Error(`Set ${RELEASE_PACK_DIR} to verify the release tarball.`);
      // Output just the verified path for the workflow to upload and fingerprint.
      process.stdout.write(resolveSmokeTarball().tarballPath + "\n");
    } else {
      const result = releaseDir
        ? prepareReleasePack(releaseDir)
        : resolveSmokeTarball();
      process.stdout.write(`[pack:smoke] ${result.packed ? "packed" : "reused"} ${result.tarballPath}\n`);
    }
  } catch (error) {
    process.stderr.write(`[pack:smoke] ${/** @type {any} */ (error).message}\n`);
    process.exit(1);
  }
}
