import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isGitRepo, writeJsonFile } from "@audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import {
  buildFileDisposition,
  isAuditExcludedStatus,
} from "../extractors/disposition.js";
import { buildRepoManifestFromFs } from "../extractors/fsIntake.js";
import { loadIgnoreFile } from "../extractors/ignore.js";
import type { ExecutorRunResult, ScopeSummary } from "./executorResult.js";

/** Prefix used to carry the scope summary inside `progress_summary` for hosts
 *  that read the step's progress text rather than the `scope_summary.json`
 *  artifact. The loader extracts everything after this marker as JSON. */
export const SCOPE_SUMMARY_PREFIX = "SCOPE_SUMMARY:";

interface PackageJsonShape {
  name?: unknown;
  workspaces?: unknown;
}

/**
 * Detect signals that the resolved audit root may be the *wrong* directory.
 * Two heuristics, returned as zero or more human-readable warnings:
 *
 *  a. No-git-but-ancestor-is-repo — `root` is not a git repo but some ancestor
 *     directory is (you probably targeted a subdirectory instead of the repo
 *     root).
 *  b. Workspace-member — `root` has a `package.json` with a `name`, and its
 *     parent has a `package.json` declaring `workspaces` (you probably want to
 *     audit from the monorepo root).
 *
 * Returns an empty array when the scope looks correct. Never throws.
 */
export function detectMisScopeSmells(root: string): string[] {
  const smells: string[] = [];

  // (a) No .git here, but an ancestor is a git repository.
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

  // (b) Workspace member of a parent monorepo.
  const rootPkg = readPackageJson(root);
  if (rootPkg && rootPkg.name !== undefined) {
    const parent = dirname(root);
    if (parent && parent !== root) {
      const parentPkg = readPackageJson(parent);
      if (parentPkg && parentPkg.workspaces !== undefined) {
        smells.push(
          `root appears to be a workspace member of a parent monorepo at '${parent}' — consider auditing from the monorepo root instead`,
        );
      }
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
    // Missing or malformed package.json — treat as absent for smell purposes.
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
  const disposition = buildFileDisposition(repoManifest);
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

  // Persist the scope summary alongside the other intake artifacts when we know
  // where the artifacts directory is. The typed `scope_summary` field and the
  // progress_summary marker below carry the same data for hosts that don't read
  // the file directly.
  if (artifactsDir) {
    await writeJsonFile(join(artifactsDir, "scope_summary.json"), scopeSummary);
    artifactsWritten.push("scope_summary.json");
  }

  const progressSummary =
    `${SCOPE_SUMMARY_PREFIX}${JSON.stringify(scopeSummary)}\n` +
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
