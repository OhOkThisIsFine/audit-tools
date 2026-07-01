/**
 * audit-code rolling dispatch consumer.
 *
 * Wraps the audit-tools/shared createRollingDispatcher with a higher-level
 * runRollingDispatch function that:
 * 1. Accepts the RollingDispatchEngineContract interface (pinned seam, N-X06).
 * 2. Resolves the provider pool to CapacityPool entries.
 * 3. Delegates livelock detection to detectLivelock from audit-tools/shared.
 * 4. Returns a typed RollingRunResult with termination status.
 */

import type { SessionConfig, PartialCompletionReason } from "audit-tools/shared";
import {
  createRollingDispatcher,
  detectLivelock,
  ROLLING_DISPATCH_ENGINE_VERSION,
} from "audit-tools/shared";
import type {
  RollingDispatchPacket,
  RollingDispatchResult,
  CapacityPool,
} from "audit-tools/shared";
import type { RollingDispatchEngineContract } from "audit-tools/shared";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result returned from runRollingDispatch. */
export interface RollingRunResult<TPacket> {
  /** Schema version constant. */
  schema_version: typeof ROLLING_DISPATCH_ENGINE_VERSION;
  /** Terminal status: complete = all items dispatched; partial = some stranded. */
  status: "complete" | "partial";
  /** All results (success, error, rate_limited, timeout). */
  results: RollingDispatchResult<TPacket>[];
  /** IDs of stranded packets when status === "partial". */
  stranded_ids: string[];
  /** Reason for partial termination (undefined when status === "complete"). */
  partial_reason?: PartialCompletionReason;
  /**
   * Pool ids the engine dropped into its exhausted set this pass (after spill +
   * the reactive 429 re-route both failed to keep them eligible). These are the
   * provider ids that have been *spilled off then exhausted*, and so become the
   * `SettledExclusionSet` the resumable pause carries (DC-4 / INV-S03): on
   * re-discovery they are filtered out of net-new capacity so a pool that already
   * gave up is never re-offered as fresh. Empty when status === "complete".
   */
  exhausted_pool_ids: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the rolling dispatch engine for a set of audit packets.
 *
 * Bridges the pinned RollingDispatchEngineContract (seam contract) to
 * createRollingDispatcher from audit-tools/shared.
 *
 * @param packets          - Items to dispatch (must satisfy RollingDispatchPacket).
 * @param confirmedPools   - Provider pool from provider confirmation (Gate-0).
 * @param sessionConfig    - Active session config.
 * @param contract         - Seam contract override (dispatchItems / onResult / livelockGuard / consumerTerminal).
 * @param dispatchPacket   - The actual per-packet dispatch function (provider-specific).
 */
export async function runRollingDispatch<TPacket>(
  packets: RollingDispatchPacket<TPacket>[],
  confirmedPools: CapacityPool[],
  sessionConfig: SessionConfig,
  contract: Partial<RollingDispatchEngineContract<TPacket>>,
  dispatchPacket: (
    packet: RollingDispatchPacket<TPacket>,
    slot: { providerName: string; hostModel: string | null; poolId: string },
  ) => Promise<RollingDispatchResult<TPacket>>,
): Promise<RollingRunResult<TPacket>> {
  const livelockLimit = contract.livelockGuard ?? 3;
  const allResults: RollingDispatchResult<TPacket>[] = [];
  let consecutiveNoProgress = 0;

  // Pool filtering happens upstream (providerConfirmation). Trust the caller's
  // pool list — a filter that always returns true is a contract lie (INV-07).
  const activePools = confirmedPools;

  if (activePools.length === 0) {
    const strandedIds = packets.map((p) => p.id);
    const status = "partial" as const;
    contract.consumerTerminal?.(status, []);
    return {
      schema_version: ROLLING_DISPATCH_ENGINE_VERSION,
      status,
      results: [],
      stranded_ids: strandedIds,
      partial_reason: "empty_pool",
      // No pool was ever eligible — every confirmed pool is, by definition,
      // unavailable for this run and is settled-excluded so re-discovery must
      // surface genuinely-new capacity to resume.
      exhausted_pool_ids: confirmedPools.map((p) => p.id),
    };
  }

  let dispatchedCount = 0;
  const dispatcher = createRollingDispatcher<TPacket>(
    {
      confirmedPools: activePools,
      sessionConfig,
      dispatchPacket,
      onResult: (result) => {
        allResults.push(result);
        contract.onResult?.(result);
        // Reset no-progress counter on any result.
        consecutiveNoProgress = 0;
        // FND-OBS-99e3a861: emit a structured progress line on each result so
        // operators can monitor dispatch execution without waiting for terminal state.
        dispatchedCount++;
        process.stderr.write(
          JSON.stringify({
            ts: new Date().toISOString(),
            source: "audit-code:rollingDispatch",
            event: "packet_result",
            packet_id: result.packet.id,
            outcome: result.outcome,
            completed: dispatchedCount,
            total: packets.length,
          }) + "\n",
        );
      },
    },
  );

  dispatcher.enqueue(packets);

  // Run the engine — it drives all packets to completion.
  const results = await dispatcher.run();

  // Pools the engine exhausted this pass (spill + reactive re-route already tried
  // and failed to keep them eligible). These seed the resumable pause's settled
  // exclusion set (DC-4) so re-discovery never re-offers them as net-new.
  const exhaustedPoolIds = [...dispatcher.getState().exhaustedPoolIds];

  // Check for livelock post-run (packets that never completed).
  const completedIds = new Set(results.map((r) => r.packet.id));
  const pendingIds = packets.map((p) => p.id).filter((id) => !completedIds.has(id));

  // Re-check for stranded packets via the livelock guard.
  // If pendingIds is non-empty after run(), the engine got stuck.
  const terminal = pendingIds.length > 0
    ? detectLivelock({
        pendingIds,
        consecutiveNoProgressWaves: livelockLimit, // treat any residual as livelock
        noProgressLimit: livelockLimit,
      })
    : null;

  if (terminal) {
    contract.consumerTerminal?.("partial", results);
    return {
      schema_version: ROLLING_DISPATCH_ENGINE_VERSION,
      status: "partial",
      results,
      stranded_ids: terminal.stranded_ids,
      partial_reason: terminal.reason,
      exhausted_pool_ids: exhaustedPoolIds,
    };
  }

  contract.consumerTerminal?.("complete", results);
  return {
    schema_version: ROLLING_DISPATCH_ENGINE_VERSION,
    status: "complete",
    results,
    stranded_ids: [],
    exhausted_pool_ids: exhaustedPoolIds,
  };
}
