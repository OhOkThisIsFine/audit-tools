// sites-pinned: tests/audit/review-run-lifecycle.test.ts
import type { AuditState } from "../types/auditState.js";

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
