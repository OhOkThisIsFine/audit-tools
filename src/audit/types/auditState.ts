import type { Obligation } from "audit-tools/shared";

export type AuditTopLevelStatus =
  | "not_started"
  | "active"
  | "blocked"
  | "complete";

// The obligation vocabulary is single-sourced in the shared obligation engine
// (A3). `ObligationState` is re-exported so audit-code call sites keep importing
// it from here; `AuditObligation` is the domain alias of the shared `Obligation`
// ({id, state, reason?}) — same shape, named for the audit context.
export type { ObligationState } from "audit-tools/shared";
export type AuditObligation = Obligation;

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
