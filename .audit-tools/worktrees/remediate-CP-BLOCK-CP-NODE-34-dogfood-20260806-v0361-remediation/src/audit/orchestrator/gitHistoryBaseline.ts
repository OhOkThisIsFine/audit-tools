/**
 * Incremental structure phase (T5 #12 — the content-addressed granular-staleness
 * model, applied to the structure phase's single most expensive deterministic
 * operation: the git-history mine).
 *
 * `runStructureExecutor` re-runs on ANY `repo_manifest` change (one edited file
 * re-stales every structure artifact). The git-history mine — a full
 * `git log --name-only` walk over up to 1000 commits plus O(files²) co-change
 * aggregation per commit — is by far the costliest part, yet its OUTPUT is a
 * pure function of just two inputs:
 *   1. the commit graph reachable from HEAD (working-tree edits never change it —
 *      only a commit / amend / rebase moves HEAD), and
 *   2. the in-scope audited file set the mine is filtered to.
 * So when neither input moved, the prior `git_history.json` is byte-identical and
 * can be reused without spawning git at all.
 *
 * This module records that two-part baseline (`{head, scope_key}`) in
 * `artifact_metadata.git_history_baseline` — OUTSIDE the artifact, exactly like
 * the result / coverage-element baselines — and the structure executor reuses the
 * carried `git_history` iff the live HEAD and scope key both equal the baseline.
 * Any drift (no baseline, HEAD moved, scope changed, git unavailable) re-mines:
 * fail-safe, never falsely preserved.
 */
import { hashContent, stableStringify } from "audit-tools/shared";
import type {
  ArtifactMetadataManifest,
  GitHistoryBaseline,
} from "../types/artifactMetadata.js";
import { METADATA_SCHEMA_VERSION } from "../types/artifactMetadata.js";
import type { FileDisposition } from "audit-tools/shared";
import type { RepoManifest } from "../types.js";
import { gitHistoryInScopeKeys } from "../extractors/gitHistory.js";

/**
 * Content key of the in-scope audited path set the git-history mine is filtered
 * to. Sorted so manifest ordering noise never moves the key; single-sourced off
 * `gitHistoryInScopeKeys` so it can never disagree with the actual filter.
 */
export function deriveGitHistoryScopeKey(
  repoManifest: RepoManifest,
  disposition?: FileDisposition,
): string {
  return hashContent(
    stableStringify([...gitHistoryInScopeKeys(repoManifest, disposition)].sort()),
  );
}

/** Read the carried-forward git-history baseline off the artifact metadata. */
export function readGitHistoryBaseline(
  metadata: ArtifactMetadataManifest | undefined,
): GitHistoryBaseline | undefined {
  return metadata?.git_history_baseline;
}

/**
 * Carry a freshly-recorded git-history baseline onto the bundle's artifact
 * metadata so `computeArtifactMetadata` persists it (the same carry-forward path
 * `result_baselines` / `coverage_element_baselines` use). Returns a new manifest;
 * never mutates the input. Stamps the F1 schema version when seeding a fresh
 * manifest so the CE-007 freshness gate recognizes the store on the next run.
 */
export function withGitHistoryBaseline(
  metadata: ArtifactMetadataManifest | undefined,
  baseline: GitHistoryBaseline,
): ArtifactMetadataManifest {
  return {
    metadata_schema_version: METADATA_SCHEMA_VERSION,
    artifacts: {},
    ...(metadata ?? {}),
    git_history_baseline: baseline,
  };
}

/**
 * Decide whether the prior git-history mine can be reused. Reuse iff a prior
 * `git_history` artifact exists, a prior baseline exists, and BOTH the live HEAD
 * and scope key equal that baseline. Returns the head/scope_key computed for this
 * run so the caller can record a refreshed baseline when it re-mines. A `null`
 * `head` (git unavailable) is never reusable and yields no baseline to record.
 */
export function canReuseGitHistory(params: {
  head: string | null;
  scopeKey: string;
  priorBaseline: GitHistoryBaseline | undefined;
  hasPriorArtifact: boolean;
}): boolean {
  const { head, scopeKey, priorBaseline, hasPriorArtifact } = params;
  return (
    head !== null &&
    hasPriorArtifact &&
    priorBaseline !== undefined &&
    priorBaseline.head === head &&
    priorBaseline.scope_key === scopeKey
  );
}
