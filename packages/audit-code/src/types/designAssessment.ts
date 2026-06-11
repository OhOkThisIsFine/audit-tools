import type { Finding } from "../types.js";

export interface DesignAssessment {
  generated_at: string;
  findings: Finding[];
  /** @deprecated Use contract_findings instead */
  review_findings?: Finding[];
  /** @deprecated Derived from contract_reviewed && conceptual_reviewed */
  reviewed?: boolean;
  /** Contract-assessment pass (adversarial): inferred_contract_gap, trust_boundary_gap, invariant_counterexample, critical_invariant_coverage_gap */
  contract_findings?: Finding[];
  /** Conceptual-design pass (generative): tool_opportunity, architecture_pattern, design_simplification, integration, missing_capability */
  conceptual_findings?: Finding[];
  /** True when the contract review pass has been completed */
  contract_reviewed?: boolean;
  /** True when the conceptual review pass has been completed */
  conceptual_reviewed?: boolean;
}

/**
 * Derived backward-compat alias: true only when both passes are done.
 */
export function isDesignReviewed(assessment: DesignAssessment): boolean {
  return (
    assessment.contract_reviewed === true &&
    assessment.conceptual_reviewed === true
  );
}
