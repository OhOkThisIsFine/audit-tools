/**
 * F1 metadata-shape version (CE-007). The manifest carries this tag so a later
 * run can detect an old-shape (pre-F1) on-disk manifest — one whose
 * `metadata_schema_version` is absent or older than `METADATA_SCHEMA_VERSION` —
 * and fail SAFE to all-stale rather than mis-decode it or false-skip a changed
 * element off a still-matching whole-artifact hash. Bump this whenever the
 * persisted manifest shape changes in a way an older reader cannot safely
 * interpret.
 */
export const METADATA_SCHEMA_VERSION = 1;

export interface ArtifactMetadataEntry {
  revision: number;
  content_hash: string;
  dependency_revisions: Record<string, number>;
  /**
   * F1 per-element (per discriminated-result-coordinate) content keys + verdicts.
   * Keyed by the signature-STABLE `idempotency_key` (the same key the O2 result
   * baseline store uses), mapping to the signature-SENSITIVE `content_key` that
   * drives per-element staleness. Persisted so the staleness DAG is reproducible
   * across runs at per-RESULT granularity, not only whole-artifact. Absent on an
   * old-shape (pre-F1) entry → that artifact's elements fail safe to all-stale.
   */
  element_content_keys?: Record<string, string>;
}

export interface ArtifactMetadataManifest {
  /**
   * F1 metadata-shape tag (CE-007). An absent or lower value than
   * `METADATA_SCHEMA_VERSION` marks an old-shape (pre-F1) manifest → readers fail
   * safe to all-stale.
   */
  metadata_schema_version?: number;
  artifacts: Record<string, ArtifactMetadataEntry>;
  /**
   * O2 ↔ F1 result-baseline store (CE-011 residual fix): per-logical-result
   * baseline `contentKey`, keyed by the signature-STABLE `idempotency_key`. Lives
   * HERE — in artifact_metadata, OUTSIDE the append-only ledger — so element
   * staleness compares a freshly-computed live contentKey against this baseline
   * without ever mutating an immutable ledger record (INV-O2-1 untouched). See
   * `src/audit/orchestrator/resultBaseline.ts`.
   */
  result_baselines?: Record<string, string>;
  /**
   * T5 #12 content-addressed GRANULAR staleness for the coverage matrix:
   * per-coverage-file baseline `contentKey`, keyed by file path. Lives HERE — in
   * artifact_metadata, OUTSIDE the coverage artifact — so the planning executor
   * can preserve completion for files whose audit inputs are unchanged on a
   * re-plan without mutating the coverage matrix. Carried forward across runs
   * exactly like `result_baselines` (same CE-007 F1-current gate). See
   * `src/audit/orchestrator/coverageElementBaseline.ts`.
   */
  coverage_element_baselines?: Record<string, string>;
}
