import type { ArtifactBundle } from "../io/artifacts.js";
import {
  buildFileDisposition,
  isAuditExcludedStatus,
} from "../extractors/disposition.js";
import { buildRepoManifestFromFs } from "../extractors/fsIntake.js";
import { loadIgnoreFile } from "../extractors/ignore.js";
import type { ExecutorRunResult } from "./executorResult.js";

export async function runIntakeExecutor(
  bundle: ArtifactBundle,
  root: string,
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

  return {
    updated: {
      ...bundle,
      repo_manifest: repoManifest,
      file_disposition: disposition,
    },
    artifacts_written: ["repo_manifest.json", "file_disposition.json"],
    progress_summary: `Created intake artifacts for ${repoManifest.files.length} files.`,
  };
}
