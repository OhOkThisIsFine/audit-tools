export interface ArtifactMetadataEntry {
  revision: number;
  content_hash: string;
  dependency_revisions: Record<string, number>;
}

export interface ArtifactMetadataManifest {
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
}
