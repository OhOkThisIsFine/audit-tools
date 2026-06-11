export type AuditTopLevelStatus =
  | "not_started"
  | "active"
  | "blocked"
  | "complete";
export type ObligationState =
  | "missing"
  | "present"
  | "stale"
  | "blocked"
  | "satisfied";

export interface AuditObligation {
  id: string;
  state: ObligationState;
  reason?: string;
}

export interface AuditState {
  status: AuditTopLevelStatus;
  last_executor?: string;
  last_obligation?: string;
  blockers?: string[];
  obligations: AuditObligation[];
  /**
   * Set when the rolling dispatch engine fires a partial-completion terminal
   * (empty pool or livelock). Allows synthesis to proceed on partial coverage
   * without hard-gating on `audit_tasks_completed`.
   */
  partial_coverage_terminal?: boolean;
}
