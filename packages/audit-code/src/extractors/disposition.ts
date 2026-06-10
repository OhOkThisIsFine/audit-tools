import { spawnSync } from "node:child_process";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import type { RepoManifest } from "../types.js";
import type { FileDisposition, FileDispositionItem, FileDispositionStatus } from "@audit-tools/shared";
import {
  isNodeModulesOrGit,
  isPackageManagerCachePath,
  isTmpPath,
  isBuildOutput,
  isVendorPath,
  isBinaryArtifact,
  isLicensePath,
  isLockfilePath,
  isLogPath,
  isDocPath,
  isGeneratedPath,
  isAuditArtifactPath,
  isAuditToolOutputArtifact,
  isGeneratedTestArtifactPath,
  isGeneratedInstallArtifactPath,
  isExamplesOrFixturesPath,
  normalizeExtractorPath,
} from "./pathPatterns.js";

function inferDisposition(path: string): FileDispositionItem {
  const normalized = normalizeExtractorPath(path);

  if (isNodeModulesOrGit(normalized)) {
    return { path, status: "excluded", reason: "node_modules or .git excluded by convention." };
  }
  if (isPackageManagerCachePath(normalized)) {
    return {
      path,
      status: "excluded",
      reason: "Package-manager cache (npm _cacache/npm-cache) excluded by convention.",
    };
  }
  if (isTmpPath(normalized)) {
    return {
      path,
      status: "excluded",
      reason: "Temporary/bundled artifact directory (.tmp) excluded by convention.",
    };
  }
  if (isBuildOutput(normalized)) {
    return { path, status: "generated", reason: "Build output path." };
  }
  if (isVendorPath(normalized)) {
    return { path, status: "vendor", reason: "Vendor or third-party path." };
  }
  if (isBinaryArtifact(normalized)) {
    return {
      path,
      status: "binary",
      reason: "Non-source binary-like artifact.",
    };
  }
  if (isLogPath(normalized)) {
    return { path, status: "generated", reason: "Runtime log artifact." };
  }
  if (isLicensePath(normalized)) {
    return { path, status: "doc_only", reason: "License file is not auditable code." };
  }
  if (isLockfilePath(normalized)) {
    return { path, status: "generated", reason: "Lockfile excluded from code audit scope." };
  }
  if (isAuditArtifactPath(normalized)) {
    return {
      path,
      status: "generated",
      reason: "Generated audit artifact.",
    };
  }
  if (isAuditToolOutputArtifact(normalized)) {
    return {
      path,
      status: "generated",
      reason: "audit-tools pipeline output (findings/report) — a data deliverable, not source.",
    };
  }
  if (isGeneratedPath(normalized)) {
    return {
      path,
      status: "generated",
      reason: "Generated artifact path.",
    };
  }
  if (isGeneratedTestArtifactPath(normalized)) {
    return {
      path,
      status: "generated",
      reason: "Generated test artifact.",
    };
  }
  if (isDocPath(normalized)) {
    return { path, status: "doc_only", reason: "Documentation artifact." };
  }
  if (isGeneratedInstallArtifactPath(normalized)) {
    return {
      path,
      status: "generated",
      reason: "Generated install/bootstrap artifact.",
    };
  }
  if (isExamplesOrFixturesPath(normalized)) {
    return { path, status: "doc_only", reason: "Examples and fixtures are support artifacts, not auditable code." };
  }

  return {
    path,
    status: "included",
    reason: "Default included source or config artifact.",
  };
}

/**
 * Explicit out-of-scope reason for files excluded because the repository's own
 * VCS ignore rules (.gitignore et al.) cover them.
 */
export const VCS_IGNORED_REASON = "vcs_ignored";

/**
 * At or below this many vcs-ignored files, the disposition carries one
 * per-file record per ignored file. Above it, ignored files are aggregated by
 * directory prefix so file_disposition.json stays bounded regardless of how
 * many files the ignore rules cover.
 */
export const VCS_IGNORED_PER_FILE_LIMIT = 200;

/**
 * Guard threshold: when `git check-ignore` reports more than this share of all
 * candidate files as ignored, the gitignore rule is skipped (guard branch
 * `share_exceeded`) and only the existing targeted exclusions apply. A share
 * of exactly 1.0 means the audit root itself is effectively ignored (guard
 * branch `root_ignored`).
 */
export const VCS_IGNORED_MAX_SHARE = 0.9;

export type VcsIgnoreGuardBranch = "root_ignored" | "share_exceeded";

/** Bounded directory-prefix aggregate used above VCS_IGNORED_PER_FILE_LIMIT. */
export interface VcsIgnoredAggregate {
  /** Top-level directory prefix ("." for root-level files). */
  prefix: string;
  /** Number of vcs-ignored files under the prefix. */
  count: number;
  reason: typeof VCS_IGNORED_REASON;
}

/**
 * Outcome record for the gitignore disposition rule, persisted alongside the
 * per-file records so the scope pre-digest / intent checkpoint can surface
 * skipped-rule and guard decisions.
 */
export interface VcsIgnoreSummary {
  /** True when gitignore-based exclusions were applied to the disposition. */
  applied: boolean;
  /** Number of candidate files `git check-ignore` reported as ignored. */
  ignored_count: number;
  /** Why the gitignore rule was skipped (clean fallback or guard). */
  skipped_reason?: string;
  /** Which guard branch fired when a guard skipped the rule. */
  guard_branch?: VcsIgnoreGuardBranch;
  /** Directory-prefix aggregates emitted above VCS_IGNORED_PER_FILE_LIMIT. */
  aggregates?: VcsIgnoredAggregate[];
}

/** FileDisposition enriched with the gitignore-rule outcome record. */
export interface FileDispositionWithVcsIgnore extends FileDisposition {
  vcs_ignore?: VcsIgnoreSummary;
}

/** Injection seam for the single batched `git check-ignore` spawn (tests). */
export type CheckIgnoreSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface BuildFileDispositionOptions {
  /**
   * Audit root. When provided (and a git work tree), enables the batched
   * `git check-ignore --stdin` pass that classifies vcs-ignored files
   * out of scope. Omit for the heuristics-only disposition.
   */
  root?: string;
  /** Test seam: replacement for child_process.spawnSync. */
  spawn?: CheckIgnoreSpawn;
}

function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

type VcsIgnoreEvaluation =
  | { ok: true; ignored: Set<string> }
  | { ok: false; reason: string };

/**
 * Evaluates every candidate path through ONE batched
 * `git check-ignore --stdin -z` invocation (never per-file). Exit-code
 * contract: 0 = some paths ignored, 1 = none ignored (success, empty set),
 * anything else (128 / git absent / not a work tree) = clean fallback —
 * the caller keeps only the existing targeted exclusions. Never throws.
 */
function evaluateVcsIgnored(
  root: string,
  candidatePosixPaths: readonly string[],
  spawn: CheckIgnoreSpawn,
): VcsIgnoreEvaluation {
  if (candidatePosixPaths.length === 0) {
    return { ok: true, ignored: new Set() };
  }
  let result: SpawnSyncReturns<string>;
  try {
    result = spawn("git", ["check-ignore", "--stdin", "-z"], {
      cwd: root,
      input: candidatePosixPaths.map((path) => `${path}\0`).join(""),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `git check-ignore spawn failed: ${message}` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason:
        code === "ENOENT"
          ? "git executable not found (ENOENT)"
          : `git check-ignore failed to start: ${result.error.message}`,
    };
  }
  if (result.status === 0 || result.status === 1) {
    // 0 = some paths ignored (stdout has the set); 1 = no paths ignored.
    const ignored = new Set(
      (result.stdout ?? "").split("\0").filter((path) => path.length > 0),
    );
    return { ok: true, ignored };
  }
  const stderrFirstLine = (result.stderr ?? "").trim().split(/\r?\n/, 1)[0] ?? "";
  return {
    ok: false,
    reason:
      `git check-ignore exited ${result.status ?? "by signal"}` +
      (stderrFirstLine ? `: ${stderrFirstLine}` : ""),
  };
}

function topLevelPrefix(posixPath: string): string {
  const slash = posixPath.indexOf("/");
  return slash === -1 ? "." : posixPath.slice(0, slash);
}

function aggregateByPrefix(posixPaths: readonly string[]): VcsIgnoredAggregate[] {
  const counts = new Map<string, number>();
  for (const path of posixPaths) {
    const prefix = topLevelPrefix(path);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([prefix, count]) => ({ prefix, count, reason: VCS_IGNORED_REASON }));
}

/**
 * Applies shared path heuristics to mark files that should be excluded or
 * down-scoped before audit planning begins. When `options.root` is provided,
 * additionally classifies vcs-ignored files out of scope via one batched
 * `git check-ignore --stdin` pass, with clean fallback to the heuristics-only
 * disposition whenever git is unavailable or a safety guard fires.
 */
export function buildFileDisposition(
  repoManifest: RepoManifest,
  options: BuildFileDispositionOptions = {},
): FileDispositionWithVcsIgnore {
  const baseline = repoManifest.files.map((file) => inferDisposition(file.path));
  if (!options.root) {
    return { files: baseline };
  }

  const candidatePosix = repoManifest.files.map((file) =>
    toPosixPath(file.path),
  );
  const evaluation = evaluateVcsIgnored(
    options.root,
    candidatePosix,
    options.spawn ?? spawnSync,
  );

  if (!evaluation.ok) {
    // Clean fallback: keep the existing targeted exclusions only.
    return {
      files: baseline,
      vcs_ignore: {
        applied: false,
        ignored_count: 0,
        skipped_reason: `gitignore rule skipped: ${evaluation.reason}`,
      },
    };
  }

  const total = candidatePosix.length;
  const ignoredCount = candidatePosix.filter((path) =>
    evaluation.ignored.has(path),
  ).length;

  // Root-ignored guard: every candidate ignored means the audit root itself is
  // (effectively) ignored — applying the rule would empty the audit scope.
  if (total > 0 && ignoredCount === total) {
    return {
      files: baseline,
      vcs_ignore: {
        applied: false,
        ignored_count: ignoredCount,
        guard_branch: "root_ignored",
        skipped_reason:
          "gitignore rule skipped: audit root itself is ignored (every candidate file matched ignore rules)",
      },
    };
  }
  // Share guard: an ignore rule that would exclude more than
  // VCS_IGNORED_MAX_SHARE of candidates is more likely a mis-scope than a
  // legitimate exclusion — skip it and surface the decision.
  if (total > 0 && ignoredCount / total > VCS_IGNORED_MAX_SHARE) {
    return {
      files: baseline,
      vcs_ignore: {
        applied: false,
        ignored_count: ignoredCount,
        guard_branch: "share_exceeded",
        skipped_reason:
          `gitignore rule skipped: ignored share ${(ignoredCount / total).toFixed(3)} ` +
          `exceeds VCS_IGNORED_MAX_SHARE (${VCS_IGNORED_MAX_SHARE})`,
      },
    };
  }

  // Existing targeted exclusions take precedence; the gitignore rule only
  // re-classifies files the heuristics would otherwise include.
  const newlyIgnoredPosix: string[] = [];
  for (let i = 0; i < baseline.length; i++) {
    if (
      baseline[i].status === "included" &&
      evaluation.ignored.has(candidatePosix[i])
    ) {
      newlyIgnoredPosix.push(candidatePosix[i]);
    }
  }

  if (newlyIgnoredPosix.length <= VCS_IGNORED_PER_FILE_LIMIT) {
    const newlyIgnoredSet = new Set(newlyIgnoredPosix);
    const files = baseline.map((item, i) =>
      newlyIgnoredSet.has(candidatePosix[i]) && item.status === "included"
        ? { path: item.path, status: "excluded" as const, reason: VCS_IGNORED_REASON }
        : item,
    );
    return {
      files,
      vcs_ignore: { applied: true, ignored_count: ignoredCount },
    };
  }

  // Bounded representation: above the per-file limit, drop per-file records
  // for vcs-ignored files and emit directory-prefix aggregates instead.
  const newlyIgnoredSet = new Set(newlyIgnoredPosix);
  const files = baseline.filter(
    (item, i) =>
      !(item.status === "included" && newlyIgnoredSet.has(candidatePosix[i])),
  );
  return {
    files,
    vcs_ignore: {
      applied: true,
      ignored_count: ignoredCount,
      aggregates: aggregateByPrefix(newlyIgnoredPosix),
    },
  };
}

export function buildDispositionMap(
  disposition?: FileDisposition,
): Map<string, FileDispositionStatus> {
  return new Map(
    disposition?.files.map((item) => [item.path, item.status]) ?? [],
  );
}

export function isAuditExcludedStatus(
  status: FileDispositionStatus,
): status is Exclude<FileDispositionStatus, "included"> {
  return (
    status === "excluded" ||
    status === "generated" ||
    status === "vendor" ||
    status === "binary" ||
    status === "doc_only"
  );
}
