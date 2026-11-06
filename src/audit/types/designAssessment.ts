import { z } from "zod";
import type { Finding } from "../types.js";

// sites-pinned: tests/audit/prompt-contract-dogfood-defects.test.ts
/**
 * The categories the deterministic design-assessment producers stamp on their
 * LEADS (`src/audit/extractors/designAssessment.ts`). One home: each producer's
 * emission is typed against it, and the design-review prompts render the
 * categories a confirming reader may keep from it. A reader told "keep the
 * lead's category" while the permitted list named only the pass's own
 * categories dropped confirmed import cycles rather than break either rule.
 */
export const DesignLeadCategorySchema = z.enum([
  "architectural_seam",
  "code_duplication",
  "complexity_hotspot",
  "dependency_cycle",
  "flow_gap",
  "hidden_coupling",
  "hub_module",
  "monolith_unit",
  "orphan_units",
  "risk_concentration",
  "unit_fragmentation",
]);
export type DesignLeadCategory = z.infer<typeof DesignLeadCategorySchema>;

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
  /**
   * The pass whose submission was refused. Exactly the two the tool runs —
   * the pre-split combined pass is retired, so a refusal recorded against it
   * has no producer and no gate that could ever clear it.
   */
  pass: "contract" | "conceptual";
  /**
   * The lane the submission arrived on. Names the lane, not a filename: the
   * bound path is a digest, which would tell an operator nothing.
   */
  lane: string;
  /**
   * Absolute path the malformed submission was moved to, and `null` when the
   * copy to quarantine failed so nothing was written there. Nullable in the
   * PERSISTED record too: a durable rejection that names a path holding no file
   * is worse than one that states plainly that the content was never moved.
   */
  quarantine_path: string | null;
  /** Human-readable shape-mismatch description. */
  reason: string;
  /** ISO-8601 timestamp of the rejection. */
  rejected_at: string;
}

export interface DesignAssessment {
  generated_at: string;
  findings: Finding[];
  /**
   * Contract-assessment pass (adversarial): inferred_contract_gap, trust_boundary_gap, invariant_counterexample, critical_invariant_coverage_gap */
  contract_findings?: Finding[];
  /** Conceptual-design pass (generative); categories are CONCEPTUAL_FINDING_CATEGORIES. */
  conceptual_findings?: Finding[];
  /** True when the contract review pass has been completed */
  contract_reviewed?: boolean;
  /** True when the conceptual review pass has been completed */
  conceptual_reviewed?: boolean;
  /** Malformed submissions quarantined instead of merged, pending a valid resubmission. */
  rejected_submissions?: RejectedDesignReviewSubmission[];
}
