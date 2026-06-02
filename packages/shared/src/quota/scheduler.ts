import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type {
  HostConcurrencyLimit,
  QuotaStateEntry,
  ResolvedLimits,
  WaveSchedule,
} from "./types.js";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import {
  agentHostFallbackConcurrency,
  classifyProvider,
  resolveLimits,
} from "./limits.js";
import { computeMaxSafeConcurrency, computeRampUpConcurrency } from "./state.js";

/**
 * Minimal structural shape of RPM/TPM limits discovered at runtime (e.g. via
 * response-header extraction). Declared here so the scheduler stays decoupled
 * from any package-specific discovery implementation — callers may pass a
 * richer object (with a `source` field, etc.); only these fields are read.
 */
export interface DiscoveredRateLimitsInput {
  requests_per_minute?: number | null;
  input_tokens_per_minute?: number | null;
  output_tokens_per_minute?: number | null;
}

export interface ScheduleWaveOptions {
  providerName: ResolvedProviderName;
  sessionConfig: SessionConfig;
  hostModel: string | null;
  requestedConcurrency: number;
  /** Per-slot estimated tokens (one entry per worker slot). Used for TPM budget. */
  estimatedSlotTokens?: number[];
  /** @deprecated Use estimatedSlotTokens instead. Average tokens per slot — used as fallback. */
  estimatedPacketTokens?: number;
  quotaStateEntry?: QuotaStateEntry | null;
  hostConcurrencyLimit?: HostConcurrencyLimit | null;
  quotaSourceSnapshot?: QuotaUsageSnapshot | null;
  /** RPM/TPM discovered from provider queries or response header extraction. */
  discoveredLimits?: DiscoveredRateLimitsInput | null;
}

function sumTopN(sorted: number[], n: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(n, sorted.length); i++) sum += sorted[i];
  return sum;
}

export function scheduleWave(options: ScheduleWaveOptions): WaveSchedule {
  const {
    providerName,
    sessionConfig,
    hostModel,
    requestedConcurrency,
    estimatedSlotTokens,
    estimatedPacketTokens = 0,
    quotaStateEntry = null,
    hostConcurrencyLimit = null,
    quotaSourceSnapshot = null,
    discoveredLimits = null,
  } = options;
  // Descending sort so sumTopN picks the largest slots
  const slotsSorted = estimatedSlotTokens
    ? [...estimatedSlotTokens].sort((a, b) => b - a)
    : null;
  const avgTokens = slotsSorted && slotsSorted.length > 0
    ? Math.floor(slotsSorted.reduce((a, b) => a + b, 0) / slotsSorted.length)
    : estimatedPacketTokens;

  const quota = sessionConfig.quota ?? {};

  const applyHostConcurrencyLimit = (waveSize: number): number => {
    if (hostConcurrencyLimit === null) return waveSize;
    return Math.min(waveSize, hostConcurrencyLimit.active_subagents);
  };

  if (quota.enabled === false) {
    const waveSize = Math.max(
      1,
      applyHostConcurrencyLimit(requestedConcurrency),
    );
    const limits: ResolvedLimits = {
      context_tokens: quota.default_context_tokens ?? 32_000,
      output_tokens: quota.reserved_output_tokens ?? 4_096,
      requests_per_minute: null,
      input_tokens_per_minute: null,
      output_tokens_per_minute: null,
    };
    return {
      wave_size: waveSize,
      estimated_wave_tokens: slotsSorted ? sumTopN(slotsSorted, waveSize) : waveSize * avgTokens,
      cooldown_until: null,
      confidence: "high",
      source: "default",
      resolved_limits: limits,
      host_concurrency_limit: hostConcurrencyLimit,
      model: hostModel,
    };
  }

  const safetyMargin = quota.safety_margin ?? 0.8;
  const halfLifeHours = quota.empirical_half_life_hours ?? 24;

  const { limits, source, confidence } = resolveLimits({ providerName, sessionConfig, hostModel });

  // Fill null RPM/TPM from discovered limits (provider query or header extraction)
  if (discoveredLimits) {
    limits.requests_per_minute ??= discoveredLimits.requests_per_minute ?? null;
    limits.input_tokens_per_minute ??= discoveredLimits.input_tokens_per_minute ?? null;
    limits.output_tokens_per_minute ??= discoveredLimits.output_tokens_per_minute ?? null;
  }

  let waveSize = requestedConcurrency;
  let cooldownUntil: string | null = null;

  // Respect an active cooldown period
  if (quotaStateEntry?.cooldown_until) {
    const cooldownExpiry = new Date(quotaStateEntry.cooldown_until).getTime();
    if (cooldownExpiry > Date.now()) {
      cooldownUntil = quotaStateEntry.cooldown_until;
      waveSize = 1;
    }
  }

  if (!cooldownUntil) {
    // Cap by requests-per-minute
    if (limits.requests_per_minute != null) {
      const rpmCap = Math.max(1, Math.floor(limits.requests_per_minute * safetyMargin));
      waveSize = Math.min(waveSize, rpmCap);
    }

    // Cap by input tokens-per-minute
    if (limits.input_tokens_per_minute != null && avgTokens > 0) {
      const tpmBudget = limits.input_tokens_per_minute * safetyMargin;
      if (slotsSorted && slotsSorted.length > 0) {
        let candidateSize = waveSize;
        while (candidateSize > 1 && sumTopN(slotsSorted, candidateSize) > tpmBudget) {
          candidateSize--;
        }
        waveSize = Math.max(1, candidateSize);
      } else {
        const tpmCap = Math.max(1, Math.floor(tpmBudget / avgTokens));
        waveSize = Math.min(waveSize, tpmCap);
      }
    }

    if (quotaStateEntry) {
      const rampUp = quota.ramp_up_enabled !== false;
      const learnedCap = rampUp
        ? computeRampUpConcurrency(quotaStateEntry, halfLifeHours)
        : computeMaxSafeConcurrency(quotaStateEntry, halfLifeHours);
      waveSize = Math.min(waveSize, learnedCap);
    } else if (hostConcurrencyLimit !== null) {
      // The host explicitly reported its active-subagent capacity. That is a
      // real concurrency signal, so it supersedes the conservative
      // unknown-provider fallback (which exists only when we have no signal at
      // all). Leaving waveSize untouched here lets applyHostConcurrencyLimit()
      // below enforce the reported limit as the hard ceiling, while any RPM/TPM
      // caps applied above still bind.
    } else {
      const providerType = classifyProvider(providerName);
      const fallbackCap =
        providerType === "local"
          ? quota.unknown_local_concurrency
          : (quota.unknown_hosted_concurrency ??
            agentHostFallbackConcurrency(providerName));
      if (fallbackCap === "unlimited") {
        // no cap — "unlimited" intentionally skips clamping
      } else if (typeof fallbackCap === "number" && Number.isFinite(fallbackCap)) {
        waveSize = Math.min(waveSize, Math.max(1, Math.floor(fallbackCap)));
      }

      // First-contact cap: when no learned history, no configured fallback, AND
      // no RPM/TPM limits from any source, apply a conservative ceiling.
      // This triggers only for unconfigured local providers (fallbackCap is
      // undefined). Hosted providers default to 1 via unknown_hosted_concurrency,
      // and "unlimited" is an explicit opt-out.
      if (
        fallbackCap == null &&
        limits.requests_per_minute == null &&
        limits.input_tokens_per_minute == null
      ) {
        const firstContactCap = quota.first_contact_concurrency ?? 3;
        waveSize = Math.min(waveSize, Math.max(1, firstContactCap));
      }
    }
  }

  // Apply real-time quota source data if available
  if (quotaSourceSnapshot && !cooldownUntil) {
    if (quotaSourceSnapshot.remaining_pct != null && quotaSourceSnapshot.remaining_pct < 0.1) {
      waveSize = 1;
      if (quotaSourceSnapshot.reset_at) {
        cooldownUntil = quotaSourceSnapshot.reset_at;
      }
    } else if (quotaSourceSnapshot.remaining_pct != null && quotaSourceSnapshot.remaining_pct < 0.3) {
      waveSize = Math.min(waveSize, Math.max(1, Math.floor(waveSize * 0.5)));
    }
  }

  waveSize = applyHostConcurrencyLimit(waveSize);
  waveSize = Math.max(1, waveSize);

  return {
    wave_size: waveSize,
    estimated_wave_tokens: slotsSorted ? sumTopN(slotsSorted, waveSize) : waveSize * avgTokens,
    cooldown_until: cooldownUntil,
    confidence,
    source,
    resolved_limits: limits,
    host_concurrency_limit: hostConcurrencyLimit,
    model: hostModel,
    quota_source_snapshot: quotaSourceSnapshot,
  };
}

/** Build the state key used for indexing quota-state.json entries. */
export function buildProviderModelKey(
  providerName: string,
  hostModel: string | null | undefined,
): string {
  return hostModel ? `${providerName}/${hostModel}` : `${providerName}/*`;
}
