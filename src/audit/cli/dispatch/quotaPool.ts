import { join } from "node:path";
import { writeJsonFile, buildHostModelPools } from "audit-tools/shared";
import type {
  ProviderRateLimits,
  SessionConfig,
  DispatchModelTier,
  HostModelRosterEntry,
} from "audit-tools/shared";
import { DEFAULT_EMPIRICAL_HALF_LIFE_HOURS } from "audit-tools/shared";
import { buildQuotaSource } from "audit-tools/shared/quota/compositeQuotaSource";
import { HostSessionQuotaSource } from "audit-tools/shared/quota/hostSessionQuotaSource";
import { resolveFreshSessionProviderName } from "../../providers/index.js";
import {
  computeDispatchCapacity,
  buildProviderModelKey,
  resolveHostModel,
  readQuotaState,
  resolveHostActiveSubagentLimit,
  lookupDiscoveredLimits,
  mergeDiscoveredLimits,
  summarizeDispatchCapacityPools,
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
}): Promise<ResolvedDispatchPool> {
  const { sessionConfig, queryLimits, hostActiveSubagentLimit } = params;
  const quotaProviderName = resolveFreshSessionProviderName(undefined, sessionConfig);
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
  const quotaState = await readQuotaState().catch((): { version: 2; entries: Record<string, never> } => ({ version: 2, entries: {} }));
  const hostConcurrencyLimit = resolveHostActiveSubagentLimit({
    explicitLimit: hostActiveSubagentLimit,
    sessionConfig,
  });
  const providerLimits: DiscoveredRateLimits | null =
    await queryLimits?.(hostModel)
      .then((r) => r ? { ...r, source: "provider_query" } : null)
      .catch(() => null)
    ?? null;
  const halfLifeHours =
    sessionConfig.quota?.empirical_half_life_hours ??
    DEFAULT_EMPIRICAL_HALF_LIFE_HOURS;
  // PREPEND the host-session fixed-window source keyed on the host pool's own
  // (provider, model) key, so the operator's account-level session wall is a
  // first-class PRE-WALL source: graduated remaining_pct → LOW/CRITICAL throttle
  // before a hard 429, paused → cooldown. It gates on the exact key, passing
  // through for every other pool, so it never masks the proactive/learned sources.
  const hostSession = new HostSessionQuotaSource({ providerModelKey: quotaProviderKey });
  const quotaSource = buildQuotaSource({ halfLifeHours, hostSession });

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
    };
  }
  return {
    pools,
    hostModel,
    contextBudgetTokens: probeBudget(pools[0]!),
    tierBudgets: null,
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
  perPacketTokens: number[];
  /** Echo of the host's reported roster, when one was given. */
  hostModelRoster?: HostModelRosterEntry[] | null;
  /** Per-tier packet input budgets derived from the roster, when given. */
  tierBudgets?: Record<DispatchModelTier, number> | null;
}): Promise<{
  dispatchQuota: DispatchQuota;
  dispatchQuotaPath: string;
  waveSchedule: ReturnType<typeof computeDispatchCapacity>["primary"]["schedule"];
  dispatchCapacity: ReturnType<typeof computeDispatchCapacity>;
}> {
  const { runId, runDir, sessionConfig, hostModel, perPacketTokens } = params;
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
    pendingItemTokens: perPacketTokens,
  });
  const waveSchedule = dispatchCapacity.primary.schedule;
  const dispatchQuota: DispatchQuota = {
    contract_version: "audit-code-dispatch-quota/v1alpha2",
    run_id: runId,
    model: hostModel,
    resolved_limits: waveSchedule.resolved_limits,
    confidence: waveSchedule.confidence,
    source: waveSchedule.source,
    host_concurrency_limit: waveSchedule.host_concurrency_limit,
    max_concurrent_agents: dispatchCapacity.total_slots,
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
  return { dispatchQuota, dispatchQuotaPath, waveSchedule, dispatchCapacity };
}
