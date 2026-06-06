import type {
  SessionConfig,
  HostConcurrencyLimit,
  WaveSchedule,
  QuotaStateEntry,
  BackoffState,
  ResolvedProviderName,
} from "@audit-tools/shared";
import type {
  DispatchPhase,
  RemediationDispatchQuota,
} from "./types.js";
import { REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION } from "./types.js";
import {
  computeDispatchCapacity,
  resolveHostActiveSubagentLimit,
  readQuotaState,
  buildProviderModelKey,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
} from "../quota/index.js";

export type { HostConcurrencyLimit } from "@audit-tools/shared";

const DEFAULT_WAVE_SIZE = 5;

export { resolveHostActiveSubagentLimit };
export {
  detectHostActiveSubagentLimit as detectHostConcurrencyFromEnv,
} from "../quota/hostLimits.js";

export interface ScheduleWaveInput {
  hostMaxConcurrent?: number | null;
  sessionConfig: SessionConfig | null;
  itemCount: number;
  /**
   * Per-slot estimated tokens (one entry per worker slot). The canonical
   * token-estimate input — drives the TPM budget in the quota path and the
   * `estimated_wave_tokens` figure in the default path. (Replaces the former
   * `estimatedTokensPerItem` scalar, which overlapped this and was dropped.)
   */
  estimatedSlotTokens?: number[];
  providerName?: ResolvedProviderName;
  hostModel?: string | null;
  env?: NodeJS.ProcessEnv;
}

/**
 * Normalize a caller-supplied `tokens` array to exactly `count` entries.
 * - undefined/empty → all-zeros array of length `count`
 * - too long → truncate to `count`
 * - too short → zero-pad the tail to `count`
 * - exact match → return as-is
 */
export function normalizeSlotTokens(tokens: number[] | undefined, count: number): number[] {
  if (!tokens || tokens.length === 0) return new Array(count).fill(0);
  if (tokens.length > count) return tokens.slice(0, count);
  if (tokens.length < count) return [...tokens, ...new Array(count - tokens.length).fill(0)];
  return tokens;
}

/** Average of the per-slot token estimates (0 when none are supplied). */
function averageSlotTokens(estimatedSlotTokens?: number[]): number {
  if (!estimatedSlotTokens || estimatedSlotTokens.length === 0) return 0;
  const total = estimatedSlotTokens.reduce((a, b) => a + b, 0);
  return Math.floor(total / estimatedSlotTokens.length);
}

export interface WaveScheduleResult extends WaveSchedule {
  wave_size: number;
  estimated_wave_tokens: number;
  host_concurrency_limit: HostConcurrencyLimit | null;
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

export async function scheduleWave(input: ScheduleWaveInput): Promise<WaveScheduleResult> {
  const sessionConfig = input.sessionConfig ?? {};
  const providerName = input.providerName ?? sessionConfig.provider as ResolvedProviderName ?? "claude-code";
  const hostModel = input.hostModel ?? sessionConfig.block_quota?.host_model ?? null;

  const hostLimit = resolveHostConcurrencyLimit({
    hostMaxConcurrent: input.hostMaxConcurrent,
    sessionConfig,
    env: input.env,
  });

  const quota = sessionConfig.quota;
  if (!quota || quota.enabled === false) {
    const cap = hostLimit?.active_subagents ?? DEFAULT_WAVE_SIZE;
    const waveSize = Math.max(1, Math.min(cap, input.itemCount));
    const avgTokens = averageSlotTokens(input.estimatedSlotTokens);
    return {
      wave_size: waveSize,
      estimated_wave_tokens: waveSize * avgTokens,
      cooldown_until: null,
      confidence: "low",
      source: "default",
      resolved_limits: {
        context_tokens: 32_000,
        output_tokens: 4_096,
        requests_per_minute: null,
        input_tokens_per_minute: null,
        output_tokens_per_minute: null,
      },
      host_concurrency_limit: hostLimit,
      model: hostModel,
    };
  }

  let quotaStateEntry: QuotaStateEntry | null = null;
  try {
    const key = buildProviderModelKey(providerName, hostModel);
    const state = await readQuotaState();
    quotaStateEntry = state.entries[key] ?? null;
  } catch (err) {
    // Best-effort: proceed without learned state
    process.stderr.write(`[waveScheduler] readQuotaState failed; falling back to default wave size. ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // Size dispatch through the shared capacity model (single host pool today;
  // mirrors audit-code). The full pending layout is the ambition; the pool's
  // current limits reduce it to real capacity.
  const capacity = computeDispatchCapacity({
    pools: [
      {
        id: buildProviderModelKey(providerName, hostModel),
        providerName,
        hostModel,
        hostConcurrencyLimit: hostLimit,
        quotaStateEntry,
      },
    ],
    sessionConfig,
    pendingItemTokens: normalizeSlotTokens(input.estimatedSlotTokens, input.itemCount),
  });

  return capacity.primary.schedule;
}

export function buildDispatchQuota(
  runId: string,
  phase: DispatchPhase,
  schedule: WaveScheduleResult,
  quotaStateEntry?: QuotaStateEntry | null,
): RemediationDispatchQuota {
  let backoffState: BackoffState | null = null;
  const count = quotaStateEntry?.consecutive_429_count ?? 0;
  if (count > 0) {
    backoffState = {
      consecutive_429_count: count,
      current_cooldown_ms: computeBackoffCooldownMs(count),
      current_failure_weight: computeBackoffFailureWeight(count),
    };
  }

  return {
    contract_version: REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION,
    run_id: runId,
    phase,
    host_concurrency_limit: schedule.host_concurrency_limit,
    wave_size: schedule.wave_size,
    estimated_wave_tokens: schedule.estimated_wave_tokens,
    model: schedule.model,
    confidence: schedule.confidence,
    source: schedule.source,
    resolved_limits: schedule.resolved_limits,
    cooldown_until: schedule.cooldown_until,
    quota_source_snapshot: schedule.quota_source_snapshot ?? null,
    backoff_state: backoffState,
  };
}
