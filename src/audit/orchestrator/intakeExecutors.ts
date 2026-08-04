import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

/** Detect signals that the resolved audit root may be the wrong directory. */
export function detectMisScopeSmells(root: string): string[] {
  const smells: string[] = [];

  if (!isGitRepo(root)) {
    let current = dirname(root);
    let previous = root;
    while (current && current !== previous) {
      if (existsSync(join(current, ".git"))) {
        smells.push(
          `root has no .git but ancestor '${current}' is a git repository — you may have targeted a subdirectory instead of the repo root`,
        );
        break;
      }
      previous = current;
      current = dirname(current);
    }
  }

  const rootPkg = readPackageJson(root);
  if (rootPkg && rootPkg.name !== undefined) {
    let current = dirname(root);
    let previous = root;
    let levelsChecked = 0;
    const maxLevels = 3;
    while (current && current !== previous && levelsChecked < maxLevels) {
      const ancestorPkg = readPackageJson(current);
      if (ancestorPkg && ancestorPkg.workspaces !== undefined) {
        smells.push(
          `root appears to be a workspace member of a parent monorepo at '${current}' — consider auditing from the monorepo root instead`,
        );
        break;
      }
      if (existsSync(join(current, ".git"))) break;
      previous = current;
      current = dirname(current);
      levelsChecked++;
    }
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

export async function runIntakeExecutor(
  bundle: ArtifactBundle,
  root: string,
  artifactsDir?: string,
): Promise<ExecutorRunResult> {
  const ignore = await loadIgnoreFile(root);
  const repoManifest = await buildRepoManifestFromFs({
    root,
    ignore,
    hash_files: true,
  });
  const disposition = buildFileDisposition(repoManifest, { root });
  const auditableCount = disposition.files.filter(
    (file) => !isAuditExcludedStatus(file.status),
  ).length;

  if (auditableCount === 0) {
    throw new Error(
      `No auditable files found in ${root}. The repository may be empty, generated-only, documentation-only, or filtered by .auditorignore.`,
    );
  }

  const scopeSummary: ScopeSummary = {
    repo_root: root,
    auditable_file_count: auditableCount,
    git_available: isGitRepo(root),
    mis_scope_smells: detectMisScopeSmells(root),
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
