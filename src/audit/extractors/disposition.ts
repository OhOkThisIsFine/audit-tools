import { spawnSync } from "node:child_process";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import type { RepoManifest } from "../types.js";
import { normalizeRepoPath } from "audit-tools/shared";
import type { FileDisposition, FileDispositionItem, FileDispositionStatus } from "audit-tools/shared";
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
 * Explicit out-of-scope reason for files that exist on disk but are absent
 * from the git index (`git ls-files`). Citation grounding already treats the
 * tracked set as the source of truth, so untracked scratch left in the audited
 * tree (worker batch files, generated helper scripts) must never enter the
 * auditable scope — a finding citing it could never be grounded.
 */
export const UNTRACKED_REASON = "untracked";

/**
 * Guard threshold shared by both scope rules: when a rule would exclude more
 * than this share of its candidate files, the rule is skipped (guard branch
 * `share_exceeded`) and only the existing targeted exclusions apply. A share
 * of exactly 1.0 fires the rule's root guard instead (`root_ignored` /
 * `root_untracked`).
 */
export const VCS_IGNORED_MAX_SHARE = 0.9;

export type ScopeRuleGuardBranch =
  | "root_ignored"
  | "share_exceeded"
  | "root_untracked";

/**
 * Outcome record for a scope rule (gitignore / untracked), persisted alongside
 * the per-file records so the scope pre-digest / intent checkpoint can surface
 * skipped-rule and guard decisions.
 */
export interface ScopeRuleSummary {
  /** True when the rule's exclusions were applied to the disposition. */
  applied: boolean;
  /** Number of candidate files the rule matched. */
  ignored_count: number;
  /** Why the rule was skipped (clean fallback or guard). */
  skipped_reason?: string;
  /** Which guard branch fired when a guard skipped the rule. */
  guard_branch?: ScopeRuleGuardBranch;
}

/** FileDisposition enriched with the per-rule outcome records. */
export interface FileDispositionWithScopeRules extends FileDisposition {
  vcs_ignore?: ScopeRuleSummary;
  untracked?: ScopeRuleSummary;
}

/** Injection seam for the batched git spawns (tests). */
export type GitSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface BuildFileDispositionOptions {
  /**
   * Audit root. When provided (and a git work tree), enables the batched
   * `git check-ignore --stdin` pass that classifies vcs-ignored files out of
   * scope, followed by the batched `git ls-files` pass that classifies
   * untracked files out of scope. Omit for the heuristics-only disposition.
   */
  root?: string;
  /** Test seam: replacement for child_process.spawnSync on `git check-ignore`. */
  spawn?: GitSpawn;
  /** Test seam: replacement for child_process.spawnSync on `git ls-files`. */
  lsFilesSpawn?: GitSpawn;
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
  spawn: GitSpawn,
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

type TrackedFilesEvaluation =
  | { ok: true; tracked: Set<string> }
  | { ok: false; reason: string };

/**
 * Enumerates the repository's tracked paths through ONE batched
 * `git ls-files -z` invocation (never per-file). Output paths are repo-root
 * (cwd)-relative posix, matching the manifest's normalized candidate paths.
 * Anything other than exit 0 (git absent, not a work tree) = clean fallback —
 * the caller skips the untracked rule. Never throws.
 */
function evaluateTrackedFiles(
  root: string,
  spawn: GitSpawn,
): TrackedFilesEvaluation {
  let result: SpawnSyncReturns<string>;
  try {
    result = spawn("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `git ls-files spawn failed: ${message}` };
  }
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      reason:
        code === "ENOENT"
          ? "git executable not found (ENOENT)"
          : `git ls-files failed to start: ${result.error.message}`,
    };
  }
  if (result.status === 0) {
    return {
      ok: true,
      tracked: new Set(
        (result.stdout ?? "").split("\0").filter((path) => path.length > 0),
      ),
    };
  }
  const stderrFirstLine = (result.stderr ?? "").trim().split(/\r?\n/, 1)[0] ?? "";
  return {
    ok: false,
    reason:
      `git ls-files exited ${result.status ?? "by signal"}` +
      (stderrFirstLine ? `: ${stderrFirstLine}` : ""),
  };
}

/**
 * Build a skipped ScopeRuleSummary for any guard branch or clean fallback.
 * Every skip return site shares the same shape; centralising here means
 * future guard additions only need to call this helper.
 */
function skippedRule(
  skipped_reason: string,
  ignored_count = 0,
  guard_branch?: ScopeRuleGuardBranch,
): ScopeRuleSummary {
  return { applied: false, ignored_count, skipped_reason, guard_branch };
}

/**
 * Applies one scope rule's exclusions: the matched files are re-classified
 * `excluded` with the rule's reason, keeping one per-file record each. Every
 * manifest file MUST keep a per-file record — downstream consumers
 * (unit builder, coverage matrix, graph path lookup) treat a missing
 * disposition entry as included, so any bounded/aggregated representation
 * silently un-excludes the very files the rule matched. Only `included` items
 * are ever re-classified — earlier exclusions win.
 */
function applyRuleExclusions(params: {
  items: FileDispositionItem[];
  /** Normalized form of each item's path, parallel to `items`. */
  itemPosix: string[];
  /** Normalized paths of the included items the rule matched. */
  matchedPosix: string[];
  reason: typeof VCS_IGNORED_REASON | typeof UNTRACKED_REASON;
  /** The rule's raw matched count, surfaced as the summary's ignored_count. */
  matchedCount: number;
}): { files: FileDispositionItem[]; summary: ScopeRuleSummary } {
  const { items, itemPosix, matchedPosix, reason, matchedCount } = params;
  const matchedSet = new Set(matchedPosix);
  const files = items.map((item, i) =>
    item.status === "included" && matchedSet.has(itemPosix[i])
      ? { path: item.path, status: "excluded" as const, reason }
      : item,
  );
  return { files, summary: { applied: true, ignored_count: matchedCount } };
}

function applyVcsIgnoreRule(
  baseline: FileDispositionItem[],
  candidatePosix: string[],
  root: string,
  spawn: GitSpawn,
): { files: FileDispositionItem[]; summary: ScopeRuleSummary } {
  const evaluation = evaluateVcsIgnored(root, candidatePosix, spawn);

  if (!evaluation.ok) {
    // Clean fallback: keep the existing targeted exclusions only.
    return {
      files: baseline,
      summary: skippedRule(`gitignore rule skipped: ${evaluation.reason}`),
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
      summary: skippedRule(
        "gitignore rule skipped: audit root itself is ignored (every candidate file matched ignore rules)",
        ignoredCount,
        "root_ignored",
      ),
    };
  }
  // Share guard: an ignore rule that would exclude more than
  // VCS_IGNORED_MAX_SHARE of candidates is more likely a mis-scope than a
  // legitimate exclusion — skip it and surface the decision.
  if (total > 0 && ignoredCount / total > VCS_IGNORED_MAX_SHARE) {
    return {
      files: baseline,
      summary: skippedRule(
        `gitignore rule skipped: ignored share ${(ignoredCount / total).toFixed(3)} ` +
          `exceeds VCS_IGNORED_MAX_SHARE (${VCS_IGNORED_MAX_SHARE})`,
        ignoredCount,
        "share_exceeded",
      ),
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

  return applyRuleExclusions({
    items: baseline,
    itemPosix: candidatePosix,
    matchedPosix: newlyIgnoredPosix,
    reason: VCS_IGNORED_REASON,
    matchedCount: ignoredCount,
  });
}

/**
 * Re-classifies still-included files that are absent from the git index
 * (`git ls-files`) out of scope. Untracked scratch left in the audited tree
 * (worker batch files, generated helper scripts) otherwise enters the manifest
 * via the filesystem walk while citation grounding — which treats the tracked
 * set as the source of truth — can never ground findings against it, so the
 * next audit's findings end up citing the previous run's litter. Runs after
 * the gitignore rule (gitignored files keep their more specific reason) and
 * mirrors its guards: a scope that is entirely or almost entirely untracked
 * (e.g. a repository with no commits yet) skips the rule rather than emptying
 * the audit.
 */
function applyUntrackedRule(
  items: FileDispositionItem[],
  root: string,
  spawn: GitSpawn,
): { files: FileDispositionItem[]; summary: ScopeRuleSummary } {
  const evaluation = evaluateTrackedFiles(root, spawn);

  if (!evaluation.ok) {
    return {
      files: items,
      summary: skippedRule(`untracked rule skipped: ${evaluation.reason}`),
    };
  }

  // Membership matching mirrors the grounding corpus' policy
  // (normalizeRepoPath: separator- AND case-normalized) — a case-only drift
  // between the on-disk walk and the index (case-insensitive filesystems,
  // `core.ignorecase` renames) must not mark a tracked file untracked.
  const tracked = new Set([...evaluation.tracked].map(normalizeRepoPath));
  const itemPosix = items.map((item) => normalizeRepoPath(item.path));
  const matchedPosix: string[] = [];
  let candidateCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].status !== "included") continue;
    candidateCount += 1;
    if (!tracked.has(itemPosix[i])) {
      matchedPosix.push(itemPosix[i]);
    }
  }
  const matchedCount = matchedPosix.length;

  // Root guard: when EVERY included candidate is untracked the repository has
  // no tracked files in scope (no commits/index yet) — applying the rule would
  // empty the audit scope.
  if (candidateCount > 0 && matchedCount === candidateCount) {
    return {
      files: items,
      summary: skippedRule(
        "untracked rule skipped: every included candidate is untracked (the repository has no tracked files in the audit scope)",
        matchedCount,
        "root_untracked",
      ),
    };
  }
  if (candidateCount > 0 && matchedCount / candidateCount > VCS_IGNORED_MAX_SHARE) {
    return {
      files: items,
      summary: skippedRule(
        `untracked rule skipped: untracked share ${(matchedCount / candidateCount).toFixed(3)} ` +
          `of included candidates exceeds VCS_IGNORED_MAX_SHARE (${VCS_IGNORED_MAX_SHARE})`,
        matchedCount,
        "share_exceeded",
      ),
    };
  }

  return applyRuleExclusions({
    items,
    itemPosix,
    matchedPosix,
    reason: UNTRACKED_REASON,
    matchedCount,
  });
}

/**
 * Applies shared path heuristics to mark files that should be excluded or
 * down-scoped before audit planning begins. When `options.root` is provided,
 * additionally classifies vcs-ignored files out of scope via one batched
 * `git check-ignore --stdin` pass, then untracked files via one batched
 * `git ls-files` pass — each with clean fallback to the disposition built so
 * far whenever git is unavailable or a safety guard fires.
 */
export function buildFileDisposition(
  repoManifest: RepoManifest,
  options: BuildFileDispositionOptions = {},
): FileDispositionWithScopeRules {
  const baseline = repoManifest.files.map((file) => inferDisposition(file.path));
  if (!options.root) {
    return { files: baseline };
  }

  const candidatePosix = repoManifest.files.map((file) =>
    toPosixPath(file.path),
  );
  const vcsStage = applyVcsIgnoreRule(
    baseline,
    candidatePosix,
    options.root,
    options.spawn ?? spawnSync,
  );
  const untrackedStage = applyUntrackedRule(
    vcsStage.files,
    options.root,
    options.lsFilesSpawn ?? spawnSync,
  );
  return {
    files: untrackedStage.files,
    vcs_ignore: vcsStage.summary,
    untracked: untrackedStage.summary,
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
