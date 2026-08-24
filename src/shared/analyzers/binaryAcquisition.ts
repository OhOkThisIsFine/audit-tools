import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";
import { AUDIT_TOOLS_DIRNAME } from "../io/auditToolsPaths.js";
import { runTrackedAsync, type RunTrackedResult } from "../tooling/exec.js";

/**
 * Generic acquisition of a standalone mature analyzer BINARY (gitleaks,
 * trufflehog, …) that has no language package-manager runner. The own-vs-acquire
 * policy's "acquire the mature tool" half for tools shipped as release binaries.
 *
 * Resolution order (all degrade-to-unavailable, never throw):
 *   1. PATH        — the tool is already installed (`<tool> version` probes 0).
 *   2. cache       — a previously-downloaded pinned binary is present + executable.
 *   3. download    — fetch the pinned GitHub-release asset for THIS os/arch over
 *                    HTTPS, fetch that release's `checksums.txt`, SHA256-verify the
 *                    asset against it, extract via the system `tar`, cache, return.
 *
 * Security invariants: version is PINNED (reproducibility); the downloaded asset
 * is SHA256-verified against the official release checksums BEFORE it is extracted
 * or executed; the fetcher is injected so the engine is testable without network
 * and an absent network degrades cleanly. A checksum mismatch is fatal-to-this-tool
 * (returns `unavailable` with reason `checksum_mismatch`), never executed.
 *
 * The cache branch is held to the SAME bar as the download branch, on EVERY
 * resolution, in two layers that only work together:
 *  - LOCATION. The default cache root is per-user (`<homedir>/.audit-tools/bincache`,
 *    created 0o700 where modes are honoured), never the shared temp dir. The path is
 *    fully derivable from public pinned constants, so "a file exists there" is only
 *    meaningful when the directory is not writable by other local processes.
 *  - INTEGRITY. Each successful download records the executable's digest in a cache
 *    manifest beside it, and a cache hit is only a hit when the bytes still hash to
 *    that recorded digest. Anything else — no manifest, an unreadable manifest, a
 *    digest mismatch, or a version dir left behind by a failed extraction — is PURGED
 *    and re-acquired rather than executed.
 *
 * The manifest alone is NOT provenance: anyone who can write the cache dir can write a
 * self-consistent binary+manifest pair. It detects drift and partial writes; the
 * location layer is what makes writing the pair privileged in the first place. A
 * caller passing its own `cacheDir` owns that directory's permissions.
 */

/** Injected network fetch: returns the URL's bytes, or `null` when unavailable. */
export interface BinaryFetcher {
  (url: string): Promise<Uint8Array | null>;
}

/**
 * Injected command runner (probe PATH, run `tar`). THE async runner contract —
 * the same seam shape as the acquisition engine's {@link AcquisitionRunner} —
 * defaulting to the shared {@link runTrackedAsync}. There is no synchronous twin:
 * a synchronous `tar`/probe under a held file lock would block the event loop and
 * starve that lock's mtime heartbeat.
 */
export interface BinaryCommandRunner {
  (argv: string[], cwd: string): Promise<RunTrackedResult>;
}

/** Pinned, os/arch-aware description of one acquirable release binary. */
export interface BinarySpec {
  /** Executable name on PATH / inside the archive (e.g. "gitleaks"). */
  binaryName: string;
  /** Pinned release version, no leading `v` (e.g. "8.18.4"). */
  version: string;
  /** Probe argv proving an on-PATH install (e.g. ["gitleaks","version"]). */
  versionProbeArgs: string[];
  /** Asset filename for a platform/arch, or null when unsupported. */
  assetFor(platform: NodeJS.Platform, arch: string): string | null;
  /**
   * Checksums-file asset name (lists `<sha256>  <asset>` lines). Either a single
   * release-wide file (gitleaks/osv-scanner/actionlint), or — when a project
   * ships one checksum file PER asset (hadolint's `<asset>.sha256`, each holding
   * only that asset's `<sha256> *<asset>` line) — a function deriving the
   * checksum-file name from the asset being downloaded.
   */
  checksumsAsset: string | ((assetName: string) => string);
  /** `${releaseUrlBase}/${assetName}` is the download URL (asset + checksums). */
  releaseUrlForAsset(assetName: string): string;
  /**
   * Whether the release asset is an archive (.tar.gz/.zip) needing extraction
   * (the default, e.g. gitleaks), or the raw executable bytes themselves (e.g.
   * osv-scanner, whose release assets ARE the binary — `osv-scanner_linux_amd64`,
   * `osv-scanner_windows_amd64.exe`). When `false`, the verified bytes are
   * written directly to the cache as the executable — no `tar` invocation.
   */
  archived?: boolean;
}

export interface BinaryResolveOptions {
  fetch?: BinaryFetcher;
  run?: BinaryCommandRunner;
  /** Root cache dir for downloaded binaries; default `<homedir>/.audit-tools/bincache`. */
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/**
 * WHY a binary could not be resolved, as a machine-readable member rather than a
 * free-text note. `checksum_mismatch` is a supply-chain event and must never be
 * indistinguishable from `offline` in the persisted record.
 */
export type BinaryUnavailableReason =
  | "offline"
  | "no_asset_for_platform"
  | "download_failed"
  | "download_empty"
  | "no_checksum_for_asset"
  | "checksum_mismatch"
  | "extract_failed"
  | "not_found_in_archive"
  | "write_failed";

export interface BinaryResolution {
  status: "path" | "cached" | "downloaded" | "unavailable";
  /** Resolved executable (PATH name or absolute cached path); null when unavailable. */
  command: string | null;
  /** Discriminated cause when `status === "unavailable"`. */
  reason?: BinaryUnavailableReason;
  note?: string;
}

/**
 * Per-USER cache root, deliberately NOT the system temp dir. Defaults to
 * `~/.audit-tools/bincache`; `AUDIT_TOOLS_BINARY_CACHE` overrides it so a run can be
 * pinned to an isolated cache — the same override shape as
 * {@link analyzerCacheRoot}'s `AUDIT_TOOLS_ANALYZER_CACHE`, and what lets a test
 * exercise the DEFAULT path without ever writing to the real home directory.
 *
 * The digest manifest beside a cached binary proves the bytes match what the manifest
 * says — but an attacker who can write the cache dir writes BOTH, so a self-consistent
 * pair inside a world-writable location proves nothing. The manifest only has meaning
 * when the directory it lives in is not attacker-writable, which is what moving the
 * default root under the user's home buys. `cacheDir` remains overridable per call for
 * a caller that has its own private location.
 *
 * Consequence, deliberate: caches warmed under the old `<tmpdir>/audit-tools-bincache`
 * are simply never consulted again — the first resolution under the new root
 * re-downloads, or degrades to `unavailable` offline.
 */
function defaultCacheDir(): string {
  const override = process.env.AUDIT_TOOLS_BINARY_CACHE;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), AUDIT_TOOLS_DIRNAME, "bincache");
}

/**
 * Create the cache root restricted to its owner where the platform honours modes.
 * On win32 the mode is ignored (ACLs govern), and the per-user home root is the
 * protection there.
 *
 * ⚠ The mode applies AT CREATION ONLY. An existing directory keeps whatever mode it
 * already has — `mkdirSync` does not chmod one it did not create — so a root that was
 * created loosely by something else is not repaired here.
 */
function ensureCacheRoot(cacheDir: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  } catch {
    /* a later mkdir of the version dir surfaces any real failure */
  }
}

function exeName(binaryName: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
}

/** `unavailable` with its cause carried in BOTH forms — machine member + human note. */
function unavailable(
  reason: BinaryUnavailableReason,
  note: string,
): BinaryResolution {
  return { status: "unavailable", command: null, reason, note };
}

/**
 * Cache manifest filename. Written beside the cached executable at download time and
 * the ONLY evidence that these bytes came from a checksum-verified acquisition.
 */
const CACHE_MANIFEST_FILENAME = ".audit-tools-binary.json";

interface BinaryCacheManifest {
  binaryName: string;
  version: string;
  /** Executable location relative to the version dir (archives may nest it). */
  executable_relative_path: string;
  /** SHA256 of the CACHED EXECUTABLE's bytes (not the archive's). */
  executable_sha256: string;
}

/** Remove a cache version dir wholesale; best-effort, never throws. */
function purgeVersionDir(versionDir: string): void {
  try {
    rmSync(versionDir, { recursive: true, force: true });
  } catch {
    /* best-effort — a later resolution re-verifies regardless */
  }
}

function writeCacheManifest(
  versionDir: string,
  spec: BinarySpec,
  executablePath: string,
): void {
  try {
    const manifest: BinaryCacheManifest = {
      binaryName: spec.binaryName,
      version: spec.version,
      executable_relative_path: relative(versionDir, executablePath).replace(/\\/g, "/"),
      executable_sha256: sha256(readFileSync(executablePath)),
    };
    writeFileSync(
      join(versionDir, CACHE_MANIFEST_FILENAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
  } catch {
    /* An unwritable manifest simply means the next resolution re-downloads. */
  }
}

/**
 * The cached executable's path — but ONLY when its bytes still hash to the digest
 * recorded when it was acquired. A missing, unreadable, or mismatched manifest, an
 * escaping relative path, or drifted bytes all return null and the caller purges:
 * filename existence is never sufficient to execute.
 */
function verifiedCachedExecutable(
  versionDir: string,
  spec: BinarySpec,
): string | null {
  let manifest: BinaryCacheManifest;
  try {
    manifest = JSON.parse(
      readFileSync(join(versionDir, CACHE_MANIFEST_FILENAME), "utf8"),
    ) as BinaryCacheManifest;
  } catch {
    return null;
  }
  if (
    !manifest ||
    manifest.binaryName !== spec.binaryName ||
    manifest.version !== spec.version ||
    typeof manifest.executable_relative_path !== "string" ||
    manifest.executable_relative_path.length === 0 ||
    typeof manifest.executable_sha256 !== "string" ||
    manifest.executable_sha256.length !== 64
  ) {
    return null;
  }
  const executablePath = join(versionDir, manifest.executable_relative_path);
  const containment = relative(versionDir, executablePath);
  if (containment.startsWith("..") || isAbsolute(containment)) return null;
  try {
    if (sha256(readFileSync(executablePath)) !== manifest.executable_sha256.toLowerCase()) {
      return null;
    }
  } catch {
    return null;
  }
  return executablePath;
}

/** Parse a `<sha256>␠␠<asset>` checksums file for one asset's expected digest. */
export function expectedSha256For(
  checksumsText: string,
  assetName: string,
): string | null {
  for (const line of checksumsText.split(/\r?\n/)) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match && match[2].trim() === assetName) return match[1].toLowerCase();
  }
  return null;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Resolve an executable for `spec`, acquiring it if necessary. Async (download is
 * network I/O); never throws. The result's `command` is what the engine spawns,
 * or null when the tool could not be made available.
 */
export async function resolveBinary(
  spec: BinarySpec,
  options: BinaryResolveOptions = {},
): Promise<BinaryResolution> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const run = options.run ?? ((argv, cwd) => runTrackedAsync(argv, { cwd }));
  const cacheDir = options.cacheDir ?? defaultCacheDir();

  // 1. PATH — already installed. Nothing below this point runs, so a tool the machine
  // already has must not cause a cache directory to be created as a side effect.
  const probe = await run(spec.versionProbeArgs, process.cwd());
  if (!probe.error && probe.status === 0) {
    return { status: "path", command: spec.binaryName };
  }

  // 2. cache — a previously-downloaded pinned binary, RE-VERIFIED on every
  // resolution. The cache path is derivable from public pinned constants, so a
  // file at the expected name is a claim, not a proof: it is executed only when its
  // bytes still match the digest recorded at acquisition. Anything else — including
  // a version dir a failed extraction left behind — is purged and re-acquired.
  const versionDir = join(cacheDir, `${spec.binaryName}-${spec.version}`);
  if (existsSync(versionDir)) {
    const verified = verifiedCachedExecutable(versionDir, spec);
    if (verified) return { status: "cached", command: verified };
    // Unverifiable bytes, or a dir a failed extraction left behind: purge so nothing
    // half-written or pre-planted can become a later "cache hit".
    purgeVersionDir(versionDir);
  }

  // 3. download — pinned release asset, SHA256-verified, then extracted.
  const fetch = options.fetch;
  if (!fetch) {
    return unavailable("offline", "no fetcher configured (offline)");
  }
  const assetName = spec.assetFor(platform, arch);
  if (!assetName) {
    return unavailable(
      "no_asset_for_platform",
      `no release asset for ${platform}/${arch}`,
    );
  }

  let assetBytes: Uint8Array | null;
  let checksumsBytes: Uint8Array | null;
  try {
    const checksumsAssetName =
      typeof spec.checksumsAsset === "function"
        ? spec.checksumsAsset(assetName)
        : spec.checksumsAsset;
    checksumsBytes = await fetch(spec.releaseUrlForAsset(checksumsAssetName));
    assetBytes = await fetch(spec.releaseUrlForAsset(assetName));
  } catch (error) {
    return unavailable(
      "download_failed",
      `download failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!checksumsBytes || !assetBytes) {
    return unavailable("download_empty", "download returned no bytes");
  }

  const expected = expectedSha256For(
    Buffer.from(checksumsBytes).toString("utf8"),
    assetName,
  );
  if (!expected) {
    return unavailable("no_checksum_for_asset", `no checksum for ${assetName}`);
  }
  const actual = sha256(assetBytes);
  if (actual !== expected) {
    return unavailable(
      "checksum_mismatch",
      `checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`,
    );
  }

  // Only here — past the PATH probe, past a cache miss, past verification — is
  // anything about to be WRITTEN. Creating the root any earlier would grow an empty
  // cache directory on every resolution that never caches anything: a tool already on
  // PATH, an offline degrade, an unsupported platform. Read paths only ever ask
  // whether the directory exists.
  ensureCacheRoot(cacheDir);

  // Non-archived asset (e.g. osv-scanner): the verified bytes ARE the
  // executable — write directly to the cached path, no `tar` involved.
  if (spec.archived === false) {
    try {
      mkdirSync(versionDir, { recursive: true });
      const resolved = join(versionDir, exeName(spec.binaryName, platform));
      writeFileSync(resolved, assetBytes);
      if (platform !== "win32") {
        try {
          chmodSync(resolved, 0o755);
        } catch {
          /* best-effort */
        }
      }
      writeCacheManifest(versionDir, spec, resolved);
      return { status: "downloaded", command: resolved };
    } catch (error) {
      purgeVersionDir(versionDir);
      return unavailable(
        "write_failed",
        `write error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Verified — write the archive and extract it with the system `tar` (bsdtar
  // ships on win32 / darwin / linux and reads both .tar.gz and .zip).
  try {
    mkdirSync(versionDir, { recursive: true });
    const archivePath = join(versionDir, assetName);
    writeFileSync(archivePath, assetBytes);
    const extract = await run(["tar", "-xf", archivePath, "-C", versionDir], versionDir);
    rmSync(archivePath, { force: true });
    if (extract.error || extract.status !== 0) {
      // Whatever tar managed to write before failing must NOT survive as a cache hit.
      purgeVersionDir(versionDir);
      return unavailable(
        "extract_failed",
        `extract failed: ${extract.error?.message ?? `tar exit ${extract.status}`}`,
      );
    }
  } catch (error) {
    purgeVersionDir(versionDir);
    return unavailable(
      "extract_failed",
      `extract error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Locate the executable (archives may nest it); chmod +x on POSIX.
  const resolved = findExecutable(versionDir, exeName(spec.binaryName, platform));
  if (!resolved) {
    purgeVersionDir(versionDir);
    return unavailable("not_found_in_archive", "binary not found in archive");
  }
  if (platform !== "win32") {
    try {
      chmodSync(resolved, 0o755);
    } catch {
      /* best-effort */
    }
  }
  writeCacheManifest(versionDir, spec, resolved);
  return { status: "downloaded", command: resolved };
}

/** Shallow-then-recursive search for `name` under `dir`. */
function findExecutable(dir: string, name: string): string | null {
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      const nested = findExecutable(full, name);
      if (nested) return nested;
    }
  }
  return null;
}
