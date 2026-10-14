// sites-pinned: tests/shared/binary-acquisition.test.ts, tests/shared/binary-acquisition-contract.test.ts, tests/shared/binary-acquisition-process.test.ts, tests/shared/analyzer-default-runner-deadline.test.ts
import { hashContent } from "../hash.js";
import {
  chmodSync,
  accessSync,
  constants,
  lstatSync,
  mkdtempSync,
  renameSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,

  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { AUDIT_TOOLS_DIRNAME } from "../io/auditToolsPaths.js";
import { withFileLock, FileLockTimeoutError } from "../io/fileLock.js";
import {
  resolveSpawnDeadline,
  resolveExecutableFile,
  type ExecutableLookupOptions,
  runTrackedAsync,
  TRACKED_CHILD_DEADLINE_MS,
  type RunTrackedResult,
  type SpawnDeadline,
} from "../tooling/exec.js";

/**
 * Pinned binary acquisition: exact PATH identity, read-only v2 warm verification,
 * then cooperative identity-locked checksum download and atomic publication.
 * Private cache storage and authenticated upstream archive topology are trusted:
 * digest manifests detect drift, not a writer able to replace both manifest and
 * executable. Post-extraction admission is not a tar sandbox. Legacy caches and
 * crash-orphaned staging siblings are ignored, never scavenged.
 *
 * Deadlines bound admission/cancellation, not synchronous filesystem/hash work.
 * The shared heartbeat lock supplies cooperative single-flight while fresh; it
 * does not fence a holder after token replacement or prolonged event-loop stalls.
 */

/** Injected network fetch: returns the URL's bytes, or `null` when unavailable. */
export interface BinaryFetcher {
  (url: string, signal?: AbortSignal): Promise<Uint8Array | null>;
}

/**
 * Injected command runner (probe PATH, run `tar`). THE async runner contract —
 * the same seam shape as the acquisition engine's {@link AcquisitionRunner} —
 * defaulting to the shared {@link runTrackedAsync}. There is no synchronous twin:
 * a synchronous `tar`/probe under a held file lock would block the event loop and
 * starve that lock's mtime heartbeat.
 */
export interface BinaryCommandRunner {
  /**
   * `timeoutMs` is the RESOLVED bound for this spawn — the smaller of this
   * layer's own cap and the caller's remaining budget, computed by
   * {@link resolveSpawnDeadline} at the call site. It is a resolved duration
   * rather than a {@link SpawnDeadline} because an injected runner (the test
   * doubles) spawns nothing; only the default runner consumes it.
   */
  (argv: string[], cwd: string, timeoutMs: number): Promise<RunTrackedResult>;
}

/** Pinned, os/arch-aware description of one acquirable release binary. */
export interface BinarySpec {
  /** Executable name on PATH / inside the archive (e.g. "gitleaks"). */
  binaryName: string;
  /** Pinned release version, no leading `v` (e.g. "8.18.4"). */
  version: string;
  /** Probe argv proving an on-PATH install (e.g. ["gitleaks","version"]). */
  versionProbeArgs: string[];
  /** Exact stdout identity grammar; absent means PATH cannot be admitted. */
  parseVersion?: (stdout: string) => string | null;
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
  /** Hermetic absolute executable lookup seam. */
  resolveExecutable?: (name: string, options: ExecutableLookupOptions) => string | null;
  run?: BinaryCommandRunner;
  /**
   * The caller's own remaining budget, as an absolute instant. Folded into both
   * spawns this module issues (the version probe and `tar`) as
   * `min(TRACKED_CHILD_DEADLINE_MS, caller remaining)`, so a cold download that
   * outlives its caller is bounded by the caller, not by this layer's own cap.
   */
  deadline?: SpawnDeadline;
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
  | "deadline_exceeded"
  | "invalid_budget"
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
  /** Resolved executable (absolute PATH or cached path); null when unavailable. */
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
export function defaultCacheDir(): string {
  const override = process.env.AUDIT_TOOLS_BINARY_CACHE;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), AUDIT_TOOLS_DIRNAME, "bincache");
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


const MANIFEST = ".audit-tools-binary.json";
type Identity = readonly [2, string, string, NodeJS.Platform, string, string, string, string, boolean];
interface Manifest {
  identity: Identity;
  executable_relative_path: string;
  executable_sha256: string;
}
class AcquisitionFailure extends Error {
  constructor(readonly reason: BinaryUnavailableReason, message: string) { super(message); }
}
function unavailable(reason: BinaryUnavailableReason, note: string): BinaryResolution {
  return { status: "unavailable", command: null, reason, note: note.slice(0, 1000) };
}
function directory(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("managed directory is not a physical directory");
}
function executableWithin(root: string, path: string, platform: NodeJS.Platform): string {
  directory(root);
  if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("invalid executable relative path");
  }
  const absolute = resolve(root, path);
  if (!absolute.startsWith(resolve(root) + sep)) throw new Error("executable escapes cache identity");
  const parts = path.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) { parent = join(parent, part); directory(parent); }
  if (!lstatSync(absolute).isFile()) throw new Error("executable is not a regular physical file");
  if (platform !== "win32") accessSync(absolute, constants.X_OK);
  return absolute;
}
function verified(root: string, identity: Identity): string | null {
  try {
    directory(root);
    if (!lstatSync(join(root, MANIFEST)).isFile()) return null;
    const manifest = JSON.parse(readFileSync(join(root, MANIFEST), "utf8")) as Manifest;
    if (JSON.stringify(manifest.identity) !== JSON.stringify(identity) ||
        typeof manifest.executable_relative_path !== "string" ||
        typeof manifest.executable_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.executable_sha256)) return null;
    const file = executableWithin(root, manifest.executable_relative_path, identity[3]);
    return hashContent(readFileSync(file)) === manifest.executable_sha256 ? file : null;
  } catch { return null; }
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Reject every link/special entry, including unused ones, without following it. */
function findExecutable(root: string, name: string): string | null {
  let found: string | null = null;
  const visit = (dir: string): void => {
    directory(dir);
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) { if (!found && entry === name) found = path; }
      else throw new Error("unsupported archive topology");
    }
  };
  visit(root);
  return found;
}

/** No injected byte fetch can reenter mutation after the deadline wins. */
async function fetchBytes(fetcher: BinaryFetcher, url: string, signal: AbortSignal): Promise<Uint8Array | null> {
  let onAbort: () => void = () => undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new AcquisitionFailure("deadline_exceeded", "binary acquisition deadline exceeded"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  const bytes = Promise.resolve().then(() => {
    if (signal.aborted) throw new AcquisitionFailure("deadline_exceeded", "binary acquisition deadline exceeded");
    return fetcher(url, signal);
  });
  void bytes.then(() => undefined, () => undefined);
  try { return await Promise.race([bytes, abort]); }
  finally { signal.removeEventListener("abort", onAbort); }
}

export async function resolveBinary(spec: BinarySpec, options: BinaryResolveOptions = {}): Promise<BinaryResolution> {
  const cwd = process.cwd();
  const env = { ...process.env };
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const deadline = options.deadline ?? { at: Date.now() + TRACKED_CHILD_DEADLINE_MS };
  if (!Number.isFinite(deadline.at)) return unavailable("invalid_budget", "invalid nonfinite binary acquisition deadline");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = (): void => {
    if (Date.now() >= deadline.at || controller.signal.aborted) {
      controller.abort();
      throw new AcquisitionFailure("deadline_exceeded", "binary acquisition deadline exceeded");
    }
  };
  const arm = (): void => {
    const remaining = deadline.at - Date.now();
    if (remaining <= 0) controller.abort();
    else timer = setTimeout(arm, Math.min(remaining, 2_147_483_647));
  };
  const run = options.run ?? ((argv: string[], at: string, timeout: number) => runTrackedAsync(argv, { cwd: at, timeout }));
  const cacheDir = resolve(options.cacheDir ?? defaultCacheDir());
  let diagnostic = "";
  let stage: string | undefined;
  try {
    check();
    arm();
    const executable = (options.resolveExecutable ?? resolveExecutableFile)(spec.binaryName, { cwd, env, platform });
    check();
    if (executable !== null) {
      const probe = await run([executable, ...spec.versionProbeArgs.slice(1)], cwd,
        resolveSpawnDeadline(deadline, TRACKED_CHILD_DEADLINE_MS));
      check();
      if (!probe.error && probe.status === 0 && spec.parseVersion?.(probe.stdout) === spec.version) {
        return { status: "path", command: executable };
      }
      diagnostic = "PATH executable did not report the exact pinned version; ";
    }
    const asset = spec.assetFor(platform, arch);
    if (!asset) return unavailable("no_asset_for_platform", diagnostic + `no release asset for ${platform}/${arch}`);
    const checksumAsset = typeof spec.checksumsAsset === "function" ? spec.checksumsAsset(asset) : spec.checksumsAsset;
    const identity: Identity = [2, spec.binaryName, spec.version, platform, arch, asset,
      spec.releaseUrlForAsset(asset), spec.releaseUrlForAsset(checksumAsset), spec.archived !== false];
    const key = hashContent(JSON.stringify(identity));
    const final = join(cacheDir, key);
    check();
    if (exists(cacheDir)) directory(cacheDir);
    const warm = verified(final, identity);
    check();
    if (warm) return { status: "cached", command: warm };
    const fetcher = options.fetch;
    if (!fetcher) return unavailable("offline", diagnostic + "no fetcher configured (offline)");
    // Online attempts create a private root/lock before requesting the checksum.
    check();
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    directory(cacheDir);
    check();
    const result = await withFileLock<BinaryResolution>(join(cacheDir, `${key}.lock`), async () => {
      check(); // acquireLock may recover a stale lock after its timeout.
      const existing = verified(final, identity);
      check();
      if (existing) return { status: "cached", command: existing };
      if (exists(final)) rmSync(final, { recursive: true, force: true });
      check();
      const request = async (url: string): Promise<Uint8Array | null> => {
        check();
        try { const bytes = await fetchBytes(fetcher, url, controller.signal); check(); return bytes; }
        catch (error) {
          check();
          throw new AcquisitionFailure("download_failed", `download failed: ${String(error)}`);
        }
      };
      const checksums = await request(identity[7]);
      check();
      if (!checksums || checksums.byteLength === 0) throw new AcquisitionFailure("download_empty", "checksum download returned no bytes");
      const expected = expectedSha256For(Buffer.from(checksums).toString("utf8"), asset);
      if (!expected) throw new AcquisitionFailure("no_checksum_for_asset", `no checksum for ${asset}`);
      const bytes = await request(identity[6]);
      check();
      if (!bytes || bytes.byteLength === 0) throw new AcquisitionFailure("download_empty", "asset download returned no bytes");
      if (hashContent(bytes) !== expected) throw new AcquisitionFailure("checksum_mismatch", `checksum mismatch for ${asset}`);
      check();
      stage = mkdtempSync(join(cacheDir, `${key}.stage-`));
      try {
        const name = platform === "win32" ? `${spec.binaryName}.exe` : spec.binaryName;
        if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") throw new Error("invalid binary filename");
        if (identity[8]) {
          const archive = join(stage, ".download-archive");
          writeFileSync(archive, bytes, { flag: "wx" });
          check();
          // Await actual settlement under the lock; never race an active extractor.
          let extraction: RunTrackedResult;
          try {
            extraction = await run(["tar", "-xf", archive, "-C", stage], stage,
              resolveSpawnDeadline(deadline, TRACKED_CHILD_DEADLINE_MS));
          } catch (error) {
            check();
            throw new AcquisitionFailure("extract_failed", `extract failed: ${String(error)}`);
          }
          check();
          if (extraction.error || extraction.status !== 0) throw new AcquisitionFailure("extract_failed", `extract failed: ${extraction.error?.message ?? extraction.status}`);
          rmSync(archive);
        } else writeFileSync(join(stage, name), bytes, { flag: "wx" });
        check();
        const file = findExecutable(stage, name);
        if (!file) throw new AcquisitionFailure("not_found_in_archive", "binary not found in archive");
        if (platform !== "win32") chmodSync(file, 0o755);
        const path = relative(stage, file).split(sep).join("/");
        executableWithin(stage, path, platform);
        check();
        const manifest: Manifest = { identity, executable_relative_path: path, executable_sha256: hashContent(readFileSync(file)) };
        writeFileSync(join(stage, MANIFEST), JSON.stringify(manifest) + "\n", { flag: "wx" });
        check();
        if (!verified(stage, identity)) throw new Error("staged cache verification failed");
        check();
        if (exists(final)) {
          const winner = verified(final, identity);
          check();
          if (!winner) throw new Error("unexpected invalid publication winner");
          return { status: "cached", command: winner };
        }
        renameSync(stage, final);
        stage = undefined; // Publication transfers ownership. Never clean final in catch/finally.
        return { status: "downloaded", command: join(final, path) };
      } finally {
        if (stage) { const owned = stage; stage = undefined; rmSync(owned, { recursive: true, force: true }); }
      }
    }, Math.max(1, deadline.at - Date.now()));
    check();
    return result;
  } catch (error) {
    if (error instanceof AcquisitionFailure) return unavailable(error.reason, diagnostic + error.message);
    if (error instanceof FileLockTimeoutError) return unavailable("deadline_exceeded", diagnostic + "binary acquisition lock deadline exceeded");
    return unavailable("write_failed", diagnostic + `acquisition failed: ${String(error)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
