import type { Finding } from "../../state/types.js";

// ---------------------------------------------------------------------------
// DAG-node field accessors (read promoted node metadata off a Finding)
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
  /** Relative model rank for the node (small | standard | deep). Never a model name. */
  model_tier?: "small" | "standard" | "deep";
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

/** Read the promoted DAG-node overlay fields off a Finding (all optional). */
export function nodeFieldsOf(finding: Finding): DagNodeFields {
  return finding as Finding & DagNodeFields;
}

/**
 * The reconciliation expectations a node must honor (INV-DS-12): the explicit
 * `reconciliation_expectations` when present, else the node's `preconditions`
 * (upstream contracts' declared outputs). Returned as a deduped string list so
 * the renderer can thread them and the disposition can record them.
 */
export function reconciliationExpectationsOf(finding: Finding): string[] {
  const node = nodeFieldsOf(finding);
  const explicit = Array.isArray(node.reconciliation_expectations)
    ? node.reconciliation_expectations
    : [];
  const preconditions = Array.isArray(node.preconditions) ? node.preconditions : [];
  return [...new Set([...explicit, ...preconditions])].filter(
    (s) => typeof s === "string" && s.trim().length > 0,
  );
}
