import type {
  SessionConfig,
  HostConcurrencyLimit,
  WaveSchedule,
  QuotaStateEntry,
  BackoffState,
  ResolvedProviderName,
  DispatchCapacityPoolSummary,
  HostModelRosterEntry,
  CapacityPool,
  DispatchExclusion,
  HostPoolPreamble,
} from "audit-tools/shared";
import {
  createReservationLedger,
  admissionPoolsFromSummaries,
  assembleDispatchQuota,
  buildCapabilityFloorCapable,
} from "audit-tools/shared";
import type { DispatchModelTier } from "audit-tools/shared";
import {
  buildHostPoolPreamble,
  buildSourcePools,
  type SourcePoolBuild,
  dedupHostAndSourcePools,
  resolveHostProviderName,
  resolveHostDispatchProviderName,
} from "audit-tools/shared";
import type { HostSessionQuotaSource } from "audit-tools/shared";
import {
  type DispatchPhase,
  type RemediationDispatchQuota,
} from "../types.js";
import {
  computeDispatchCapacity,
  resolveHostActiveSubagentLimit,
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

/**
 * Remediate's draw over the SHARED host-pool assembly core
 * ({@link buildHostPoolPreamble} in `audit-tools/shared`): resolve this mode's provider
 * identity, then let the shared core do the eight-step assembly. The local copy of that
 * preamble is GONE — it and audit's `buildDispatchPool` preamble were the same steps in
 * the same order (including a byte-identical quota-key derivation), which is a fork, not
 * a domain-forced divergence ([[dissolve-auditor-remediator-distinction]]).
 *
 * Per-mode here: the provider default, and the `REMEDIATE_CODE` env namespace (matching
 * `quota/hostLimits.ts`, which already parameterizes exactly this axis).
 */
async function buildRemediateHostPools(input: {
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
}): Promise<HostPoolPreamble & { sessionConfig: SessionConfig }> {
  const sessionConfig = input.sessionConfig ?? {};
  const providerName =
    input.providerName ??
    (sessionConfig as { provider?: ResolvedProviderName }).provider ??
    "claude-code";
  const preamble = await buildHostPoolPreamble({
    sessionConfig,
    providerName,
    explicitHostModel: input.hostModel,
    hostModelId: input.hostModelId,
    envPrefix: "REMEDIATE_CODE",
    quotaStateLabel: "waveScheduler",
    hostActiveSubagentLimit: input.hostMaxConcurrent,
    hostContextTokens: input.hostContextTokens,
    hostOutputTokens: input.hostOutputTokens,
    roster: input.hostModels,
    ...(input.env ? { env: input.env } : {}),
    ...(input.hostSession ? { hostSession: input.hostSession } : {}),
  });
  return { ...preamble, sessionConfig };
}

export async function scheduleWave(input: ScheduleWaveInput): Promise<WaveScheduleResult> {
  const sessionConfig = input.sessionConfig ?? {};

  // ONE scheduling track: always build the host pools and let the shared
  // capacity/admission compute concurrency from live quota + real signals. There
  // is no naive/quota-off branch — quota self-monitoring is not switchable. When
  // the quota source is blind (no live snapshot) the wave stays governed by real
  // signals only and is surfaced loudly at the dispatch site (marshal.ts).
  const preamble = await buildRemediateHostPools({
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
    pools: preamble.pools,
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
  /**
   * Whether the conversation host is an attended dispatcher (H2+H4 collapse): true
   * (the default) includes the host-model pools as members of the eligible set;
   * false (a headless run) builds the SOURCE pools only — "no attended host" is
   * pool-set membership, not a branch flag.
   */
  hostCanDispatch?: boolean;
  /** Operator-excluded + locally-self-spawn-blocked backends (`resolveDispatchExclusion`). */
  excludedBackends?: DispatchExclusion;
}): Promise<SourcePoolBuild> {
  // The ACTUAL configured backend (the primary the fold synthesizes a source for) vs
  // the HOST-pool identity. When the primary is a headless in-process backend it is a
  // WORKER, never the driver: the host pools key to the CONVERSATION HOST (D5,
  // shared `resolveHostDispatchProviderName`, remediate policy `commandWorkers`) —
  // otherwise the host fan-out is charged against the backend's meter
  // ([[capability-is-per-auditor-not-per-audit]]).
  const actualProviderName = resolveHostProviderName(input.sessionConfig);
  const hostProviderName: ResolvedProviderName = resolveHostDispatchProviderName(
    input.sessionConfig,
    { commandWorkers: true },
  );

  // Resolve identity/limits and build the per-rank host-model pools via the SAME
  // shared assembly core `scheduleWave` uses — and that audit uses.
  const { sessionConfig, quotaSource, quotaEntries, pools: primaryPools } =
    await buildRemediateHostPools({
      sessionConfig: input.sessionConfig,
      providerName: hostProviderName,
      hostMaxConcurrent: input.hostMaxConcurrent,
      hostContextTokens: input.hostContextTokens,
      hostOutputTokens: input.hostOutputTokens,
      hostModels: input.hostModels,
      hostModelId: input.hostModelId,
      ...(input.env ? { env: input.env } : {}),
      ...(input.hostSession ? { hostSession: input.hostSession } : {}),
    });

  // Every configured dispatchable backend source (any non-IDE source: NIM/vLLM API,
  // a CLI pool, …) becomes a CapacityPool alongside the primary, so the scheduler's
  // proactive cross-pool spill (INV-QD-14) and the A-8 coordinator can route work to
  // them. Single-sourced in shared (`buildSourcePools`) so audit and remediate surface
  // the IDENTICAL pool shapes — the spill topology can't drift. `primaryProviderName`
  // is the ACTUAL configured backend so the unconditional primary fold builds the
  // source for the real provider; remediate's draw admits command-shaped primaries.
  const { pools: sourcePools, zeroedByExclusion } = await buildSourcePools({
    sessionConfig,
    primaryProviderName: actualProviderName,
    quotaSource,
    quotaEntries,
    commandWorkers: true,
    excludedBackends: input.excludedBackends,
  });

  // Headless: no host pool in the eligible set — the engine drives the source pools.
  // This is the branch where a zeroing is FATAL rather than degrading (there is no
  // host to fall back to), so the fact must survive the early return.
  if (input.hostCanDispatch === false) return { pools: sourcePools, zeroedByExclusion };

  // D1 cross-class dedup: a folded source colliding with the host's pool identity
  // (same provider+account — attended provider=codex=host) keeps exactly ONE pool.
  const dedup = dedupHostAndSourcePools({
    hostPools: primaryPools,
    sourcePools,
    // Remediate policy: command-shaped workers are engine-drivable here (H3).
    commandWorkers: true,
  });
  return { pools: [...dedup.hostPools, ...dedup.sourcePools], zeroedByExclusion };
}

export async function buildDispatchQuota(
  runId: string,
  phase: DispatchPhase,
  schedule: WaveScheduleResult,
  admissionPackets: { id: string; inputTokens: number; complexity: number; requiredTier?: DispatchModelTier }[],
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
  /**
   * Operator-confirmed cost↔speed dispatch bias (λ ∈ [0,1]) from the Gate-0
   * confirmation (spec/dispatch-cost-speed-dial.md). 0/absent ⇒ cost-first (default).
   */
  dispatchBias?: number,
): Promise<RemediationDispatchQuota> {
  let backoffState: BackoffState | null = null;
  const count = quotaStateEntry?.consecutive_429_count ?? 0;
  if (count > 0) {
    backoffState = {
      consecutive_429_count: count,
      current_cooldown_ms: computeBackoffCooldownMs(count),
    };
  }

  // H5: the admission math + contract shape live in the shared emit core; this
  // wrapper keeps only remediate's assembly policy (precomputed schedule, phase,
  // estimated_wave_tokens).
  const pools = admissionPoolsFromSummaries(schedule.capacity_pools ?? [], confirmedCostPositions);
  return assembleDispatchQuota({
    runId,
    pools,
    packets: admissionPackets,
    outputCap: schedule.resolved_limits.output_tokens,
    grantLeases,
    ledger: createReservationLedger(),
    // F4 parity with audit's finalizeDispatchQuota: size-fit AND each packet's
    // RELATIVE capability floor over this batch's pool set (fail-open on unknown).
    capable: buildCapabilityFloorCapable(pools),
    ...(dispatchBias != null ? { dispatchBias } : {}),
    base: {
      phase,
      host_concurrency_limit: schedule.host_concurrency_limit,
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
    },
  });
}
