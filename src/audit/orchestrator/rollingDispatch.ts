/**
 * audit-code rolling dispatch consumer.
 *
 * The per-orchestrator TERMINAL adapter over the unified shared driver
 * (`driveRolling`): audit is the read-only degenerate case — one level of read-only
 * nodes that collapse into a single maximal parallel sub-wave (one dispatcher over all
 * packets), so the level/sub-wave machinery no-ops and this reproduces the old flat pass.
 * This wrapper adds audit's own terminal layer on top: the `RollingDispatchEngineContract`
 * seam (N-X06), the empty-pool early return, DC-4 livelock detection, and the typed
 * `RollingRunResult` with `exhausted_pool_ids` the resume path carries.
 */

import type { SessionConfig, PartialCompletionReason } from "audit-tools/shared";
import {
  detectLivelock,
  driveRolling,
  resolveLedgerBudgets,
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
  // Admission control: when a metered pool reports a finite absolute budget, the shared
  // reservation ledger leases each packet's cost before dispatch, so two co-located audit
  // runs on one account never collectively over-admit. On the claude-code host (percent-
  // only quota, no finite ceiling) the ledger is omitted and the reactive 429 floor is the
  // safety — no per-dispatch lock overhead, full parallelism.
  const ledgerCfg = resolveLedgerBudgets({
    pools: activePools,
    sessionConfig,
    pendingItemTokens: packets.map((p) => p.estimatedTokens),
  });
  // ONE level of READ-ONLY nodes (audit writes nothing to the target tree), which
  // `ownershipSubWaves` collapses into a single maximal parallel sub-wave — one
  // dispatcher over every packet, identical to the old flat pass. The items ARE the
  // packets (`toPacket` is identity).
  const run = await driveRolling<RollingDispatchPacket<TPacket>, TPacket>({
    levels: [packets],
    confirmedPools: activePools,
    sessionConfig,
    toNode: (packet) => ({ block_id: packet.id, write_paths: [], read_only: true }),
    toPacket: (packet) => packet,
    dispatchPacket,
    ...(ledgerCfg.reservationLedger
      ? {
          reservationLedger: ledgerCfg.reservationLedger,
          resolvePoolBudget: ledgerCfg.resolvePoolBudget,
          resolveOutputReservation: (_packet, poolId) =>
            ledgerCfg.resolveOutputReservation(poolId),
        }
      : {}),
    ...(contract.recordRateLimit ? { recordRateLimit: contract.recordRateLimit } : {}),
    ...(contract.isPacketEscalated ? { isPacketEscalated: contract.isPacketEscalated } : {}),
    onResult: (result) => {
      contract.onResult?.(result);
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
  });

  const results = run.allResults;

  // Pools the engine exhausted this pass (spill + reactive re-route already tried
  // and failed to keep them eligible). These seed the resumable pause's settled
  // exclusion set (DC-4) so re-discovery never re-offers them as net-new.
  const exhaustedPoolIds = run.exhaustedPoolIds;

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
