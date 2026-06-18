// Phase 7B — per-finding remediation outcome capture. The remediator emits one
// of these per finding into `remediation-outcomes.json` at close time. This is
// capture/surface only: it records what happened so a human (or a later
// calibration pass) can see how findings of each lens / file type fared. The
// auditor does not consume it automatically.

export type RemediationOutcomeStatus =
  | "resolved"
  | "verified_no_change"
  | "inappropriate"
  | "ignored"
  | "blocked";

export interface RemediationOutcome {
  finding_id: string;
  /** Audit lens the finding came from (free string in the wire contract). */
  lens: string;
  /** Distinct file extensions of the finding's affected files (e.g. [".ts"]). */
  file_exts: string[];
  outcome: RemediationOutcomeStatus;
  /** How many times the item was sent back for rework before this outcome. */
  rework_count: number;
  /** The run's closing-action status (e.g. "success", "failed"). */
  closing_status: string;
  /** Human-readable explanation for non-success closing statuses. */
  closing_status_reason?: string;
  /**
   * For non-resolved outcomes: the failure or rationale text (e.g. why a
   * finding was deemed inappropriate, ignored, or blocked). Absent for
   * `resolved` and `verified_no_change` outcomes.
   */
  reason?: string;
  /** ISO-8601 timestamp when work on this item first left pending. */
  started_at?: string;
  /** ISO-8601 timestamp when the item reached its terminal status. */
  completed_at?: string;
  /** Milliseconds between completed_at and started_at when both are present. */
  duration_ms?: number;
}

export interface RemediationOutcomesReport {
  contract_version: string;
  total: number;
  by_outcome: Record<RemediationOutcomeStatus, number>;
  by_lens: Record<string, Partial<Record<RemediationOutcomeStatus, number>>>;
  /** Earliest item started_at across all outcomes. */
  started_at?: string;
  /** Latest item completed_at across all outcomes. */
  completed_at?: string;
  /** Milliseconds between aggregate completed_at and started_at. */
  duration_ms?: number;
  outcomes: RemediationOutcome[];
}
