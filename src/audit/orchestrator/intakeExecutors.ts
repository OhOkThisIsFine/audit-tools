import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isGitRepo, writeJsonFile } from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import {
  buildFileDisposition,
  isAuditExcludedStatus,
} from "../extractors/disposition.js";
import { buildRepoManifestFromFs } from "../extractors/fsIntake.js";
import { loadIgnoreFile } from "../extractors/ignore.js";
import type { ExecutorRunResult, ScopeSummary } from "./executorResult.js";

interface PackageJsonShape {
  name?: unknown;
  workspaces?: unknown;
}

/**
 * Extracted helper for MNT-6bf34726: Nested directory-climb loop pattern.
 * Walks ancestors from startDir upward, calling fn for each, stopping at stopFn.
 */
function walkAncestorDirs(
  startDir: string,
  fn: (dir: string) => boolean,
  maxLevels?: number,
): void {
  let current = dirname(startDir);
  let previous = startDir;
  let levelsChecked = 0;

  while (current && current !== previous && (!maxLevels || levelsChecked < maxLevels)) {
    if (fn(current)) break;
    previous = current;
    current = dirname(current);
    levelsChecked++;
  }
}

/** Detect signals that the resolved audit root may be the wrong directory. */
export async function detectMisScopeSmells(root: string): Promise<string[]> {
  const smells: string[] = [];

  if (!(await isGitRepo(root))) {
    walkAncestorDirs(root, (ancestor) => {
      if (existsSync(join(ancestor, ".git"))) {
        smells.push(
          `root has no .git but ancestor '${ancestor}' is a git repository — you may have targeted a subdirectory instead of the repo root`,
        );
        return true;
      }
      return false;
    });
  }

  const rootPkg = readPackageJson(root);
  if (rootPkg && rootPkg.name !== undefined) {
    walkAncestorDirs(
      root,
      (ancestor) => {
        const ancestorPkg = readPackageJson(ancestor);
        if (ancestorPkg && ancestorPkg.workspaces !== undefined) {
          smells.push(
            `root appears to be a workspace member of a parent monorepo at '${ancestor}' — consider auditing from the monorepo root instead`,
          );
          return true;
        }
        if (existsSync(join(ancestor, ".git"))) return true;
        return false;
      },
      3,
    );
  }

  return smells;
}

function readPackageJson(dir: string): PackageJsonShape | undefined {
  const path = join(dir, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as PackageJsonShape)
      : undefined;
  } catch {
    return undefined;
  }
}

// sites-pinned: tests/audit/frozen-snapshot.test.ts
export async function runIntakeExecutor(
  bundle: ArtifactBundle,
  root: string,
  artifactsDir?: string,
  /**
   * The LIVE repository root when `root` is the run's frozen snapshot: the
   * manifest is named after it and `scope_summary.repo_root` states it, so a
   * new snapshot path never renames the manifest (which would re-stale the
   * whole dependency DAG) and the host is told which repository is audited.
   */
  repositoryRoot: string = root,
): Promise<ExecutorRunResult> {
  const ignore = await loadIgnoreFile(root);
  const repoManifest = await buildRepoManifestFromFs({
    root,
    name: basename(resolve(repositoryRoot)),
    ignore,
    hash_files: true,
  });
  const disposition = await buildFileDisposition(repoManifest, { root });
  const auditableCount = disposition.files.filter(
    (file) => !isAuditExcludedStatus(file.status),
  ).length;

  if (auditableCount === 0) {
    throw new Error(
      `No auditable files found in ${repositoryRoot}. The repository may be empty, generated-only, documentation-only, or filtered by .auditorignore.`,
    );
  }

  const scopeSummary: ScopeSummary = {
    repo_root: repositoryRoot,
    auditable_file_count: auditableCount,
    git_available: await isGitRepo(root),
    mis_scope_smells: await detectMisScopeSmells(root),
  };

  const artifactsWritten = ["repo_manifest.json", "file_disposition.json"];
  if (artifactsDir) {
    await writeJsonFile(join(artifactsDir, "scope_summary.json"), scopeSummary);
    artifactsWritten.push("scope_summary.json");
  }

  const progressSummary =
    `Created intake artifacts for ${repoManifest.files.length} files ` +
    `(${auditableCount} auditable). Scope: ${root}, git: ${scopeSummary.git_available ? "yes" : "no"}` +
    (scopeSummary.mis_scope_smells.length > 0
      ? `; ${scopeSummary.mis_scope_smells.length} mis-scope warning(s)`
      : "") +
    ".";

  return {
    updated: {
      ...bundle,
      repo_manifest: repoManifest,
      file_disposition: disposition,
    },
    artifacts_written: artifactsWritten,
    progress_summary: progressSummary,
    scope_summary: scopeSummary,
  };
}
