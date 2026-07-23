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
   * Per-edge semantic-slice hashes for the dependency edges registered in
   * `DEPENDENCY_SLICE_PROJECTIONS` (dependencySlices.ts). Recorded on a LISTED
   * re-derivation on EXACTLY the same terms as `dependency_revisions` (an
   * unlisted mismatch-restamp preserves both verbatim). When a projection is
   * registered AND a slice is recorded for an edge, the staleness compare uses
   * `recordedSlice !== currentSlice` for that edge INSTEAD of the whole-hash +
   * revision disjunction — so an upstream change outside the consumed slice no
   * longer phantom-stales the downstream. Absent on old manifests → whole-hash
   * fallback until the next listed re-derive stamps it (conservative).
   */
  dependency_slices?: Record<string, string>;
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

/**
 * Incremental-structure-phase baseline for the git-history mine (T5 #12 — the
 * same content-addressed granular-staleness model, applied to the structure
 * phase's most expensive deterministic operation). The mined `git_history.json`
 * is a pure function of (a) the commit graph reachable from HEAD and (b) the
 * in-scope audited file set; this baseline records both so the structure
 * executor can REUSE the prior mine — skipping the full `git log` walk + O(files²)
 * co-change aggregation — whenever neither moved. A drift in either re-mines
 * (fail-safe).
 */
export interface GitHistoryBaseline {
  /** HEAD commit SHA at the time the carried `git_history.json` was mined. */
  head: string;
  /** Content key of the in-scope audited path set the mine was filtered to. */
  scope_key: string;
}

/**
 * The intent-equivalence baseline (DD-9): the semantic normal forms of
 * `intent_checkpoint.json` that downstreams last derived against, plus the
 * REVISION AUTHORITY for the intent entry. While a gate-current baseline is
 * present, `computeArtifactMetadata` mirrors `intent_checkpoint.json`'s entry
 * revision from `baseline.revision` — so the entry's revision advances ONLY when
 * the intent-equivalence executor commits a resolution (structured delta,
 * judged-`changed` prose delta, or stale gate version), never on a provenance
 * re-confirm or a pending prose judgment. Written ONLY by
 * `intentEquivalenceExecutor` (never by `computeArtifactMetadata`, which only
 * mirrors + carries it) — the single-writer rule that prevents the baseline
 * self-overwriting before a judgment runs.
 */
export interface IntentBaseline {
  /** Structured normal form (schema/scope/lens/filters/… fields) at last resolution. */
  normalized_structured: string;
  /** Prose normal form (scope_summary / intent_summary / free_form_intent) at last resolution. */
  normalized_prose: string;
  /** The intent entry revision as of the last resolution — the revision authority. */
  revision: number;
  /** `computeGateVersion({ judgeId: "host" })` at stamp time; a component mismatch invalidates. */
  gate_version: string;
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
  /**
   * T5 #12 incremental-structure-phase baseline for the git-history mine. Lives
   * HERE — in artifact_metadata, OUTSIDE `git_history.json` — so the structure
   * executor can decide to reuse the prior mine without the artifact carrying its
   * own provenance. Carried forward across runs on the SAME CE-007 F1-current
   * terms as `result_baselines` / `coverage_element_baselines`. See
   * `src/audit/orchestrator/gitHistoryBaseline.ts`.
   */
  git_history_baseline?: GitHistoryBaseline;
  /**
   * DD-9 intent-equivalence baseline. Carried forward across runs on the SAME
   * CE-007 F1-current terms as `result_baselines` (prefer the bundle manifest's
   * freshly-committed copy — the intent-equivalence executor writes it there —
   * over the pre-executor `previous`). See `IntentBaseline` for the
   * revision-authority contract.
   */
  intent_baseline?: IntentBaseline;
}
