// sites-pinned: tests/remediate/result-submit.test.ts
import { StateStore } from "../state/store.js";
import { currentHostBoundaryState, requireStateRunId } from "../state/runIdentity.js";
import { submitRemediationHostResult, type RemediationSubmitReport } from "./dispatch/hostHandoff.js";

/**
 * Submit one work item's result by its id (decision 4, 2026-11-06): the shared
 * core of `remediate-code submit` and the MCP submit tool. The run id and the
 * state come from the run's own store, never from the caller.
 */
export async function submitRemediationWorkItemResult(params: {
  readonly root: string;
  readonly artifactsDir: string;
  readonly workItemId: string;
  readonly source: string;
}): Promise<RemediationSubmitReport> {
  const state = await new StateStore(params.artifactsDir).loadState();
  if (state === null) {
    throw new Error("no remediation run exists here — call `remediate-code next-step` to start one");
  }
  return submitRemediationHostResult({
    root: params.root,
    artifactsDir: params.artifactsDir,
    runId: requireStateRunId(state),
    state: currentHostBoundaryState(state),
    workItemId: params.workItemId,
    source: params.source,
  });
}
