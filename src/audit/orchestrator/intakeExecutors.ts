import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isGitRepo,
  writeJsonFile,
  buildSharedProviderConfirmation,
  writeSharedProviderConfirmation,
  readProviderConfirmationInput,
  gatherDispatchableSources,
  resolveFreshSessionProviderName,
} from "audit-tools/shared";
import type { ArtifactBundle } from "../io/artifacts.js";
import { confirmProviders } from "./providerConfirmation.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
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
  // Walk up ancestor directories (up to 3 levels) looking for a package.json
  // that declares a `workspaces` field. This handles standard nested monorepo
  // layouts like `monorepo-root/packages/my-pkg` where the direct parent
  // (`packages/`) has no package.json of its own. Stop early if a .git
  // boundary is found (we already checked that case under heuristic (a)).
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
      // Stop at a .git boundary — the repo root won't be a workspaces ancestor.
      if (existsSync(join(current, ".git"))) {
        break;
      }
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
    // Missing or malformed package.json — treat as absent for smell purposes.
    return undefined;
  }
}

/**
 * Headless deterministic fallback for the provider confirmation gate — mirrors
 * the `runIntentCheckpointAutoComplete` pattern. The conversation-first flow
 * emits a `provider_confirmation` host step; this runs only when `advanceAudit`
 * is driven headlessly with no host to confirm the provider pool, writing a
 * default provider_confirmation artifact so the pipeline can proceed.
 *
 * DC-2: audit is the single WRITER of the shared session-level confirmation at
 * `<root>/.audit-tools/provider-confirmation.json`. When `root` is known we also
 * write that shared artifact (atomic temp-then-rename under a file lock — CE-003)
 * so a subsequent remediate run can read + honor the same pool. The per-tool
 * `provider_confirmation` bundle field (the N-X06 seam contract) is unchanged;
 * the shared artifact is built from the same auto-discovery and carries the
 * roster snapshot remediate's accessor uses for staleness.
 */
export async function runProviderConfirmationAutoComplete(
  bundle: ArtifactBundle,
  root?: string,
  artifactsDir?: string,
): Promise<ExecutorRunResult> {
  // Load the real session config so a configured API/CLI model is priceable at
  // Gate-0 (cost-first routing; spec/cost-first-routing.md). Degrade to the empty
  // permissive default when it is absent/unreadable — pricing is best-effort and
  // must never block confirmation.
  const sessionConfig = artifactsDir
    ? await loadSessionConfig(artifactsDir).catch(() => ({}))
    : {};
  // Interactive Gate-0: the host may have submitted an operator ordering + host
  // roster to `provider-confirmation.input.json` (spec/cost-first-routing.md).
  // Absent ⇒ the tool's price-ascending suggestion (headless / no-operator path).
  const input = artifactsDir
    ? await readProviderConfirmationInput(artifactsDir)
    : null;
  const confirmation = confirmProviders(
    sessionConfig,
    process.env,
    input?.exclude ?? [],
    input ?? undefined,
  );
  const artifactsWritten = ["provider_confirmation.json"];
  if (root) {
    // Gate-0 source fold: expand every dispatchable source pool (explicit sources[] +
    // repair-proxy /registry) so the confirmed cost ordering the operator approves is
    // exactly what routes. Fail-open — a registry outage yields [] (no source pools).
    const primaryProviderName = resolveFreshSessionProviderName(undefined, sessionConfig, {
      env: process.env,
    });
    const sources = await gatherDispatchableSources(sessionConfig, primaryProviderName);
    await writeSharedProviderConfirmation(
      root,
      buildSharedProviderConfirmation(
        sessionConfig,
        process.env,
        input?.exclude ?? [],
        input?.include ?? [],
        undefined,
        input ?? undefined,
        sources,
      ),
    );
    artifactsWritten.push("provider-confirmation.json");
  }
  return {
    updated: { ...bundle, provider_confirmation: confirmation },
    artifacts_written: artifactsWritten,
    progress_summary: input
      ? "Applied operator provider confirmation (cost ordering + host roster)."
      : "Auto-completed provider confirmation gate (headless).",
  };
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

  // Persist the scope summary alongside the other intake artifacts when we know
  // where the artifacts directory is. Hosts read scope_summary.json directly;
  // the typed `scope_summary` field on ExecutorRunResult is the in-process channel.
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
