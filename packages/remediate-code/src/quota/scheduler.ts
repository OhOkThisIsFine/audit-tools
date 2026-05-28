import type {
  ResolvedProviderName,
  SessionConfig,
  HostConcurrencyLimit,
  QuotaStateEntry,
  ResolvedLimits,
  WaveSchedule,
  QuotaUsageSnapshot,
} from "@audit-tools/shared";
import { classifyProvider, resolveLimits, computeMaxSafeConcurrency, computeRampUpConcurrency } from "@audit-tools/shared";

export interface ScheduleWaveOptions {
  providerName: ResolvedProviderName;
  sessionConfig: SessionConfig;
  hostModel: string | null;
  requestedConcurrency: number;
  estimatedSlotTokens?: number[];
  /** @deprecated Use estimatedSlotTokens instead. Average tokens per slot — used as fallback. */
  estimatedPacketTokens?: number;
  quotaStateEntry?: QuotaStateEntry | null;
  hostConcurrencyLimit?: HostConcurrencyLimit | null;
  quotaSourceSnapshot?: QuotaUsageSnapshot | null;
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
  } = options;
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

  let waveSize = requestedConcurrency;
  let cooldownUntil: string | null = null;

  if (quotaStateEntry?.cooldown_until) {
    const cooldownExpiry = new Date(quotaStateEntry.cooldown_until).getTime();
    if (cooldownExpiry > Date.now()) {
      cooldownUntil = quotaStateEntry.cooldown_until;
      waveSize = 1;
    }
  }

  if (!cooldownUntil) {
    if (limits.requests_per_minute != null) {
      const rpmCap = Math.max(1, Math.floor(limits.requests_per_minute * safetyMargin));
      waveSize = Math.min(waveSize, rpmCap);
    }

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
    } else {
      const providerType = classifyProvider(providerName);
      const fallbackCap =
        providerType === "local"
          ? quota.unknown_local_concurrency
          : (quota.unknown_hosted_concurrency ?? 1);
      if (fallbackCap === "unlimited") {
        // no cap
      } else if (typeof fallbackCap === "number" && Number.isFinite(fallbackCap)) {
        waveSize = Math.min(waveSize, Math.max(1, Math.floor(fallbackCap)));
      }
    }
  }

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

export function buildProviderModelKey(
  providerName: string,
  hostModel: string | null | undefined,
): string {
  return hostModel ? `${providerName}/${hostModel}` : `${providerName}/*`;
}
