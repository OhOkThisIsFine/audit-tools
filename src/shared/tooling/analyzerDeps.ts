import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  runTrackedAsync,
  TRACKED_CHILD_DEADLINE_MS,
  type RunTrackedResult,
} from "./exec.js";

// Optional analyzer-dependency resolution (Phase 5). Heavy graph analyzers
// (the `typescript` compiler API, tree-sitter grammars) are optional: resolve
// them from the repo's own node_modules first, then a version-keyed shared
// cache under ~/.audit-tools/analyzer-cache, and otherwise report "absent" so
// the caller falls back to the regex floor. `installToCache` populates the
// shared cache without ever touching the audited project.

export type AnalyzerDepVia = "repo" | "cache" | "absent";

export interface ResolvedAnalyzerDep {
  via: AnalyzerDepVia;
  /** Absolute path to the resolved package directory (when via != "absent"). */
  path?: string;
}

export interface ResolveAnalyzerDepOptions {
  /** Override the cache root; defaults to ~/.audit-tools/analyzer-cache. */
  cacheRoot?: string;
  /**
   * Injectable logger for observability output. Defaults to `console.error`
   * so existing behaviour is preserved when callers do not supply one.
   * Inject a no-op or custom logger in tests/contexts that need to redirect or
   * suppress output.
   *
   * Signature matches `console.error` so callers can pass it directly:
   * `log: console.error`.
   */
  log?: (...args: unknown[]) => void;
}

/**
 * Shared analyzer cache root. Defaults to ~/.audit-tools/analyzer-cache; the
 * `AUDIT_TOOLS_ANALYZER_CACHE` environment variable overrides it so a run can be
 * pinned to an isolated cache (e.g. tests that need dependency resolution to be
 * deterministic regardless of what the host machine has previously cached).
 *
 * The mode is the same privilege-boundary reasoning the binary-acquisition
 * cache carries, and it applies verbatim: this directory holds executable npm
 * packages, and the path is fully derivable from a public convention, so "a
 * package exists there" is only evidence of anything when the directory is not
 * writable by other local processes. Created `0o700` where the platform honours
 * modes; on win32 the mode is ignored (ACLs govern) and the per-user home root
 * is the protection.
 *
 * ⚠ The mode applies AT CREATION ONLY. `mkdirSync` does not chmod a directory it
 * did not create, so a root already created loosely by an earlier version is not
 * repaired here; the caller-supplied `cacheRoot` override is the caller's own
 * directory and its permissions are the caller's own concern.
 */
export const ANALYZER_CACHE_ROOT_MODE = 0o700;

function ensureAnalyzerCacheRoot(cacheRoot: string): void {
  try {
    mkdirSync(cacheRoot, { recursive: true, mode: ANALYZER_CACHE_ROOT_MODE });
  } catch {
    /* a later mkdir of the install dir surfaces any real failure */
  }
}

export function analyzerCacheRoot(): string {
  const override = process.env.AUDIT_TOOLS_ANALYZER_CACHE;
  if (override && override.trim().length > 0) return override;
  return join(homedir(), ".audit-tools", "analyzer-cache");
}

interface ParsedSpec {
  name: string;
  version?: string;
}

/** Parse "name", "name@version", or "@scope/name@version". */
export function parseAnalyzerSpec(spec: string): ParsedSpec {
  const at = spec.lastIndexOf("@");
  // at === 0 means a bare scoped name like "@scope/name" (no version).
  if (at > 0) {
    return { name: spec.slice(0, at), version: spec.slice(at + 1) };
  }
  return { name: spec };
}

// Cache directory key. Scoped package separators are escaped so the key is a
// single valid directory name (e.g. "@scope/pkg@1.0.0" -> "@scope+pkg@1.0.0").
function cacheKey(name: string, version: string): string {
  return `${name.replace(/\//g, "+")}@${version}`;
}

function packageDirIn(installDir: string, name: string): string {
  return join(installDir, "node_modules", ...name.split("/"));
}

function isInstalledPackage(packageDir: string): boolean {
  return existsSync(join(packageDir, "package.json"));
}

function findInCache(
  name: string,
  version: string | undefined,
  cacheRoot: string,
): string | undefined {
  if (!existsSync(cacheRoot)) return undefined;

  if (version) {
    const installDir = join(cacheRoot, cacheKey(name, version));
    const packageDir = packageDirIn(installDir, name);
    return isInstalledPackage(packageDir) ? packageDir : undefined;
  }

  // No version pinned: pick the highest-sorting matching cache entry that
  // actually contains an installed package. Deterministic via reverse sort.
  const prefix = `${name.replace(/\//g, "+")}@`;
  let entries: string[];
  try {
    entries = readdirSync(cacheRoot);
  } catch {
    return undefined;
  }
  const matches = entries
    .filter((entry) => entry.startsWith(prefix))
    .sort()
    .reverse();
  for (const entry of matches) {
    const packageDir = packageDirIn(join(cacheRoot, entry), name);
    if (isInstalledPackage(packageDir)) return packageDir;
  }
  return undefined;
}

/**
 * Resolve an analyzer dependency: repo node_modules → version-keyed cache →
 * absent. `pkg` may be a bare name or "name@version"; a version narrows the
 * cache lookup, otherwise the newest cached version is chosen.
 */
export function resolveAnalyzerDep(
  pkg: string,
  repoRoot: string,
  options: ResolveAnalyzerDepOptions = {},
): ResolvedAnalyzerDep {
  const { name, version } = parseAnalyzerSpec(pkg);
  const log = options.log ?? ((...args: unknown[]) => { console.error(...args); });

  const repoPackageDir = packageDirIn(repoRoot, name);
  if (isInstalledPackage(repoPackageDir)) {
    log("[analyzerDeps] resolved %s via repo: %s", pkg, repoPackageDir);
    return { via: "repo", path: repoPackageDir };
  }

  const cacheRoot = options.cacheRoot ?? analyzerCacheRoot();
  const cached = findInCache(name, version, cacheRoot);
  if (cached) {
    log("[analyzerDeps] resolved %s via cache: %s", pkg, cached);
    return { via: "cache", path: cached };
  }

  log("[analyzerDeps] %s not found in repo or cache (absent)", pkg);
  return { via: "absent" };
}

export interface InstallToCacheOptions {
  cacheRoot?: string;
  /**
   * Injectable command runner; defaults to the shared `runTrackedAsync` with
   * the fold child deadline. ASYNC by contract: the install is fold-reachable
   * (graph enrichment runs inside the artifact-tree lock's hold), and a
   * synchronous `npm install` blocks the event loop — starving the held
   * lock's mtime heartbeat until another process classifies the LIVE lock
   * stale and steals it (INV-SSF).
   */
  run?: (argv: string[], cwd: string) => Promise<RunTrackedResult>;
  /**
   * Injectable logger for observability output. Defaults to `console.error`
   * so existing behaviour is preserved when callers do not supply one.
   * Inject a no-op or custom logger in tests/contexts that need to redirect or
   * suppress output.
   */
  log?: (...args: unknown[]) => void;
}

export interface InstallToCacheResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Install `pkg@version` into the version-keyed shared cache and return the
 * installed package directory. Requires an explicit version so the cache stays
 * reproducible. Never writes into any audited project.
 */
export async function installToCache(
  pkgAtVersion: string,
  options: InstallToCacheOptions = {},
): Promise<InstallToCacheResult> {
  const { name, version } = parseAnalyzerSpec(pkgAtVersion);
  if (!version) {
    return { ok: false, error: "installToCache requires an explicit version (name@version)" };
  }
  const cacheRoot = options.cacheRoot ?? analyzerCacheRoot();
  const installDir = join(cacheRoot, cacheKey(name, version));
  const run =
    options.run ??
    ((argv: string[], cwd: string) =>
      runTrackedAsync(argv, { cwd, timeout: TRACKED_CHILD_DEADLINE_MS }));
  const log = options.log ?? ((...args: unknown[]) => { console.error(...args); });

  try {
    ensureAnalyzerCacheRoot(cacheRoot);
    mkdirSync(installDir, { recursive: true });
    const manifestPath = join(installDir, "package.json");
    if (!existsSync(manifestPath)) {
      writeFileSync(
        manifestPath,
        JSON.stringify({ name: "audit-tools-analyzer-cache", private: true }) + "\n",
        "utf8",
      );
    }
    log("[analyzerDeps] installing %s into cache: %s", pkgAtVersion, installDir);
    const result = await run(
      ["npm", "install", pkgAtVersion, "--no-audit", "--no-fund", "--save-exact"],
      installDir,
    );
    if (result.status !== 0) {
      log(
        "[analyzerDeps] npm install %s failed (exit %d): %s",
        pkgAtVersion,
        result.status,
        result.stderr.trim() || "(no stderr)",
      );
      return {
        ok: false,
        error: result.stderr.trim() || `npm install exited with ${result.status}`,
      };
    }
    const packageDir = packageDirIn(installDir, name);
    if (!isInstalledPackage(packageDir)) {
      log(
        "[analyzerDeps] npm install %s exited 0 but package directory is absent: %s",
        pkgAtVersion,
        packageDir,
      );
      return { ok: false, error: "package not present after install" };
    }
    log("[analyzerDeps] installed %s -> %s", pkgAtVersion, packageDir);
    return { ok: true, path: packageDir };
  } catch (error) {
    log(
      "[analyzerDeps] installToCache threw for %s: %s",
      pkgAtVersion,
      error instanceof Error ? error.message : String(error),
    );
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
