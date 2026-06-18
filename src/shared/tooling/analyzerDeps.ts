import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { runTracked, type RunTrackedResult } from "./exec.js";

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
 */
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
  /** Injectable command runner; defaults to the shared runTracked. */
  run?: (argv: string[], cwd: string) => RunTrackedResult;
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
export function installToCache(
  pkgAtVersion: string,
  options: InstallToCacheOptions = {},
): InstallToCacheResult {
  const { name, version } = parseAnalyzerSpec(pkgAtVersion);
  if (!version) {
    return { ok: false, error: "installToCache requires an explicit version (name@version)" };
  }
  const cacheRoot = options.cacheRoot ?? analyzerCacheRoot();
  const installDir = join(cacheRoot, cacheKey(name, version));
  const run = options.run ?? ((argv, cwd) => runTracked(argv, { cwd }));
  const log = options.log ?? ((...args: unknown[]) => { console.error(...args); });

  try {
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
    const result = run(
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
