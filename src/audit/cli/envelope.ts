// sites-pinned: tests/audit/review-run-lifecycle.test.ts
import type { AuditState } from "../types/auditState.js";

export function buildManualReviewBlocker(emittedStepKind?: string): string {
  if (emittedStepKind !== undefined) {
    return `The current step is ${emittedStepKind}; follow its prompt. Scoped-inspection work is also ready for host execution beside it: complete any available bound work items, write their result contracts, then run next-step again.`;
  }
  return "Semantic-review work is ready for host execution. Complete any available bound work items, write their result contracts, then run next-step again.";
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
