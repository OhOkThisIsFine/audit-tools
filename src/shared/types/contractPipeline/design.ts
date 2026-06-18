/**
 * Contract-pipeline artifact: design phase.
 *
 * DesignSpec — proposed design for satisfying the goal.
 * ConceptualDesignCritique — philosophy/alternatives/directions critique.
 */

import type { FindingSeverity } from "../finding.js";

// ── Version constants ────────────────────────────────────────────────────────

export const CONTRACT_PIPELINE_DESIGN_SPEC_VERSION =
  "remediate-code-contract-pipeline/design-spec/v1alpha1" as const;

export const CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION =
  "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1" as const;

// Re-export FindingSeverity for callers that need it alongside design types.
export type { FindingSeverity };

// ── DesignSpec ────────────────────────────────────────────────────────────────

/** Proposed design for satisfying the goal. */
export interface DesignSpecInvariant {
  id: string;
  description: string;
}

/** Optional structured annotation: one module with declared inputs and outputs. */
export interface DesignSpecModule {
  id: string;
  inputs: string[];
  outputs: string[];
}

/** Optional structured annotation: one side effect with a declared owner. */
export interface DesignSpecSideEffect {
  id: string;
  owner: string;
}

/** Optional structured annotation: one external dependency with failure semantics. */
export interface DesignSpecExternalDependency {
  id: string;
  failure_semantics: string;
}

/** Optional structured annotation: one trust boundary with untrusted inputs and a validation ref. */
export interface DesignSpecTrustBoundary {
  id: string;
  untrusted_inputs: string[];
  validation_ref: string;
}

export interface DesignSpec {
  contract_version: typeof CONTRACT_PIPELINE_DESIGN_SPEC_VERSION;
  goal_id: string;
  /** High-level narrative description of the proposed design. */
  design_narrative: string;
  /** Public/module boundaries this design must preserve. */
  invariants: DesignSpecInvariant[];
  /** Affected source paths identified by the design. */
  affected_paths: string[];
  /** ISO-8601 timestamp when this design was created. */
  created_at: string;
  /** Optional: structured module annotations (id, inputs, outputs). */
  modules?: DesignSpecModule[];
  /** Optional: structured side-effect annotations (id, owner). */
  side_effects?: DesignSpecSideEffect[];
  /** Optional: structured external-dependency annotations (id, failure_semantics). */
  external_dependencies?: DesignSpecExternalDependency[];
  /** Optional: structured trust-boundary annotations (id, untrusted_inputs, validation_ref). */
  trust_boundaries?: DesignSpecTrustBoundary[];
}

// ── ConceptualDesignCritique ──────────────────────────────────────────────────

/** Philosophy/alternatives/directions critique of the proposed design. */
export interface DesignCritiqueItem {
  id: string;
  kind: "concern" | "alternative" | "suggestion";
  description: string;
  severity: "blocking" | "advisory";
}

export interface ConceptualDesignCritique {
  contract_version: typeof CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION;
  goal_id: string;
  items: DesignCritiqueItem[];
  /** Overall assessment of the design. */
  verdict: "approved" | "approved_with_concerns" | "rejected";
  /** ISO-8601 timestamp when this critique was created. */
  created_at: string;
}
