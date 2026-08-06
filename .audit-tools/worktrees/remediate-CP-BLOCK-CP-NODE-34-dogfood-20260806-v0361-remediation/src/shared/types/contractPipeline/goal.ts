/**
 * Contract-pipeline artifact: goal phase.
 *
 * GoalSpec — normalized, bounded description of the remediation objective.
 * ContextBundle — relevant code and documentation context collected for the goal.
 */

// ── Version constants ────────────────────────────────────────────────────────

export const CONTRACT_PIPELINE_GOAL_SPEC_VERSION =
  "remediate-code-contract-pipeline/goal-spec/v1alpha1" as const;

export const CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION =
  "remediate-code-contract-pipeline/context-bundle/v1alpha1" as const;

// ── GoalSpec ─────────────────────────────────────────────────────────────────

/** Normalized, bounded description of the remediation objective. */
export interface GoalSpec {
  contract_version: typeof CONTRACT_PIPELINE_GOAL_SPEC_VERSION;
  /** Stable identifier for this goal normalization run. */
  goal_id: string;
  /** Single-sentence primary objective. */
  objective: string;
  /** What explicitly lies outside the scope of this change. */
  non_goals: string[];
  /** Success criteria the implementation must satisfy. */
  success_criteria: string[];
  /** Source type that produced this goal spec. */
  source_type: "conversation" | "document" | "structured_audit" | "mixed";
  /** ISO-8601 timestamp when this goal spec was created. */
  created_at: string;
}

// ── ContextBundle ─────────────────────────────────────────────────────────────

/** Relevant code and documentation context collected for the goal. */
export interface ContextBundleEntry {
  path: string;
  kind: "source" | "test" | "config" | "doc";
  /** Brief rationale for why this file is relevant to the goal. */
  relevance_reason: string;
}

export interface ContextBundle {
  contract_version: typeof CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION;
  goal_id: string;
  entries: ContextBundleEntry[];
  /** Free-text summary of the collected context landscape. */
  context_summary: string;
  /** ISO-8601 timestamp when this bundle was created. */
  created_at: string;
}
