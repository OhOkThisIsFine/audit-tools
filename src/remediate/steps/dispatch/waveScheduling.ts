import type {
  SessionConfig,
  HostConcurrencyLimit,
  WaveSchedule,
  QuotaStateEntry,
  BackoffState,
  ResolvedProviderName,
  DispatchCapacityPoolSummary,
  DiscoveredRateLimitsInput,
  HostModelRosterEntry,
  CapacityPool,
  AdmissionPool,
} from "audit-tools/shared";
import { computeDispatchAdmission, createReservationLedger, tierRank } from "audit-tools/shared";
import { deriveCostRank, lookupConfirmedPosition } from "audit-tools/shared";
import { scheduleWave as computePoolWaveSchedule } from "audit-tools/shared";
import {
  buildQuotaSource,
  HostSessionQuotaSource,
  compareTier,
  buildSourcePools,
  buildHostModelPools,
  resolveHostProviderName,
  resolveConversationHostProvider,
  isDemotableInProcessProvider,
} from "audit-tools/shared";
import {
  REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION,
  type DispatchPhase,
  type RemediationDispatchQuota,
} from "../types.js";
import {
  computeDispatchCapacity,
  resolveHostActiveSubagentLimit,
  readQuotaStateOrDegrade,
  buildProviderModelKey,
  computeBackoffCooldownMs,
  summarizeDispatchCapacityPools,
} from "../../quota/index.js";
export { resolveHostActiveSubagentLimit };
export {
  detectHostActiveSubagentLimit as detectHostConcurrencyFromEnv,
} from "../../quota/hostLimits.js";

// ---------------------------------------------------------------------------
// WaveScheduler types and functions (inlined from waveScheduler.ts)
// waveScheduler.ts is now a thin re-export shim pointing here.
// ---------------------------------------------------------------------------

export type { HostConcurrencyLimit };

const DEFAULT_WAVE_SIZE = 5;

export interface ScheduleWaveInput {
  hostMaxConcurrent?: number | null;
  sessionConfig: SessionConfig | null;
  itemCount: number;
  estimatedSlotTokens?: number[];
  providerName?: ResolvedProviderName;
  hostModel?: string | null;
  /** Context window the host reports for its dispatch model (handshake). */
  hostContextTokens?: number | null;
  /** Output cap the host reports for its dispatch model (handshake). */
  hostOutputTokens?: number | null;
  /**
   * Ordered model roster (lowest rank first) from the multi-rank handshake
   * (`--host-models`); outranks the scalar pair. One capacity pool is built per
   * reported rank, each with its own discovered window.
   */
  hostModels?: HostModelRosterEntry[] | null;
  /**
   * Opaque model identity for the quota key when no model name resolves —
   * a key segment ONLY (`provider/<id>`), never a window authority.
   */
  hostModelId?: string | null;
  env?: NodeJS.ProcessEnv;
}

export function normalizeSlotTokens(tokens: number[] | undefined, count: number): number[] {
  if (!tokens || tokens.length === 0) return new Array(count).fill(0);
  if (tokens.length > count) return tokens.slice(0, count);
  if (tokens.length < count) return [...tokens, ...new Array(count - tokens.length).fill(0)];
  return tokens;
}

export interface WaveScheduleResult extends WaveSchedule {
  host_concurrency_limit: HostConcurrencyLimit | null;
  capacity_pools?: DispatchCapacityPoolSummary[];
}

export function resolveHostConcurrencyLimit(options: {
  hostMaxConcurrent?: number | null;
  sessionConfig: SessionConfig | null;
  env?: NodeJS.ProcessEnv;
}): HostConcurrencyLimit | null {
  return resolveHostActiveSubagentLimit({
    explicitLimit: options.hostMaxConcurrent,
    sessionConfig: options.sessionConfig ?? {},
    env: options.env,
  });
}

function _capacityPoolSummary(
  poolId: string,
  slots: number,
  schedule: WaveSchedule,
): DispatchCapacityPoolSummary {
  return {
    pool_id: poolId,
    slots,
    model: schedule.model,
    confidence: schedule.confidence,
    source: schedule.source,
    resolved_limits: schedule.resolved_limits,
    host_concurrency_limit: schedule.host_concurrency_limit,
    cooldown_until: schedule.cooldown_until,
    estimated_wave_tokens: schedule.estimated_wave_tokens,
    binding_cap: schedule.binding_cap ?? "none",
    quota_source_snapshot: schedule.quota_source_snapshot ?? null,
  };
}

/**
 * Most-capable rank first, so the largest pending items land on the rank with
 * the largest window. Ordering comes from the single shared tier-rank authority
 * (`compareTier`, negated for descending) — no local {small,standard,deep} copy.
 */
function sortRosterMostCapableFirst(
  roster: HostModelRosterEntry[],
): HostModelRosterEntry[] {
  return [...roster].sort((a, b) => compareTier(b.rank, a.rank));
}

/**
 * The host-pool construction preamble shared by `scheduleWave` and
 * `buildConfirmedPools` — single-sourced so the two cannot drift on how they
 * resolve the provider/model identity, the host concurrency limit, the
 * capability window, the learned quota entries, the quota source, and the
 * per-rank host-model pools. Both consumers were maintaining a byte-identical
 * copy of this block; a change to (say) the quota-key segment had to be made in
 * both places or the dispatcher and the rolling driver would size pools
 * differently. Returns the resolved identity/limits AND the built primary pools.
 */
interface HostPoolPreambleInput {
  sessionConfig: SessionConfig | null;
  providerName?: ResolvedProviderName;
  hostModel?: string | null;
  hostMaxConcurrent?: number | null;
  hostContextTokens?: number | null;
  hostOutputTokens?: number | null;
  hostModels?: HostModelRosterEntry[] | null;
  hostModelId?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Optional retained host-session source (the rolling driver threads its own). */
  hostSession?: HostSessionQuotaSource;
}

interface HostPoolPreamble {
  sessionConfig: SessionConfig;
  providerName: ResolvedProviderName;
  hostModel: string | null;
  quotaModelKeySegment: string | null;
  roster: HostModelRosterEntry[] | null;
  hostLimit: HostConcurrencyLimit | null;
  hostContextTokens: number | null;
  hostOutputTokens: number | null;
  hostCapabilityLimits: DiscoveredRateLimitsInput | null;
  quotaEntries: Record<string, QuotaStateEntry>;
  quotaSource: ReturnType<typeof buildQuotaSource>;
  primaryPools: CapacityPool[];
}

async function buildHostPoolPreamble(
  input: HostPoolPreambleInput,
): Promise<HostPoolPreamble> {
  const sessionConfig = input.sessionConfig ?? {};
  const providerName =
    input.providerName ??
    (sessionConfig as { provider?: ResolvedProviderName }).provider ??
    "claude-code";
  const hostModel =
    input.hostModel ??
    (sessionConfig as { block_quota?: { host_model?: string | null } }).block_quota
      ?.host_model ??
    null;
  // Quota-key identity: resolved model name, else the host's opaque id, else
  // null → `provider/*`. Per-roster-rank `model_id` overrides per pool below.
  const quotaModelKeySegment = hostModel ?? input.hostModelId ?? null;
  const roster = input.hostModels?.length
    ? sortRosterMostCapableFirst(input.hostModels)
    : null;

  const hostLimit = resolveHostConcurrencyLimit({
    hostMaxConcurrent: input.hostMaxConcurrent,
    sessionConfig,
    env: input.env,
  });

  // The capability handshake: the host reported its dispatch model's real
  // context/output window this session (the roster's most capable entry under
  // the multi-rank handshake). Carried into the pool's discoveredLimits so the
  // shared discovered_capability rung sizes the budget to the real window
  // instead of the conservative 32k floor. RPM/TPM stay null and fill from the
  // learned quota state.
  const hostContextTokens = input.hostContextTokens ?? roster?.[0]?.context_tokens ?? null;
  const hostOutputTokens = input.hostOutputTokens ?? roster?.[0]?.output_tokens ?? null;
  const hostCapabilityLimits: DiscoveredRateLimitsInput | null =
    hostContextTokens != null || hostOutputTokens != null
      ? { context_tokens: hostContextTokens, output_tokens: hostOutputTokens }
      : null;

  const quotaEntries: Record<string, QuotaStateEntry> = (
    await readQuotaStateOrDegrade("waveScheduler")
  ).entries;

  // The proactive quota snapshot (Claude OAuth source, then learned) so the
  // scheduler can throttle/cooldown from live remaining quota — mirrors
  // audit-code's buildDispatchPool. PREPEND the host-session source keyed on
  // this host pool's own (provider, model) key — first-class PRE-WALL source
  // (graduated remaining_pct → LOW/CRITICAL throttle before a 429), gating on the
  // exact key so it never masks the proactive/learned sources.
  const quotaSource = buildQuotaSource({
    hostSession:
      input.hostSession ??
      new HostSessionQuotaSource({
        providerModelKey: buildProviderModelKey(providerName, quotaModelKeySegment),
      }),
  });

  // One capacity pool per reported roster rank (most capable first), each with
  // its own discovered window and quota key; a single pool for the scalar/absent
  // handshake. Built via the shared host-pool-from-roster core so the pool shape
  // + account-keyed pool ids can't drift across the two consumers.
  const primaryPools = await buildHostModelPools({
    providerName,
    hostModel,
    hostConcurrencyLimit: hostLimit,
    quotaSource,
    quotaEntries,
    roster,
    resolve: (entry) => ({
      poolKey: buildProviderModelKey(providerName, entry?.model_id ?? quotaModelKeySegment),
      discoveredLimits: entry
        ? { context_tokens: entry.context_tokens, output_tokens: entry.output_tokens }
        : hostCapabilityLimits,
    }),
  });

  return {
    sessionConfig,
    providerName,
    hostModel,
    quotaModelKeySegment,
    roster,
    hostLimit,
    hostContextTokens,
    hostOutputTokens,
    hostCapabilityLimits,
    quotaEntries,
    quotaSource,
    primaryPools,
  };
}

export async function scheduleWave(input: ScheduleWaveInput): Promise<WaveScheduleResult> {
  const sessionConfig = input.sessionConfig ?? {};
  const providerName = input.providerName ?? (sessionConfig as { provider?: ResolvedProviderName }).provider ?? "claude-code";
  const hostModel = input.hostModel ?? (sessionConfig as { block_quota?: { host_model?: string | null } }).block_quota?.host_model ?? null;
  // Quota-key identity: resolved model name, else the host's opaque id, else
  // null → `provider/*`. Per-roster-rank `model_id` overrides per pool below.
  const quotaModelKeySegment = hostModel ?? input.hostModelId ?? null;
  const roster = input.hostModels?.length
    ? sortRosterMostCapableFirst(input.hostModels)
    : null;

  const hostLimit = resolveHostConcurrencyLimit({
    hostMaxConcurrent: input.hostMaxConcurrent,
    sessionConfig,
    env: input.env,
  });

  // The capability handshake: the host reported its dispatch model's real
  // context/output window this session (the roster's most capable entry under
  // the multi-rank handshake). Carried into the pool's discoveredLimits so the
  // shared discovered_capability rung sizes the budget to the real window
  // instead of the conservative 32k floor. RPM/TPM stay null and fill from the
  // learned quota state.
  const hostContextTokens = input.hostContextTokens ?? roster?.[0]?.context_tokens ?? null;
  const hostOutputTokens = input.hostOutputTokens ?? roster?.[0]?.output_tokens ?? null;

  const quota = (sessionConfig as { quota?: { enabled?: boolean } }).quota;
  if (!quota || quota.enabled === false) {
    const cap = hostLimit?.active_subagents ?? DEFAULT_WAVE_SIZE;
    const waveSize = Math.max(1, Math.min(cap, input.itemCount));
    // Single-source the quota-off schedule math (wave-token formula + confidence +
    // source) through the shared scheduler so the two orchestrators can't drift —
    // remediate previously re-implemented it with a flat average + confidence:"low",
    // disagreeing with shared's sumTopN + "high". The wave is already capped to
    // `waveSize`, so shared (`requestedConcurrency: waveSize`, no quota) returns it
    // verbatim. Only the roster-honoring window and the DEFAULT_WAVE_SIZE-aware
    // binding_cap are remediate-specific and layered back on top.
    const base = computePoolWaveSchedule({
      providerName,
      sessionConfig,
      hostModel,
      requestedConcurrency: waveSize,
      estimatedSlotTokens: input.estimatedSlotTokens,
      hostConcurrencyLimit: hostLimit,
    });
    const schedule: WaveScheduleResult = {
      ...base,
      resolved_limits: {
        // Honor a host-reported window even with quota disabled; fall back to the
        // shared scheduler's default only when nothing was discovered.
        context_tokens: hostContextTokens ?? base.resolved_limits.context_tokens,
        output_tokens: hostOutputTokens ?? base.resolved_limits.output_tokens,
        requests_per_minute: null,
        input_tokens_per_minute: null,
        output_tokens_per_minute: null,
      },
      host_concurrency_limit: hostLimit,
      // hostLimit-gated: a DEFAULT_WAVE_SIZE cap below itemCount is NOT a host
      // concurrency bind (there is no host limit), so it stays "none".
      binding_cap: hostLimit && waveSize < input.itemCount ? "host_concurrency" : "none",
    };
    return {
      ...schedule,
      capacity_pools: [_capacityPoolSummary(buildProviderModelKey(providerName, quotaModelKeySegment), waveSize, schedule)],
    };
  }

  const preamble = await buildHostPoolPreamble({
    sessionConfig: input.sessionConfig,
    providerName: input.providerName,
    hostModel: input.hostModel,
    hostMaxConcurrent: input.hostMaxConcurrent,
    hostContextTokens: input.hostContextTokens,
    hostOutputTokens: input.hostOutputTokens,
    hostModels: input.hostModels,
    hostModelId: input.hostModelId,
    env: input.env,
  });
  const capacity = computeDispatchCapacity({
    pools: preamble.primaryPools,
    sessionConfig,
    pendingItemTokens: normalizeSlotTokens(input.estimatedSlotTokens, input.itemCount),
  });

  return {
    ...capacity.primary.schedule,
    capacity_pools: summarizeDispatchCapacityPools(capacity),
  };
}

/**
 * Build the confirmed `CapacityPool[]` for a dispatch — one pool per reported
 * roster rank (each with its own discovered window + quota key), or a single
 * conservative pool for the scalar/absent handshake. This is the same pool shape
 * `scheduleWave` constructs internally; it is exposed so the rolling dispatch
 * engine (which is fed `confirmedPools` directly) sizes concurrency from the
 * identical quota inputs, never from a raw host flag. Reused by
 * `driveRollingImplementDispatch`.
 */
export async function buildConfirmedPools(input: {
  sessionConfig: SessionConfig | null;
  hostMaxConcurrent?: number | null;
  hostContextTokens?: number | null;
  hostOutputTokens?: number | null;
  hostModels?: HostModelRosterEntry[] | null;
  hostModelId?: string | null;
  env?: NodeJS.ProcessEnv;
  /**
   * The host-session source the rolling driver RETAINS to feed `recordLimit` and
   * read `isPacketEscalated`. Passed in (not constructed anonymously here) so the
   * driver threads the SAME instance through pool sizing AND the dispatcher's
   * write/read escalation hooks — otherwise the bounded-escalation chain is unfed.
   * Omit on the proactive-sizing-only paths; one is constructed internally.
   */
  hostSession?: HostSessionQuotaSource;
  /** Defect-1: demote the primary in-process backend to a source when an attended host drives. */
  demotePrimaryInProcess?: boolean;
}): Promise<CapacityPool[]> {
  // Defect-1: the ACTUAL configured backend (used to build the demoted source pool) vs
  // the HOST-pool identity. When an attended host demotes a headless backend to a source
  // (codex/opencode/openai-compatible), the host pool must key to the CONVERSATION HOST,
  // not the backend — otherwise the host fan-out is charged against the backend's meter
  // AND collides with the demoted source pool ([[capability-is-per-auditor-not-per-audit]]).
  // B1: the conversation host is auto-detected (codex when inside a Codex session, else
  // claude-code; --host-provider / host_provider overrides), NOT the literal claude-code.
  const actualProviderName = resolveHostProviderName(input.sessionConfig);
  const demoteHostIdentity =
    input.demotePrimaryInProcess === true && isDemotableInProcessProvider(actualProviderName);
  const hostProviderName: ResolvedProviderName = demoteHostIdentity
    ? resolveConversationHostProvider({ sessionConfig: input.sessionConfig })
    : actualProviderName;

  // Resolve identity/limits and build the per-rank host-model pools via the
  // SAME preamble `scheduleWave` uses — the two no longer keep parallel copies.
  const { sessionConfig, quotaSource, quotaEntries, primaryPools } =
    await buildHostPoolPreamble({
      sessionConfig: input.sessionConfig,
      providerName: hostProviderName,
      hostMaxConcurrent: input.hostMaxConcurrent,
      hostContextTokens: input.hostContextTokens,
      hostOutputTokens: input.hostOutputTokens,
      hostModels: input.hostModels,
      hostModelId: input.hostModelId,
      env: input.env,
      hostSession: input.hostSession,
    });

  // Every configured dispatchable backend source (any non-IDE source: NIM/vLLM API,
  // a CLI pool, …) becomes a CapacityPool alongside the primary, so the scheduler's
  // proactive cross-pool spill (INV-QD-14) and the A-8 coordinator can route work to
  // them. Single-sourced in shared (`buildSourcePools`) so audit and remediate surface
  // the IDENTICAL pool shapes — the spill topology can't drift. `primaryProviderName`
  // is the ACTUAL configured backend (not the demoted host identity) so the demoted
  // source is built for the real provider.
  const sourcePools = await buildSourcePools({
    sessionConfig,
    primaryProviderName: actualProviderName,
    quotaSource,
    quotaEntries,
    demotePrimaryInProcess: input.demotePrimaryInProcess,
  });
  primaryPools.push(...sourcePools);

  return primaryPools;
}

/**
 * Build the `AdmissionPool[]` the admission loop admits against from a schedule's
 * per-pool capacity summaries — the remediate analog of audit's `finalizeDispatchQuota`
 * pool mapping (both feed the single-sourced `computeDispatchAdmission`, so the two
 * orchestrators can't drift). Budget = the pool's live remaining token budget
 * (null ⇒ optimistic +Inf); declared cap = its host in-flight cap passed VERBATIM
 * (null ⇒ none — the only place an explicit agent-count exists); cost/capability rank
 * from its tier; capacity = its context window (a packet's input+output envelope must fit).
 */
function admissionPoolsFromSchedule(
  schedule: WaveScheduleResult,
  confirmedCostPositions?: Map<string, number> | null,
): AdmissionPool[] {
  return (schedule.capacity_pools ?? []).map((pool) => {
    // costRank is a REAL cost axis (blended $/Mtok via the shared cost-first
    // engine), decoupled from capabilityRank (still the tier ordinal). See
    // spec/cost-first-routing.md. Rung 1 (operator-confirmed) via the model-keyed
    // map; absent ⇒ price (rung 2) ⇒ tier (rung 3).
    return {
      poolId: pool.pool_id,
      resourceKey: pool.pool_id,
      budget: pool.remaining_token_budget ?? Number.POSITIVE_INFINITY,
      // host subagent limit OR, for an independent backend source, its
      // endpoint-declared concurrency cap (source.quota.max_concurrent).
      declaredCap: pool.host_concurrency_limit?.active_subagents ?? pool.concurrency_cap ?? null,
      costRank: deriveCostRank({
        model: pool.model,
        tier: pool.rank,
        confirmedPosition: lookupConfirmedPosition(confirmedCostPositions, pool.model),
      }),
      capabilityRank: tierRank(pool.rank),
      capacityTokens: pool.resolved_limits.context_tokens,
    };
  });
}

export async function buildDispatchQuota(
  runId: string,
  phase: DispatchPhase,
  schedule: WaveScheduleResult,
  admissionPackets: { id: string; inputTokens: number; complexity: number }[],
  /**
   * Whether to LEASE the granted set against the shared reservation ledger. The
   * host-subagent path passes `true` (the host dispatches the grant across processes,
   * so the tool reserves-before-dispatch and reconciles at accept-node). The
   * in-process rolling engine passes `false`: it admits + leases per-packet itself, so
   * a host-grant lease here would double-count the same work. Mirrors audit's
   * `finalizeDispatchQuota` grantLeases parameterization.
   */
  grantLeases: boolean,
  quotaStateEntry?: QuotaStateEntry | null,
  /**
   * Operator-confirmed cost ordering (rung 1 of costRank; spec/cost-first-routing.md),
   * keyed by model id → 0-based confirmed position. Absent ⇒ price then tier.
   */
  confirmedCostPositions?: Map<string, number> | null,
): Promise<RemediationDispatchQuota> {
  let backoffState: BackoffState | null = null;
  const count = quotaStateEntry?.consecutive_429_count ?? 0;
  if (count > 0) {
    backoffState = {
      consecutive_429_count: count,
      current_cooldown_ms: computeBackoffCooldownMs(count),
    };
  }

  // Admission control: instead of a computed `max_concurrent_agents`, GRANT the
  // affordable admitted set (cost-first-capable, ledger-leased). Per-packet reservation
  // = input estimate + output envelope (declared output cap; the learned ratio refines
  // it once a provider reports usage — dormant on the always-on claude-code host).
  const admission = await computeDispatchAdmission({
    packets: admissionPackets,
    pools: admissionPoolsFromSchedule(schedule, confirmedCostPositions),
    outputCap: schedule.resolved_limits.output_tokens,
    grantLeases,
    ledger: createReservationLedger(),
  });

  return {
    contract_version: REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION,
    run_id: runId,
    phase,
    host_concurrency_limit: schedule.host_concurrency_limit,
    admission,
    estimated_wave_tokens: schedule.estimated_wave_tokens,
    model: schedule.model,
    confidence: schedule.confidence,
    source: schedule.source,
    resolved_limits: schedule.resolved_limits,
    cooldown_until: schedule.cooldown_until,
    binding_cap: schedule.binding_cap ?? "none",
    capacity_pools: schedule.capacity_pools,
    quota_source_snapshot: schedule.quota_source_snapshot ?? null,
    backoff_state: backoffState,
  };
}
