import { dirname, join } from "node:path";
import {
  writeJsonFile,
  buildHostModelPools,
  computeDispatchAdmission,
  createReservationLedger,
  tierRank,
  deriveCostRank,
  throughputScore,
  lookupConfirmedPosition,
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
import { buildQuotaSource } from "audit-tools/shared/quota/compositeQuotaSource";
import {
  HostSessionQuotaSource,
  type HostSessionEscalation,
} from "audit-tools/shared/quota/hostSessionQuotaSource";
import { resolveFreshSessionProviderName } from "../../providers/index.js";
import {
  computeDispatchCapacity,
  buildProviderModelKey,
  resolveHostModel,
  readQuotaStateOrDegrade,
  resolveHostActiveSubagentLimit,
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
  const hostModel = resolveHostModel({
    providerName: quotaProviderName,
    sessionConfig,
    explicitModel: params.hostModel,
    envVar: "AUDIT_CODE_HOST_MODEL",
  });
  // Quota-key identity: the resolved model name when one exists, else the
  // host's opaque `--host-model-id` (a key segment ONLY — never a window
  // authority), else null → `provider/*`. Per-roster-rank `model_id` overrides
  // per pool below.
  const quotaModelKeySegment = hostModel ?? params.hostModelId ?? null;
  const quotaProviderKey = buildProviderModelKey(quotaProviderName, quotaModelKeySegment);
  const quotaState = await readQuotaStateOrDegrade("audit dispatch pool build");
  const hostConcurrencyLimit = resolveHostActiveSubagentLimit({
    explicitLimit: hostActiveSubagentLimit,
    sessionConfig,
  });
  const providerLimits: DiscoveredRateLimits | null =
    await queryLimits?.(hostModel)
      .then((r) => r ? { ...r, source: "provider_query" } : null)
      .catch(() => null)
    ?? null;
  // PREPEND the host-session fixed-window source keyed on the host pool's own
  // (provider, model) key, so the operator's account-level session wall is a
  // first-class PRE-WALL source: graduated remaining_pct → LOW/CRITICAL throttle
  // before a hard 429, paused → cooldown. It gates on the exact key, passing
  // through for every other pool, so it never masks the proactive/learned sources.
  const hostSession = new HostSessionQuotaSource({
    providerModelKey: quotaProviderKey,
    onEscalation: params.onEscalation,
  });
  const quotaSource = buildQuotaSource({ hostSession });

  // The capability handshake limits are merged FIRST so they outrank the
  // queried and cached limits for context/output (the discovered-capability
  // rung then sizes the partition to the real window). RPM/TPM stay null in
  // the capability entry and fill from the queried/cached sources.
  const probeBudget = (pool: CapacityPool): number => {
    const probe = computeDispatchCapacity({
      pools: [pool],
      sessionConfig,
      pendingItemTokens: [],
    });
    const limits = probe.primary.schedule.resolved_limits;
    return Math.max(1, limits.context_tokens - limits.output_tokens);
  };

  // Single-window capability limits (scalar handshake / nothing reported) — defined
  // before `resolve` so the single-pool path can fall back to it.
  const hostCapabilityLimits: DiscoveredRateLimits | null =
    params.hostContextTokens != null || params.hostOutputTokens != null
      ? {
          context_tokens: params.hostContextTokens ?? null,
          output_tokens: params.hostOutputTokens ?? null,
          source: "host_capability",
        }
      : null;

  // The per-tool resolve for the SHARED host-pool-from-roster core: audit's pool key
  // (quotaProviderKey for the single pool; per-rank model_id for a roster) and its
  // richer discovered-limits — the capability handshake merged FIRST (so it outranks
  // context/output) with the queried + learned-cache limits.
  const resolve = async (entry: HostModelRosterEntry | null) => {
    const poolKey = entry?.model_id
      ? buildProviderModelKey(quotaProviderName, entry.model_id)
      : quotaProviderKey;
    const dispatchCachedLimits = await lookupDiscoveredLimits(poolKey).catch(() => null);
    const capability: DiscoveredRateLimits | null = entry
      ? {
          context_tokens: entry.context_tokens,
          output_tokens: entry.output_tokens,
          source: "host_capability",
        }
      : hostCapabilityLimits;
    return {
      poolKey,
      discoveredLimits: mergeDiscoveredLimits(capability, providerLimits, dispatchCachedLimits),
    };
  };

  const roster = params.hostModelRoster ?? null;
  const pools = await buildHostModelPools({
    providerName: quotaProviderName,
    hostModel,
    hostConcurrencyLimit,
    quotaSource,
    quotaEntries: quotaState.entries,
    roster,
    resolve,
  });

  // Audit-specific budget layer on the shared pools: per-tier budgets from a roster,
  // else the single pool's budget shared across every tier.
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
  // the affordable admitted set (cost-first-capable, ledger-leased). Each capacity
  // allocation becomes an admission pool — budget = its live remaining token budget
  // (null → optimistic +Inf); declared cap = its host in-flight cap passed verbatim;
  // cost/capability rank from its tier; capacity = its context window (a packet's
  // input+output envelope must fit). The cheapest capable pool with headroom wins.
  const admissionPools: AdmissionPool[] = dispatchCapacity.pools.map((alloc) => {
    // costRank is a REAL cost axis (blended $/Mtok via the shared cost-first
    // engine), decoupled from capabilityRank (still the tier ordinal). See
    // spec/cost-first-routing.md. Confirmed operator ordering (rung 1) threads in
    // via confirmedPositions keyed by pool_id; absent ⇒ price (rung 2) ⇒ tier (rung 3).
    return {
      poolId: alloc.pool_id,
      resourceKey: alloc.pool_id,
      budget: alloc.schedule.remaining_token_budget ?? Number.POSITIVE_INFINITY,
      // Declared in-flight cap = the shared-host subagent limit OR, for an
      // independent backend source, its endpoint-declared concurrency cap
      // (source.quota.max_concurrent) so admitBatch's cap branch fires for an
      // otherwise-optimistic source.
      declaredCap:
        alloc.schedule.host_concurrency_limit?.active_subagents ??
        alloc.concurrencyCap ??
        null,
      costRank: deriveCostRank({
        model: alloc.schedule.model,
        tier: alloc.rank,
        confirmedPosition: lookupConfirmedPosition(params.confirmedCostPositions, alloc.schedule.model),
      }),
      capabilityRank: tierRank(alloc.rank),
      // Throughput axis (declared signals only) for the cost↔speed dial; consulted
      // only when the operator sets a bias λ>0. See spec/dispatch-cost-speed-dial.md.
      throughputScore: throughputScore({
        inputTokensPerMinute: alloc.schedule.resolved_limits.input_tokens_per_minute,
        requestsPerMinute: alloc.schedule.resolved_limits.requests_per_minute,
      }),
      capacityTokens: alloc.schedule.resolved_limits.context_tokens,
    };
  });
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
