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
}

export interface RemediationOutcomesReport {
  contract_version: string;
  total: number;
  by_outcome: Record<RemediationOutcomeStatus, number>;
  by_lens: Record<string, Partial<Record<RemediationOutcomeStatus, number>>>;
  outcomes: RemediationOutcome[];
}
