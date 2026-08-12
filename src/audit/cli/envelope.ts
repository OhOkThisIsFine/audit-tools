import type { AuditState } from "../types/auditState.js";
import type { AuditCodeHandoff } from "../supervisor/operatorHandoff.js";

export const ADVANCE_AUDIT_CONTRACT_VERSION = "audit-code/v1alpha1";

export function buildEnvelope(params: {
  audit_state: unknown;
  selected_obligation: string | null;
  selected_executor: string | null;
  progress_made: boolean;
  artifacts_written: string[];
  progress_summary: string;
  next_likely_step: string | null;
  handoff: AuditCodeHandoff;
}) {
  return {
    contract_version: ADVANCE_AUDIT_CONTRACT_VERSION,
    audit_state: params.audit_state,
    selected_obligation: params.selected_obligation,
    selected_executor: params.selected_executor,
    progress_made: params.progress_made,
    artifacts_written: params.artifacts_written,
    progress_summary: params.progress_summary,
    next_likely_step: params.next_likely_step,
    handoff: params.handoff,
  };
}

export function buildManualReviewBlocker(): string {
  return "Semantic-review work is ready for host execution. Complete any available bound work items, write their result contracts, then run next-step again.";
}

/** The semantic-review frontier is executed by the host, never inline. */
export function isSemanticReviewExecutor(id: string | null): boolean {
  return id === "semantic_review_executor";
}

export function buildBlockedAuditState(params: {
  state: AuditState;
  obligationId: string | null;
  executor: string | null;
  blocker: string;
}): AuditState {
  return {
    ...params.state,
    status: "blocked",
    last_executor: params.executor ?? params.state.last_executor,
    last_obligation: params.obligationId ?? params.state.last_obligation,
    blockers: [...new Set([...(params.state.blockers ?? []), params.blocker])],
    obligations: params.state.obligations.map((item) =>
      item.id === params.obligationId
        ? {
            ...item,
            state: "blocked",
            reason: params.blocker,
          }
        : item,
    ),
  };
}
