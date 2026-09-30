// sites-pinned: tests/remediate/friction-capture-closeout.test.ts, tests/remediate/recover-verb-branches.test.ts
import type { CurrentRemediationHostState } from "../steps/dispatch/hostContracts.js";
import type { RemediationState } from "./store.js";

/**
 * The run's friction-record key: the plan id, or `null` when there is no plan.
 *
 * There is DELIBERATELY no fallback key. A fallback ("run") is a path every
 * planless state shares, and `decideFrictionTriage` MATERIALIZES the record it
 * is handed — so a planless caller could MINT a fresh empty record under it,
 * which the close gate then blocks on. That is the 2026-08-24 defect exactly.
 *
 * The key is therefore the plan id or nothing, and a caller handed `null` has
 * no walk to key: the walk ran before the close archived the plan-keyed record,
 * and the plan is where its identity came from.
 */
export function stateRunId(state: RemediationState | null): string | null {
  return state?.plan?.plan_id ?? null;
}

/**
 * The run key for a caller holding a LOADED state that must carry a plan id —
 * the host-handoff/ingest paths, whose contracts declare `run_id: string`.
 *
 * It throws rather than inventing a key: an absent plan id there is a
 * reachable-but-unexpected state, and silently falling back would mint a
 * shared path exactly as the fallback key did. Callers that can legitimately
 * hold a planless state use {@link stateRunId} and handle the `null`.
 */
export function requireStateRunId(state: RemediationState): string {
  const runId = stateRunId(state);
  if (!runId) {
    throw new Error("remediate: a loaded state with no plan id cannot name a run");
  }
  return runId;
}


export function currentHostBoundaryState(
  state: RemediationState,
): CurrentRemediationHostState {
  return {
    contract_version: "remediate-code-state/v1alpha1",
    ...state,
  } as CurrentRemediationHostState;
}
