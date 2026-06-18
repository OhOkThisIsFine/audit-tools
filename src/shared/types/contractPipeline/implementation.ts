/**
 * Contract-pipeline artifact: implementation phase.
 *
 * ImplementationDAG — directed acyclic graph of implementation tasks.
 */

import type { FindingSeverity } from "../finding.js";

// ── Version constants ────────────────────────────────────────────────────────

export const CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION =
  "remediate-code-contract-pipeline/implementation-dag/v1alpha1" as const;

// Re-export FindingSeverity for callers that need it alongside implementation types.
export type { FindingSeverity };

// ── ImplementationDAG ─────────────────────────────────────────────────────────

/** One node in the implementation DAG. */
export interface ImplementationDAGNode {
  id: string;
  title: string;
  description: string;
  /** Obligation IDs this task satisfies. */
  satisfies_obligations: string[];
  /** Accepted counterexample IDs (from the judge report) this task addresses. */
  addresses_counterexamples?: string[];
  /** Task IDs that must complete before this task starts. */
  depends_on: string[];
  /** Verification obligation IDs that must pass after this task. */
  verification_obligation_ids: string[];
  /** Commands to run to verify this task's output. */
  targeted_commands: string[];
  /** Current status of this task. */
  status: "pending" | "in_progress" | "resolved" | "blocked";
  /** Repo-relative paths this node will modify (write scope). */
  affected_files?: string[];
  /**
   * Repo-relative paths this node will create or modify (declared outputs).
   * Written by the implementation-planning LLM. Promoted to `affected_files`
   * in the extracted plan so the document worker gets a non-degenerate read
   * allowlist. Optional: existing DAGs without it remain valid.
   */
  output_files?: string[];
  /** Repo-relative paths the worker must read (context scope). */
  read_scope?: string[];
  /** Audit lens this node targets (mirrors Finding.lens). */
  lens?: string;
  /** Severity inherited from the driving finding. */
  severity?: FindingSeverity;
  /** Repo-relative files this node is expected to touch (from finalized module contract scope). */
  files_likely_touched?: string[];
  /** Upstream contracts' declared outputs this node depends on (preconditions). */
  preconditions?: string[];
  /** Human-readable description of the concrete changes this node is expected to produce. */
  expected_changes?: string;
  /** Human-readable verification checks beyond targeted_commands. */
  verification?: string[];
}

/** One directed edge in the implementation DAG. */
export interface ImplementationDAGEdge {
  from: string;
  to: string;
  kind: "dependency" | "verification";
}

export interface ImplementationDAG {
  contract_version: typeof CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION;
  goal_id: string;
  nodes: ImplementationDAGNode[];
  edges: ImplementationDAGEdge[];
  /** ISO-8601 timestamp when this DAG was created. */
  created_at: string;
}
