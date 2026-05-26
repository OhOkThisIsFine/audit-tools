import type { SessionConfig } from "../types/sessionConfig.js";
import type {
  DispatchPhase,
  RemediationDispatchQuota,
} from "./types.js";
import { REMEDIATION_DISPATCH_QUOTA_CONTRACT_VERSION } from "./types.js";
import {
  scheduleWave as scheduleWaveQuota,
  resolveHostActiveSubagentLimit,
  readQuotaState,
  buildProviderModelKey,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
} from "../quota/index.js";
import type {
  HostConcurrencyLimit,
  WaveSchedule,
  QuotaStateEntry,
  BackoffState,
} from "../quota/types.js";
import type { ResolvedProviderName } from "../types/sessionConfig.js";

export type { HostConcurrencyLimit } from "../quota/types.js";

const DEFAULT_WAVE_SIZE = 5;

export { resolveHostActiveSubagentLimit };
export {
  detectHostActiveSubagentLimit as detectHostConcurrencyFromEnv,
} from "../quota/hostLimits.js";

export interface ScheduleWaveInput {
  hostMaxConcurrent?: number | null;
  sessionConfig: SessionConfig | null;
  itemCount: number;
  estimatedTokensPerItem?: number;
  estimatedSlotTokens?: number[];
  providerName?: ResolvedProviderName;
  hostModel?: string | null;
  env?: NodeJS.ProcessEnv;
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
    const avgTokens = input.estimatedTokensPerItem ?? 0;
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
  } catch {
    // Best-effort: proceed without learned state
  }

  const schedule = scheduleWaveQuota({
    providerName,
    sessionConfig,
    hostModel,
    requestedConcurrency: input.itemCount,
    estimatedSlotTokens: input.estimatedSlotTokens,
    estimatedPacketTokens: input.estimatedTokensPerItem,
    quotaStateEntry,
    hostConcurrencyLimit: hostLimit,
  });

  return schedule;
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
