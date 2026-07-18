import { join } from "node:path";
import {
  writeJsonFile,
  buildHostPoolPreamble,
  computeDispatchAdmission,
  createReservationLedger,
  admissionPoolsFromSummaries,
} from "audit-tools/shared";
import type {
  ProviderRateLimits,
  ResolvedProviderName,
  SessionConfig,
  DispatchModelTier,
  HostModelRosterEntry,
  AdmissionPool,
  DispatchAdmission,
} from "audit-tools/shared";
import type { HostSessionQuotaSource } from "audit-tools/shared/quota/hostSessionQuotaSource";
import { type HostSessionEscalation } from "audit-tools/shared/quota/hostSessionQuotaSource";
import { resolveFreshSessionProviderName } from "../../providers/index.js";
import {
  computeDispatchCapacity,
  lookupDiscoveredLimits,
  mergeDiscoveredLimits,
  summarizeDispatchCapacityPools,
  DISPATCH_QUOTA_V1ALPHA3,
} from "../../quota/index.js";
import type {
  CapacityPool,
  DiscoveredRateLimits,
  DispatchQuota,
} from "../../quota/index.js";
import { resolveTierBudgets, TIER_ORDER } from "./tierRouting.js";

// Host quota pool resolution and JIT dispatch-quota finalization.
// buildDispatchPool runs before packetization (quota-before-packetization);
// finalizeDispatchQuota runs after packetization with real per-packet tokens.

export interface ResolvedDispatchPool {
  /**
   * Capacity pools available to this dispatch — one per reported roster rank,
   * or a single pool for the scalar/absent handshake.
   */
  pools: CapacityPool[];
  hostModel: string | null;
  /**
   * Per-packet input-token ceiling for the INITIAL partition: the largest
   * rank's resolved context window minus its reserved output budget. Coherent
   * clusters partition under the most generous window first; the per-tier
   * re-fit pass then re-splits any packet routed to a smaller rank.
   */
  contextBudgetTokens: number;
  /**
   * Per-tier packet input budgets (context − output) when the host reported a
   * model roster; null for the single-window handshake (every tier shares
   * `contextBudgetTokens`).
   */
  tierBudgets: Record<DispatchModelTier, number> | null;
  /**
   * The retained host-session source constructed for this pool's sizing pass.
   * Returned (not just used internally) so a caller can thread the SAME instance
   * into `runRollingDispatch`'s `recordRateLimit`/`isPacketEscalated` hooks —
   * mirroring remediate's pattern where one retained source feeds both pool
   * sizing and the dispatcher's escalation guard.
   */
  hostSession: HostSessionQuotaSource;
}

/**
 * Resolve the dispatching host pool(s) (host-model resolution, quota state
 * lookup, provider-limits query) and probe their resolved context budgets —
 * everything needed to size the JIT graph partition. The pools are reused by
 * `finalizeDispatchQuota` after packetization, so this work happens once.
 *
 * With a host model roster (`--host-models`), one pool is built per reported
 * rank, each with its own discovered window; otherwise the scalar handshake
 * (or nothing) yields the single conservative pool exactly as before.
 *
 * The probe runs `computeDispatchCapacity` with no pending work: resolved limits
 * are model-derived (not work-derived), so the context window is available
 * before any packet exists. This is the quota-before-packetization reorder.
 */
export async function buildDispatchPool(params: {
  sessionConfig: SessionConfig;
  providerName?: ResolvedProviderName | null;
  hostModel: string | null | undefined;
  queryLimits: ((model: string | null) => Promise<ProviderRateLimits | null>) | undefined;
  hostActiveSubagentLimit: number | null | undefined;
  /** Context window the host reports for its dispatch model (handshake). */
  hostContextTokens?: number | null;
  /** Output cap the host reports for its dispatch model (handshake). */
  hostOutputTokens?: number | null;
  /** Ordered model roster (lowest rank first); outranks the scalar pair. */
  hostModelRoster?: HostModelRosterEntry[] | null;
  /** Opaque model identity for the quota key when no model name resolves. */
  hostModelId?: string | null;
  /**
   * Fed to the retained `HostSessionQuotaSource` this pool construction owns —
   * routes a bounded account-wall escalation to the caller's friction chokepoint
   * instead of only the default stderr line. Omit to keep the prior silent-stderr
   * behavior.
   */
  onEscalation?: (escalation: HostSessionEscalation) => void;
}): Promise<ResolvedDispatchPool> {
  const { sessionConfig, queryLimits, hostActiveSubagentLimit } = params;
  const quotaProviderName =
    params.providerName ??
    resolveFreshSessionProviderName(
      sessionConfig.provider === undefined ? "auto" : undefined,
      sessionConfig,
    );

  // Audit's per-tool limits enrichment, layered over the shared assembly core's capability
  // window: the queried provider limits + the learned-cache entry. The capability handshake
  // stays FIRST so it outranks both for context/output (the discovered-capability rung then
  // sizes the partition to the real window); RPM/TPM are null in the capability entry and
  // fill from the queried/cached sources. `queryLimits` is memoized on the FIRST call — it
  // is keyed on the scalar host model, so one query serves every roster rank exactly as
  // before the lift (the pre-lift code called it once, outside the per-rank resolve).
  let providerLimitsPromise: Promise<DiscoveredRateLimits | null> | undefined;
  const getProviderLimits = (hostModel: string | null): Promise<DiscoveredRateLimits | null> => {
    providerLimitsPromise ??=
      queryLimits?.(hostModel)
        .then((r) => (r ? ({ ...r, source: "provider_query" } as DiscoveredRateLimits) : null))
        .catch(() => null) ?? Promise.resolve(null);
    return providerLimitsPromise;
  };

  const preamble = await buildHostPoolPreamble({
    sessionConfig,
    providerName: quotaProviderName,
    explicitHostModel: params.hostModel,
    hostModelId: params.hostModelId,
    envPrefix: "AUDIT_CODE",
    quotaStateLabel: "audit dispatch pool build",
    hostActiveSubagentLimit,
    hostContextTokens: params.hostContextTokens,
    hostOutputTokens: params.hostOutputTokens,
    roster: params.hostModelRoster,
    ...(params.onEscalation ? { onEscalation: params.onEscalation } : {}),
    enrichDiscoveredLimits: async (capability, { poolKey, hostModel }) => {
      const dispatchCachedLimits = await lookupDiscoveredLimits(poolKey).catch(() => null);
      const providerLimits = await getProviderLimits(hostModel);
      // Re-stamp the capability's provenance. The shared core emits the numeric
      // `DiscoveredRateLimitsInput` (no `source` — nothing in limit RESOLUTION reads it;
      // `resolveLimits` derives `source: "discovered_capability"` itself). Audit's
      // `DiscoveredRateLimits` carries `source` as a required provenance tag, so stamp it
      // here rather than casting a value that lacks the field — same value as pre-lift.
      const stamped: DiscoveredRateLimits | null = capability
        ? { ...capability, source: "host_capability" }
        : null;
      return mergeDiscoveredLimits(stamped, providerLimits, dispatchCachedLimits);
    },
  });
  const { pools, hostModel, hostSession } = preamble;

  const probeBudget = (pool: CapacityPool): number => {
    const probe = computeDispatchCapacity({
      pools: [pool],
      sessionConfig,
      pendingItemTokens: [],
    });
    const limits = probe.primary.schedule.resolved_limits;
    return Math.max(1, limits.context_tokens - limits.output_tokens);
  };

  // Audit-specific budget layer on the shared pools: per-tier budgets from a roster,
  // else the single pool's budget shared across every tier.
  const roster = params.hostModelRoster ?? null;
  if (roster && roster.length > 0) {
    const perRank = new Map<DispatchModelTier, number>();
    for (const pool of pools) {
      if (pool.rank) perRank.set(pool.rank, probeBudget(pool));
    }
    const tierBudgets = resolveTierBudgets(perRank);
    return {
      pools,
      hostModel,
      contextBudgetTokens: Math.max(...Object.values(tierBudgets)),
      tierBudgets,
      hostSession,
    };
  }
  return {
    pools,
    hostModel,
    contextBudgetTokens: probeBudget(pools[0]!),
    tierBudgets: null,
    hostSession,
  };
}

/**
 * Compute just-in-time dispatch capacity for the already-resolved pool against
 * the real per-packet token layout, and write the dispatch-quota artifact.
 * Runs AFTER packetization so capacity reflects the actual partitioned packets.
 */
export async function finalizeDispatchQuota(params: {
  runId: string;
  runDir: string;
  sessionConfig: SessionConfig;
  pools: CapacityPool[];
  hostModel: string | null;
  /**
   * The pending packets, in priority order (highest first): the admission loop
   * grants the affordable prefix and defers the rest to a later next-step grant.
   */
  packets: { id: string; inputTokens: number; complexity: number }[];
  /** Echo of the host's reported roster, when one was given. */
  hostModelRoster?: HostModelRosterEntry[] | null;
  /** Per-tier packet input budgets derived from the roster, when given. */
  tierBudgets?: Record<DispatchModelTier, number> | null;
  /**
   * Whether to actually LEASE the granted set against the shared reservation ledger
   * (host-subagent path — the host dispatches the grant across processes, so the
   * tool must reserve-before-dispatch and reconcile at ingest). The IN-PROCESS
   * rolling driver passes `false`: it dispatches every packet through the rolling
   * engine, which admits + leases per-packet itself, so a second host-grant lease
   * here would double-count the same work. Defaults to true (host path).
   */
  grantLeases?: boolean;
  /**
   * Operator-confirmed cost ordering (rung 1 of costRank; spec/cost-first-routing.md),
   * keyed by model id → 0-based confirmed position. Derived from the Gate-0
   * confirmed provider pool. Absent/empty ⇒ costRank falls to real price then tier.
   */
  confirmedCostPositions?: Map<string, number> | null;
  /**
   * Operator-confirmed cost↔speed dispatch bias (λ ∈ [0,1]) from the Gate-0
   * confirmation (spec/dispatch-cost-speed-dial.md). 0/absent ⇒ cost-first (default).
   */
  dispatchBias?: number;
  /**
   * Host fan-out mode (item C): gate the admission purely on TOKEN BUDGET, dropping
   * the cold-start calibration clamp and the concurrency cap. A design-review /
   * systemic panel is a bounded, known set the host dispatches in one turn — not an
   * open-ended packet frontier that needs slope-learning caution (the cold-start
   * probe would clamp every >probe-size panel to a partial grant → the atomic panel
   * could never dispatch = livelock), and the host serializes subagents up to its
   * OWN concurrency cap, so a concurrency shortfall is not an affordability wall. The
   * only legitimate fan-out wall is budget-exhausted (ledger denies) or cooldown.
   */
  fanoutMode?: boolean;
}): Promise<{
  dispatchQuota: DispatchQuota;
  dispatchQuotaPath: string;
  waveSchedule: ReturnType<typeof computeDispatchCapacity>["primary"]["schedule"];
  dispatchCapacity: ReturnType<typeof computeDispatchCapacity>;
  admission: DispatchAdmission;
}> {
  const { runId, runDir, sessionConfig, hostModel } = params;
  // Most-capable rank first: computeDispatchCapacity hands the largest pending
  // items to the first pool, and the biggest packets belong on the rank with
  // the largest window. Unranked pools are the LEAST capable (conservative
  // fallback), so they sort last — not first (COR-eebbabf7: was TIER_ORDER.length
  // which placed them before ranked pools in descending order). The tier ordering
  // is the single shared authority (`TIER_ORDER` === `DISPATCH_TIER_ORDER`); the
  // `-1` unranked-last rule is local to this conservative-fallback sort and is
  // intentionally distinct from rolling-dispatch's neutral-middle fallback.
  const rankOrder = (pool: CapacityPool): number =>
    pool.rank ? TIER_ORDER.indexOf(pool.rank) : -1;
  const pools = [...params.pools].sort((a, b) => rankOrder(b) - rankOrder(a));
  const dispatchCapacity = computeDispatchCapacity({
    pools,
    sessionConfig,
    pendingItemTokens: params.packets.map((p) => p.inputTokens),
  });
  const waveSchedule = dispatchCapacity.primary.schedule;

  // Admission control: instead of reporting a computed `max_concurrent_agents`, GRANT
  // the affordable admitted set (cost-first-capable, ledger-leased). AdmissionPool
  // construction is single-sourced in `admissionPoolsFromSummaries` so audit and
  // remediate cannot drift on how a capacity pool maps to an admission pool — audit
  // summarizes its dispatch capacity, remediate passes its `capacity_pools`, both feed
  // the SAME builder (budget, declaredCap, costRank rung-1, capability, throughput).
  const poolSummaries = summarizeDispatchCapacityPools(dispatchCapacity);
  const admissionPools: AdmissionPool[] = admissionPoolsFromSummaries(
    poolSummaries,
    params.confirmedCostPositions,
  ).map((pool, i) =>
    // Fan-out mode: budget-only gating so an atomic panel dispatches whenever its
    // tokens fit the session budget, and pauses only on a genuine budget/cooldown
    // wall. Two relaxations vs the packet path, both because fan-out is HOST-ONLY
    // (the subagents run on the conversation host — there is no alternative pool to
    // route to): (1) `calibrating:false` drops the cold-start probe clamp that would
    // livelock a panel larger than the probe; (2) `declaredCap:null` drops the
    // concurrency cap (the host serializes subagents past its cap — a concurrency
    // shortfall is not an affordability wall). The former third relaxation
    // (`capacityTokens:+Infinity` unconditionally) is NARROWED (unified-routing
    // step B): the fit gate walls only on a KNOWN window. A real resolved window
    // (confidence medium/high — explicit config, discovered capability) gates
    // honestly: a panel that genuinely cannot fit the host's model window blocks
    // instead of dispatching a guaranteed-overflow prompt. But a LOW-confidence
    // window (blind `default`/`provider_default` floor — 32k is fabricated, not
    // knowledge) keeps the always-fits escape: with no alternative pool, a
    // fabricated wall is a permanent livelock on a panel the host can actually run.
    params.fanoutMode
      ? {
          ...pool,
          calibrating: false,
          declaredCap: null,
          // Hardened (B review F2): the escape ALSO requires the pool to carry no
          // real per-pool window — a source pool with a stamped context_cap_tokens
          // has knowledge regardless of the resolved-limits confidence, and
          // discarding it would readmit the 413 class step A closed. Mechanical,
          // not call-site-convention (fan-out is host-only today, but the guard
          // must not depend on that staying true).
          ...(poolSummaries[i]?.confidence === "low" &&
          poolSummaries[i]?.context_cap_tokens == null
            ? { capacityTokens: Number.POSITIVE_INFINITY }
            : {}),
        }
      : pool,
  );
  // Per-packet reservation = input estimate + output envelope (declared output cap at
  // cold start; the learned (resourceKey,lens) ratio refines it once a provider
  // reports usage — dormant on the always-on claude-code host per design). The
  // admission derivation is single-sourced in `computeDispatchAdmission` so audit and
  // remediate can't drift; `grantLeases: false` (in-process driver) returns the
  // plan-only block (the rolling engine leases per-packet itself, no double-count).
  const admission = await computeDispatchAdmission({
    packets: params.packets,
    pools: admissionPools,
    outputCap: waveSchedule.resolved_limits.output_tokens,
    grantLeases: params.grantLeases !== false,
    ledger: createReservationLedger(),
    ...(params.dispatchBias != null ? { dispatchBias: params.dispatchBias } : {}),
  });

  const dispatchQuota: DispatchQuota = {
    contract_version: DISPATCH_QUOTA_V1ALPHA3,
    run_id: runId,
    model: hostModel,
    resolved_limits: waveSchedule.resolved_limits,
    confidence: waveSchedule.confidence,
    source: waveSchedule.source,
    host_concurrency_limit: waveSchedule.host_concurrency_limit,
    admission,
    cooldown_until: dispatchCapacity.cooldown_until,
    binding_cap: dispatchCapacity.binding_cap,
    capacity_pools: summarizeDispatchCapacityPools(dispatchCapacity),
    ...(params.hostModelRoster?.length
      ? { host_model_roster: params.hostModelRoster }
      : {}),
    ...(params.tierBudgets ? { tier_budgets: params.tierBudgets } : {}),
    quota_source_snapshot: waveSchedule.quota_source_snapshot ?? null,
    backoff_state: null,
  };
  const dispatchQuotaPath = join(runDir, "dispatch-quota.json");
  await writeJsonFile(dispatchQuotaPath, dispatchQuota);
  return { dispatchQuota, dispatchQuotaPath, waveSchedule, dispatchCapacity, admission };
}
