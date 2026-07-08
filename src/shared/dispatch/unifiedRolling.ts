/**
 * Unified in-process rolling driver — the ONE loop both orchestrators drive above
 * the shared `createRollingDispatcher` packet engine.
 *
 * Both audit and remediate previously kept their own driver wrapping the engine:
 * audit's `runRollingDispatch` (a flat single-dispatcher pass + DC-4 livelock/exhaust
 * terminal) and remediate's `driveRollingDispatch` (dependency-level loop, per-level
 * file-ownership sub-waves, rebuild-between-levels). The DUPLICATED part — iterate the
 * levels, split each into disjoint sub-waves, run a dispatcher per sub-wave, collect the
 * results / merged partial-terminal / exhausted-pool set — is unified here. What stays
 * per-orchestrator is the TERMINAL / result-routing layer (audit → coverage/synthesis +
 * DC-4 `exhausted_pool_ids` resume; remediate → accept-node/triage/close + quota_paused
 * merge): those callers adapt this driver's raw result into their own shape.
 *
 * Audit is the READ-ONLY DEGENERATE CASE: it passes a single level of read-only nodes,
 * which `ownershipSubWaves` collapses into one maximal parallel sub-wave (one dispatcher
 * over all packets), so the level/sub-wave machinery no-ops and behaviour matches the old
 * flat pass. See spec + the three-case disjointness model in `ownershipScheduler.ts`.
 */

import type { SessionConfig } from "../types/sessionConfig.js";
import type { CapacityPool, PartialCompletionTerminal } from "../quota/capacity.js";
import { computeDispatchCapacity } from "../quota/capacity.js";
import type { ReservationLedger } from "../quota/reservationLedger.js";
import { createReservationLedger } from "../quota/reservationLedger.js";
import {
  createRollingDispatcher,
  type RollingDispatchPacket,
  type RollingDispatchResult,
} from "./rollingDispatch.js";
import { ownershipSubWaves, type OwnershipSchedulerNode } from "./ownershipScheduler.js";

/**
 * Fold a newly-observed partial-completion terminal into the run's aggregate across
 * sub-waves. Prefers `quota_paused` (retryable) over `empty_pool`; among quota_paused
 * terminals keeps the EARLIEST `earliest_reset_at`; always unions the stranded ids so no
 * stranded node is lost across waves.
 */
function mergePartialTerminals(
  prior: PartialCompletionTerminal | undefined,
  next: PartialCompletionTerminal | null,
): PartialCompletionTerminal | undefined {
  if (!next) return prior;
  if (!prior) return next;
  const strandedIds = [...new Set([...prior.stranded_ids, ...next.stranded_ids])];
  const priorPaused = prior.reason === "quota_paused";
  const nextPaused = next.reason === "quota_paused";
  if (priorPaused || nextPaused) {
    const resets = [prior.earliest_reset_at, next.earliest_reset_at].filter(
      (r): r is string => typeof r === "string",
    );
    const earliest = resets.length > 0 ? resets.sort()[0]! : undefined;
    return {
      reason: "quota_paused",
      stranded_ids: strandedIds,
      ...(earliest ? { earliest_reset_at: earliest } : {}),
    };
  }
  return { reason: prior.reason, stranded_ids: strandedIds };
}

/**
 * Resolve the reservation-ledger admission config for an in-process rolling run.
 * Mirrors the audit host path's admission-pool derivation (`finalizeDispatchQuota`):
 * `computeDispatchCapacity` turns each pool's live quota snapshot + learned slope into a
 * `remaining_token_budget` (a real number where a metered provider reports usage; null
 * where there is no absolute ceiling) and the pool's output window for the envelope.
 *
 * The ledger is wired ONLY when at least one pool has a FINITE absolute budget. On the
 * claude-code host the quota is percent-only and the tokens-per-percent slope never
 * converges, so every budget is null (no absolute ceiling to protect) and the reactive
 * 429 floor is the safety (per spec) — there the ledger stays UNWIRED, adding no
 * per-dispatch lock overhead and no co-located coordination that couldn't gate on
 * anything anyway. A metered provider that reports usage gets the full ledger:
 * reserve-before-dispatch under lock (co-located double-count prevention) + budget
 * gating. See spec/audit/dispatch-admission-control.md.
 */
export function resolveLedgerBudgets(input: {
  pools: CapacityPool[];
  sessionConfig: SessionConfig;
  /** Estimated input tokens per pending packet (sizes the capacity computation). */
  pendingItemTokens: number[];
}): {
  reservationLedger?: ReservationLedger;
  resolvePoolBudget: (poolId: string) => number;
  resolveOutputReservation: (poolId: string) => number;
} {
  const capacity = computeDispatchCapacity({
    pools: input.pools,
    sessionConfig: input.sessionConfig,
    pendingItemTokens: input.pendingItemTokens,
  });
  const budgetByPool = new Map<string, number | null | undefined>();
  const outputByPool = new Map<string, number>();
  let hasFiniteBudget = false;
  for (const alloc of capacity.pools) {
    const budget = alloc.schedule.remaining_token_budget;
    if (typeof budget === "number" && Number.isFinite(budget)) hasFiniteBudget = true;
    budgetByPool.set(alloc.pool_id, budget);
    outputByPool.set(alloc.pool_id, alloc.schedule.resolved_limits.output_tokens);
  }
  return {
    // Only lease when an absolute budget exists to protect (metered provider). No finite
    // budget (claude-code percent-only) ⇒ ledger omitted; the reactive 429 floor is the
    // safety and dispatch stays lock-overhead-free / fully parallel.
    ...(hasFiniteBudget ? { reservationLedger: createReservationLedger() } : {}),
    // null/undefined ⇒ +Inf (no absolute ceiling); a real 0 stays 0 (exhausted).
    resolvePoolBudget: (poolId) => budgetByPool.get(poolId) ?? Number.POSITIVE_INFINITY,
    resolveOutputReservation: (poolId) => outputByPool.get(poolId) ?? 0,
  };
}

/** Configuration for {@link driveRolling}. */
export interface UnifiedRollingConfig<TItem, TPayload> {
  /**
   * Ordered dependency levels; each level is a list of schedulable items. A single
   * level with no inter-level boundary (audit) is the degenerate one-level case.
   */
  levels: TItem[][];
  confirmedPools: CapacityPool[];
  sessionConfig: SessionConfig;
  /**
   * Project an item to the ownership-scheduler node used to split the level into
   * file-disjoint sub-waves. Read-only items (`read_only: true`) collapse into one
   * maximal parallel sub-wave; empty `write_paths` is gated conservatively.
   */
  toNode: (item: TItem) => OwnershipSchedulerNode;
  /** Project an item to the dispatchable packet the engine drives. */
  toPacket: (item: TItem) => RollingDispatchPacket<TPayload>;
  /** Per-packet dispatch (host subagent / provider worker). Must resolve, never reject. */
  dispatchPacket: (
    packet: RollingDispatchPacket<TPayload>,
    slot: { providerName: string; hostModel: string | null; poolId: string },
  ) => Promise<RollingDispatchResult<TPayload>>;
  /** Repo root for canonical path identity (INV-SOO-09). Defaults to cwd. */
  root?: string;
  /**
   * Rebuild the upstream surface BETWEEN dependency levels (remediate: the shared
   * `audit-tools/shared` rebuild). Invoked at most once per inter-level boundary and
   * never concurrently with itself (single-flight, CE-001). Omit when there is no
   * inter-level surface to rebuild (audit).
   */
  rebuildBetweenLevels?: () => Promise<void>;
  /** Observe each result as it completes (progress emission, caller bookkeeping). */
  onResult?: (result: RollingDispatchResult<TPayload>) => void;
  /**
   * Reactive cost verification: invoked once per pool when a declared-free pool is
   * first observed charging (the engine has already demoted it). Forwarded to the
   * engine; the consumer wires it to friction emission. Omit to leave demotion silent.
   */
  onCostDrift?: (info: {
    poolId: string;
    observedCostUsd: number;
    declaredCostPerMtok: number;
  }) => void;
  /** Engine escalation hooks (host-session rate-limit accrual + strand-not-requeue read). */
  recordRateLimit?: (packet: RollingDispatchPacket<TPayload>, result: RollingDispatchResult<TPayload>) => void;
  isPacketEscalated?: (packetId: string) => boolean;
  /**
   * Shared reservation ledger for cross-process/account in-flight accounting (admission
   * control). Forwarded to the engine, which admits + leases per-packet. Omit to leave
   * the ledger path inert (behaviour identical to no ledger).
   */
  reservationLedger?: ReservationLedger;
  resolvePoolBudget?: (poolId: string) => number;
  resolveOutputReservation?: (packet: RollingDispatchPacket<TPayload>, poolId: string) => number;
}

/** Per-level results from {@link driveRolling}. */
export interface UnifiedRollingLevelResult<TPayload> {
  /** The level's node ids, in canonical (block_id) order. */
  nodeIds: string[];
  results: RollingDispatchResult<TPayload>[];
}

/** Raw result of a unified rolling run — callers adapt this into their own terminal shape. */
export interface UnifiedRollingResult<TPayload> {
  /** Per-level results, in level order. */
  levels: UnifiedRollingLevelResult<TPayload>[];
  /** Every result across all levels/sub-waves, in completion order. */
  allResults: RollingDispatchResult<TPayload>[];
  /** Inter-level shared rebuilds performed (== levels.length - 1 when >1 level). */
  rebuilds: number;
  /**
   * The engine's partial-completion terminal merged across every sub-wave (quota_paused
   * preferred over empty_pool; earliest reset kept; stranded ids unioned). Absent when
   * every packet completed. Remediate consumes this; audit derives its own livelock
   * terminal from the pending set instead.
   */
  terminal?: PartialCompletionTerminal;
  /**
   * Union of pool ids the engine dropped into its exhausted set across sub-waves — the
   * DC-4 settled-exclusion seed the audit resume path carries. Empty on a clean run.
   */
  exhaustedPoolIds: string[];
}

/**
 * Drive a rolling dispatch run over `levels`, splitting each level into file-ownership
 * disjoint sub-waves and running a dispatcher per sub-wave, rebuilding the upstream
 * surface between levels. Returns the raw materials (per-level results, flat results,
 * merged terminal, exhausted-pool union) for a caller to map into its terminal shape.
 */
export async function driveRolling<TItem, TPayload>(
  config: UnifiedRollingConfig<TItem, TPayload>,
): Promise<UnifiedRollingResult<TPayload>> {
  const out: UnifiedRollingResult<TPayload> = {
    levels: [],
    allResults: [],
    rebuilds: 0,
    exhaustedPoolIds: [],
  };
  const exhausted = new Set<string>();
  // ONE cost-demotion set for the whole drive: a per-sub-wave dispatcher would reset
  // it at every sub-wave/level boundary, letting a lapsed-free pool regain free-first
  // fill each boundary. Sharing it makes a demotion (and its single onCostDrift emit)
  // span the entire run.
  const costDemotedPoolIds = new Set<string>();
  let terminal: PartialCompletionTerminal | undefined;
  let rebuildInFlight = false; // single-flight guard (CE-001)

  for (let levelIndex = 0; levelIndex < config.levels.length; levelIndex++) {
    // Interpose the shared rebuild BEFORE every level after the first. Guarded so it can
    // never run twice or concurrently for the same boundary.
    if (levelIndex > 0 && config.rebuildBetweenLevels) {
      if (rebuildInFlight) {
        throw new Error(
          "driveRolling: shared rebuild already in flight — single-flight invariant violated (CE-001).",
        );
      }
      rebuildInFlight = true;
      try {
        await config.rebuildBetweenLevels();
        out.rebuilds += 1;
      } finally {
        rebuildInFlight = false;
      }
    }

    const level = config.levels[levelIndex]!;
    const nodes = level.map((item) => config.toNode(item));
    const itemByNodeId = new Map<string, TItem>();
    nodes.forEach((node, i) => itemByNodeId.set(node.block_id, level[i]!));

    // File-ownership-disjoint admission (INV-SOO): maximal disjoint sub-waves, ordered by
    // a deterministic block_id tie-break (INV-SOO-08). Read-only nodes collapse into one.
    const subWaves = ownershipSubWaves(nodes, config.root);

    const levelResults: RollingDispatchResult<TPayload>[] = [];
    for (const wave of subWaves) {
      const packets = wave.map((node) => config.toPacket(itemByNodeId.get(node.block_id)!));
      const dispatcher = createRollingDispatcher<TPayload>({
        confirmedPools: config.confirmedPools,
        sessionConfig: config.sessionConfig,
        dispatchPacket: config.dispatchPacket,
        ...(config.recordRateLimit ? { recordRateLimit: config.recordRateLimit } : {}),
        ...(config.isPacketEscalated ? { isPacketEscalated: config.isPacketEscalated } : {}),
        ...(config.reservationLedger ? { reservationLedger: config.reservationLedger } : {}),
        ...(config.resolvePoolBudget ? { resolvePoolBudget: config.resolvePoolBudget } : {}),
        ...(config.resolveOutputReservation
          ? { resolveOutputReservation: config.resolveOutputReservation }
          : {}),
        ...(config.onCostDrift ? { onCostDrift: config.onCostDrift } : {}),
        costDemotedPoolIds,
        onResult: (result) => {
          out.allResults.push(result);
          config.onResult?.(result);
        },
      });
      dispatcher.enqueue(packets);
      levelResults.push(...(await dispatcher.run()));
      terminal = mergePartialTerminals(terminal, dispatcher.getTerminal());
      for (const poolId of dispatcher.getState().exhaustedPoolIds) exhausted.add(poolId);
    }
    out.levels.push({ nodeIds: nodes.map((n) => n.block_id), results: levelResults });
  }

  out.terminal = terminal;
  out.exhaustedPoolIds = [...exhausted];
  return out;
}
