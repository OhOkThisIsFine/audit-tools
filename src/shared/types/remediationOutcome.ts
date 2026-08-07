// Phase 7B — per-finding remediation outcome capture. The remediator emits one
// of these per finding into `remediation-outcomes.json` at close time. This is
// capture/surface only: it records what happened so a human (or a later
// calibration pass) can see how findings of each lens / file type fared. The
// auditor does not consume it automatically.

import { z } from "zod";

export const RemediationOutcomeStatusSchema = z.enum([
  "resolved",
  "verified_no_change",
  "inappropriate",
  "ignored",
  "blocked",
]);
export type RemediationOutcomeStatus = z.infer<
  typeof RemediationOutcomeStatusSchema
>;

/**
 * Item C — result of the close-gate mechanical re-verify of an analyzer-born
 * finding. `verified_mechanically`: the finding's content-anchored lead
 * identity no longer fires on a re-run of the same pinned analyzer.
 * `lead_persists`: it still fires (objective evidence routed to triage).
 * `skipped`: the analyzer could not re-run (admission/resolve/spawn/parse) —
 * recorded with the reason, never silently treated as verified.
 */
export const MechanicalVerificationSchema = z
  .object({
    status: z.enum(["verified_mechanically", "lead_persists", "skipped"]),
    analyzer_id: z.string(),
    reason: z.string().optional(),
  })
  .strict();
export type MechanicalVerification = z.infer<typeof MechanicalVerificationSchema>;

export const RemediationOutcomeSchema = z
  .object({
    finding_id: z.string(),
    /** Audit lens the finding came from (free string in the wire contract). */
    lens: z.string(),
    /** Distinct file extensions of the finding's affected files (e.g. [".ts"]). */
    file_exts: z.array(z.string()),
    outcome: RemediationOutcomeStatusSchema,
    /** How many times the item was sent back for rework before this outcome. */
    rework_count: z.number(),
    /** The run's closing-action status (e.g. "success", "failed"). */
    closing_status: z.string(),
    /** Human-readable explanation for non-success closing statuses. */
    closing_status_reason: z.string().optional(),
    /**
     * For non-resolved outcomes: the failure or rationale text (e.g. why a
     * finding was deemed inappropriate, ignored, or blocked). Absent for
     * `resolved` and `verified_no_change` outcomes.
     */
    reason: z.string().optional(),
    /** ISO-8601 timestamp when work on this item first left pending. */
    started_at: z.string().optional(),
    /** ISO-8601 timestamp when the item reached its terminal status. */
    completed_at: z.string().optional(),
    /** Milliseconds between completed_at and started_at when both are present. */
    duration_ms: z.number().optional(),
    /** Item C — mechanical re-verify verdict for analyzer-born findings. */
    mechanical_verification: MechanicalVerificationSchema.optional(),
  })
  .strict();
export type RemediationOutcome = z.infer<typeof RemediationOutcomeSchema>;

// Full count keyed by every status (not Partial): built by summing all 5
// statuses, so each key is always present. An explicit object literal keeps the
// inferred type a complete `Record<RemediationOutcomeStatus, number>` rather
// than the Partial that `z.record(enum, …)` would infer (A6 gotcha).
const RemediationOutcomeCountsSchema = z
  .object({
    resolved: z.number(),
    verified_no_change: z.number(),
    inappropriate: z.number(),
    ignored: z.number(),
    blocked: z.number(),
  })
  .strict();

// NOT strict: the on-disk remediation-outcomes.json is a superset of this shared
// subset (the remediator appends run-level fields like step_count / closing_result
// / plan_coverage). Unknown keys are tolerated so a real artifact still parses.
export const RemediationOutcomesReportSchema = z.object({
  contract_version: z.string(),
  total: z.number(),
  by_outcome: RemediationOutcomeCountsSchema,
  by_lens: z.record(z.string(), RemediationOutcomeCountsSchema.partial()),
  /** Earliest item started_at across all outcomes. */
  started_at: z.string().optional(),
  /** Latest item completed_at across all outcomes. */
  completed_at: z.string().optional(),
  /** Milliseconds between aggregate completed_at and started_at. */
  duration_ms: z.number().optional(),
  outcomes: z.array(RemediationOutcomeSchema),
});
export type RemediationOutcomesReport = z.infer<
  typeof RemediationOutcomesReportSchema
>;
