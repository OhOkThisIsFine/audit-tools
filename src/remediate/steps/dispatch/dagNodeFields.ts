// ---------------------------------------------------------------------------
// DAG-node metadata overlay shape
// ---------------------------------------------------------------------------

/**
 * The implementation-DAG node fields `promoteImplementationDagToExtractedPlan`
 * writes onto each Finding (one node ↔ one finding ↔ one block in the contract
 * pipeline). The shared `Finding` type does not declare these overlay fields, so
 * they are read through this structural view rather than added to the shared
 * contract. Every field is optional: a finding sourced from a plain
 * `audit-findings.json` (not the contract pipeline) carries none of them and the
 * seam degrades to the block-level behavior.
 */
export interface DagNodeFields {
  /** Upstream contracts' declared outputs this node builds on. */
  preconditions?: string[];
  /** Human-readable description of the concrete changes the node is expected to produce. */
  expected_changes?: string;
  /** Human-readable verification checks beyond `targeted_commands`. */
  verification?: string[];
  /**
   * Reconciliation expectations carried from seam reconciliation: what an
   * upstream/neighbor contract agreed to provide this node, expressed either as
   * a list of strings or, when richer, as the precondition list. Read tolerantly
   * because the promotion shape can vary across pipeline versions.
   */
  reconciliation_expectations?: string[];
}
