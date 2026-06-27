import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTracked, type RunTrackedResult } from "audit-tools/shared";

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
 * (returns `unavailable`), never executed.
 */

/** Injected network fetch: returns the URL's bytes, or `null` when unavailable. */
export interface BinaryFetcher {
  (url: string): Promise<Uint8Array | null>;
}

/** Injected command runner (probe PATH, run `tar`); defaults to the shared runTracked. */
export interface BinaryCommandRunner {
  (argv: string[], cwd: string): RunTrackedResult;
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
  /** Checksums-file asset name (lists `<sha256>  <asset>` lines). */
  checksumsAsset: string;
  /** `${releaseUrlBase}/${assetName}` is the download URL (asset + checksums). */
  releaseUrlForAsset(assetName: string): string;
}

export interface BinaryResolveOptions {
  fetch?: BinaryFetcher;
  run?: BinaryCommandRunner;
  /** Root cache dir for downloaded binaries; default `<tmpdir>/audit-tools-bincache`. */
  cacheDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

export interface BinaryResolution {
  status: "path" | "cached" | "downloaded" | "unavailable";
  /** Resolved executable (PATH name or absolute cached path); null when unavailable. */
  command: string | null;
  note?: string;
}

function defaultCacheDir(): string {
  return join(tmpdir(), "audit-tools-bincache");
}

function exeName(binaryName: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
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
  const run = options.run ?? ((argv, cwd) => runTracked(argv, { cwd }));
  const cacheDir = options.cacheDir ?? defaultCacheDir();

  // 1. PATH — already installed.
  const probe = run(spec.versionProbeArgs, process.cwd());
  if (!probe.error && probe.status === 0) {
    return { status: "path", command: spec.binaryName };
  }

  // 2. cache — a previously-downloaded pinned binary.
  const versionDir = join(cacheDir, `${spec.binaryName}-${spec.version}`);
  const cachedPath = join(versionDir, exeName(spec.binaryName, platform));
  if (existsSync(cachedPath)) {
    return { status: "cached", command: cachedPath };
  }

  // 3. download — pinned release asset, SHA256-verified, then extracted.
  const fetch = options.fetch;
  if (!fetch) {
    return { status: "unavailable", command: null, note: "no fetcher configured (offline)" };
  }
  const assetName = spec.assetFor(platform, arch);
  if (!assetName) {
    return {
      status: "unavailable",
      command: null,
      note: `no release asset for ${platform}/${arch}`,
    };
  }

  let assetBytes: Uint8Array | null;
  let checksumsBytes: Uint8Array | null;
  try {
    checksumsBytes = await fetch(spec.releaseUrlForAsset(spec.checksumsAsset));
    assetBytes = await fetch(spec.releaseUrlForAsset(assetName));
  } catch (error) {
    return {
      status: "unavailable",
      command: null,
      note: `download failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!checksumsBytes || !assetBytes) {
    return { status: "unavailable", command: null, note: "download returned no bytes" };
  }

  const expected = expectedSha256For(
    Buffer.from(checksumsBytes).toString("utf8"),
    assetName,
  );
  if (!expected) {
    return { status: "unavailable", command: null, note: `no checksum for ${assetName}` };
  }
  const actual = sha256(assetBytes);
  if (actual !== expected) {
    return {
      status: "unavailable",
      command: null,
      note: `checksum mismatch for ${assetName} (expected ${expected}, got ${actual})`,
    };
  }

  // Verified — write the archive and extract it with the system `tar` (bsdtar
  // ships on win32 / darwin / linux and reads both .tar.gz and .zip).
  try {
    mkdirSync(versionDir, { recursive: true });
    const archivePath = join(versionDir, assetName);
    writeFileSync(archivePath, assetBytes);
    const extract = run(["tar", "-xf", archivePath, "-C", versionDir], versionDir);
    rmSync(archivePath, { force: true });
    if (extract.error || extract.status !== 0) {
      return {
        status: "unavailable",
        command: null,
        note: `extract failed: ${extract.error?.message ?? `tar exit ${extract.status}`}`,
      };
    }
  } catch (error) {
    return {
      status: "unavailable",
      command: null,
      note: `extract error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // Locate the executable (archives may nest it); chmod +x on POSIX.
  const resolved = findExecutable(versionDir, exeName(spec.binaryName, platform));
  if (!resolved) {
    return { status: "unavailable", command: null, note: "binary not found in archive" };
  }
  if (platform !== "win32") {
    try {
      chmodSync(resolved, 0o755);
    } catch {
      /* best-effort */
    }
  }
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
