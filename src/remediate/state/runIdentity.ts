// sites-pinned: tests/remediate/friction-capture-closeout.test.ts, tests/remediate/recover-verb-branches.test.ts
import type { CurrentRemediationHostState } from "../steps/dispatch/hostContracts.js";
import { REMEDIATION_STATE_CONTRACT_VERSION, type RemediationState } from "./store.js";

/** Stable run identity for handoff and diagnostic archival; planless state has no shared fallback key. */
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
    contract_version: REMEDIATION_STATE_CONTRACT_VERSION,
    ...state,
  } as CurrentRemediationHostState;
}
