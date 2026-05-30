/**
 * Phase 3 — `--since` delta scope.
 *
 * `scope.json` records how the audit was scoped for a given run: a full audit
 * (the default), or a delta audit measured against a git ref. In delta mode the
 * orchestrator audits only the changed files (`seed_files`) and their nearest
 * graph neighbours (`expanded_files`); every other auditable file inherits its
 * prior completion or is excluded from this run. The artifact is a deterministic
 * function of the inputs (the ref, the changed files, the graph) so the same
 * inputs always yield the same scope, and it is recorded honestly in the report
 * header and the run log. It sits upstream of `coverage_matrix.json` in the
 * staleness DAG.
 */

export interface AuditScopeBudget {
  /**
   * Upper bound on the number of in-scope files (seeds + expanded). Seeds are
   * always retained; expansion stops once this cap is reached.
   */
  max_files: number;
}

export interface AuditScopeManifest {
  /** `full` audits every auditable file; `delta` scopes to a changed neighbourhood. */
  mode: "full" | "delta";
  /** Git ref/SHA the delta was measured against; `null` in full mode. */
  since: string | null;
  /**
   * Changed auditable files (relative to `since`) that exist in the repo
   * manifest. Empty in full mode. Sorted for determinism.
   */
  seed_files: string[];
  /**
   * Auditable files pulled in by deterministic priority-frontier expansion over
   * the dependency graph (graph neighbours of the seeds). Sorted for determinism.
   */
  expanded_files: string[];
  /** The budget applied during expansion. */
  budget: AuditScopeBudget;
  /**
   * Human-readable note when the scope was truncated by the budget, or when a
   * requested `--since` could not be honoured and the run fell back to full.
   */
  dropped_note?: string;
}
