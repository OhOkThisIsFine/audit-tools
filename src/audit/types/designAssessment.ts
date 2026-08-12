import type { Finding } from "../types.js";

/**
 * A design-review submission that was refused — its top-level shape did not
 * match "a JSON array of findings" (nor its tolerant
 * single-array-wrapped-object unwrap), or there was no assessment to merge it
 * into yet. Quarantined rather than silently discarded (the
 * `malformed-submission-destroys-work` fix). Recorded on `DesignAssessment`
 * so it survives the same-call `continue` re-derivation and the re-emitted
 * design-review step can name the quarantined file + reason. Cleared for a
 * given `pass` the next time that pass is validly consumed.
 */
export interface RejectedDesignReviewSubmission {
  pass: "legacy" | "contract" | "conceptual";
  /**
   * The lane the submission arrived on. Names the lane, not a filename: the
   * bound path is a digest, which would tell an operator nothing.
   */
  lane: string;
  /** Absolute path the malformed submission was moved to. */
  quarantine_path: string;
  /** Human-readable shape-mismatch description. */
  reason: string;
  /** ISO-8601 timestamp of the rejection. */
  rejected_at: string;
}

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
  /** Malformed submissions quarantined instead of merged, pending a valid resubmission. */
  rejected_submissions?: RejectedDesignReviewSubmission[];
}
