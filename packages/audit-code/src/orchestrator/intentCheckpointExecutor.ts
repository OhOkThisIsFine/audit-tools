import type { ArtifactBundle } from "../io/artifacts.js";
import type { ExecutorRunResult } from "./executorResult.js";
import type { IntentCheckpoint } from "@audit-tools/shared";
import { resolveAuditScope } from "./scope.js";
import { isAuditExcludedStatus } from "../extractors/disposition.js";

/**
 * Deterministic pre-digest of the audit scope, shown to the host in the
 * `confirm_intent` step and used to seed the headless auto-complete checkpoint.
 * Everything here is computed deterministically from the intake artifacts; the
 * host uses it to confirm the discovered scope and add any exclusions the
 * disposition pass missed (the scope-pollution case).
 */
export interface ScopePreDigest {
  mode: "full" | "delta";
  since: string | null;
  files_in_scope: number;
  /** Top-level directories of in-scope files, with file counts (desc). */
  scope_dirs: Array<{ dir: string; files: number }>;
  /** A sample of files already excluded by the deterministic disposition pass. */
  auto_excluded: Array<{ path: string; status: string }>;
}

const AUTO_EXCLUDED_SAMPLE_LIMIT = 25;

export function computeScopePreDigest(
  bundle: ArtifactBundle,
  root: string,
  since?: string,
): ScopePreDigest {
  const scope = resolveAuditScope({ root, since, bundle });
  const dispositionFiles = bundle.file_disposition?.files ?? [];

  const auditable = dispositionFiles.filter(
    (file) => !isAuditExcludedStatus(file.status),
  );
  const excluded = dispositionFiles.filter((file) =>
    isAuditExcludedStatus(file.status),
  );

  let inScopePaths: string[];
  if (scope.mode === "delta") {
    inScopePaths = [...scope.seed_files, ...scope.expanded_files];
  } else if (auditable.length > 0) {
    inScopePaths = auditable.map((file) => file.path);
  } else {
    inScopePaths = bundle.repo_manifest?.files.map((file) => file.path) ?? [];
  }

  const dirCounts = new Map<string, number>();
  for (const path of inScopePaths) {
    const top = path.split(/[\\/]/)[0] || ".";
    dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
  }
  const scope_dirs = [...dirCounts.entries()]
    .map(([dir, files]) => ({ dir, files }))
    .sort((a, b) => b.files - a.files);

  return {
    mode: scope.mode === "delta" ? "delta" : "full",
    since: scope.since ?? null,
    files_in_scope: inScopePaths.length,
    scope_dirs,
    auto_excluded: excluded
      .slice(0, AUTO_EXCLUDED_SAMPLE_LIMIT)
      .map((file) => ({ path: file.path, status: file.status })),
  };
}

/**
 * Headless deterministic fallback for the intent checkpoint — the analog of
 * `runDesignReviewAutoComplete`. The conversation-first flow instead emits a
 * `confirm_intent` host step (see `cli/confirmIntentStep.ts`); this runs only
 * when `advanceAudit` is driven headlessly with no host to confirm scope,
 * writing a default full-scope checkpoint so the pipeline can proceed.
 */
export function runIntentCheckpointAutoComplete(
  bundle: ArtifactBundle,
  root: string,
  since?: string,
): ExecutorRunResult {
  const preDigest = computeScopePreDigest(bundle, root, since);
  const intent: IntentCheckpoint = {
    schema_version: "intent-checkpoint/v1",
    confirmed_at: new Date().toISOString(),
    confirmed_by: "host",
    scope_summary: `Root: ${root}${preDigest.since ? ` (since ${preDigest.since})` : ""}, files in scope: ${preDigest.files_in_scope}`,
    intent_summary:
      preDigest.mode === "delta"
        ? `delta-audit since ${preDigest.since}`
        : "full-audit",
  };

  return {
    updated: { ...bundle, intent_checkpoint: intent },
    artifacts_written: ["intent_checkpoint.json"],
    progress_summary: `Auto-completed scope/intent checkpoint (headless): ${intent.scope_summary} (${intent.intent_summary}).`,
  };
}
