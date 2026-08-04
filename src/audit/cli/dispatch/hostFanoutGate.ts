/**
 * Host fan-out compatibility types.
 *
 * The attended host and llm-relay own provider selection, quota, failover, and
 * concurrency. audit-tools only prepares the prompts and hands the complete
 * fan-out to the host; it must not create local leases, cooldown state, or
 * livelock pauses for that hand-off.
 */

/** One host subagent in a prepared fan-out description. */
export interface HostFanoutUnit {
  id: string;
  estInputBytes: number;
}

export type HostFanoutFamily = "design_review" | "systemic_challenge";

/** Legacy return shape retained for callers that have not yet dropped the old boundary. */
export interface HostFanoutGateOutcome {
  atWall: false;
  livelocked: false;
  earliestResetAt: null;
  reason: null;
  emptyGrantCause: null;
  grantedCount: number;
  requiredCount: number;
  dispatchQuotaPath: null;
  bindingWindow: null;
  perPacketCost: null;
}

/**
 * Compatibility hand-off. This function deliberately has no admission logic:
 * every prepared unit is available to the host/relay, regardless of local quota
 * state, cold-start state, context heuristics, or concurrency observations.
 */
export async function gateHostFanout(params: {
  units: HostFanoutUnit[];
}): Promise<HostFanoutGateOutcome> {
  return {
    atWall: false,
    livelocked: false,
    earliestResetAt: null,
    reason: null,
    emptyGrantCause: null,
    grantedCount: params.units.length,
    requiredCount: params.units.length,
    dispatchQuotaPath: null,
    bindingWindow: null,
    perPacketCost: null,
  };
}
