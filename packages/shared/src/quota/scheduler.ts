import type { QuotaConfig, ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type {
  HostConcurrencyLimit,
  QuotaStateEntry,
  ResolvedLimits,
  WaveBindingCap,
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
  quotaStateEntry?: QuotaStateEntry | null;
  hostConcurrencyLimit?: HostConcurrencyLimit | null;
  quotaSourceSnapshot?: QuotaUsageSnapshot | null;
  /** RPM/TPM discovered from provider queries or response header extraction. */
  discoveredLimits?: DiscoveredRateLimitsInput | null;
}

// Named quota tuning defaults (previously inline magic literals). Centralised
// here, the canonical owner of the wave-scheduling math, so callers that read
// the same session-config defaults (e.g. the dispatch CLIs) can reference them
// instead of re-typing the number.
/** Fraction of a discovered RPM/TPM limit we actually schedule against. */
export const DEFAULT_SAFETY_MARGIN = 0.8;
/** Half-life (hours) for decaying learned concurrency evidence. */
export const DEFAULT_EMPIRICAL_HALF_LIFE_HOURS = 24;
/** Conservative ceiling applied on first contact with an unconfigured provider. */
export const DEFAULT_FIRST_CONTACT_CONCURRENCY = 3;
/**
 * Real-time quota-source `remaining_pct` thresholds. At/under CRITICAL we throttle
 * to a single request; at/under LOW we halve the wave.
 */
export const QUOTA_REMAINING_PCT_CRITICAL = 0.1;
export const QUOTA_REMAINING_PCT_LOW = 0.3;
/** Multiplier applied to the wave when remaining quota is in the LOW band. */
const QUOTA_LOW_WAVE_MULTIPLIER = 0.5;

function sumTopN(sorted: number[], n: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(n, sorted.length); i++) sum += sorted[i];
  return sum;
}

/**
 * Compute the wave size after applying the RPM cap, the TPM cap, and exactly one
 * of the learned-limit / unknown-provider-fallback caps — but BEFORE the
 * real-time quota-source adjustment and the host-concurrency ceiling, both of
 * which the caller applies. Pure: it never mutates an outer variable, so each
 * cap is a single `Math.min` at the end of its branch rather than a scattered
 * sequence of reassignments.
 *
 * The host-concurrency limit is deliberately NOT considered here: when the host
 * reports its active-subagent capacity it is enforced as a hard ceiling by
 * `applyHostConcurrencyLimit()` at the call site, so the only effect inside this
 * function is that a reported host limit suppresses the conservative
 * unknown-provider fallback (which exists solely as a no-signal default).
 */
/**
 * Result of the uncapped wave-size computation. `binding_cap` records which of
 * the RPM / TPM / learned / fallback / first-contact caps last reduced the
 * value (or "none" if nothing did), so the caller can attribute the decision.
 * The cooldown and host-concurrency caps are applied by `scheduleWave` itself
 * and folded into the final `binding_cap` there.
 */
interface UncappedWaveSize {
  size: number;
  binding_cap: WaveBindingCap;
}

function computeUncappedWaveSize(
  waveSize: number,
  limits: ResolvedLimits,
  safetyMargin: number,
  avgTokens: number,
  slotsSorted: number[] | null,
  quotaStateEntry: QuotaStateEntry | null,
  hostConcurrencyLimit: HostConcurrencyLimit | null,
  providerName: ResolvedProviderName,
  quota: QuotaConfig,
  halfLifeHours: number,
): UncappedWaveSize {
  let current = waveSize;
  let bindingCap: WaveBindingCap = "none";

  // Cap by requests-per-minute
  if (limits.requests_per_minute != null) {
    const rpmCap = Math.max(1, Math.floor(limits.requests_per_minute * safetyMargin));
    if (rpmCap < current) {
      current = rpmCap;
      bindingCap = "rpm";
    }
  }

  // Cap by input tokens-per-minute
  if (limits.input_tokens_per_minute != null && avgTokens > 0) {
    const tpmBudget = limits.input_tokens_per_minute * safetyMargin;
    if (slotsSorted && slotsSorted.length > 0) {
      let candidateSize = current;
      while (candidateSize > 1 && sumTopN(slotsSorted, candidateSize) > tpmBudget) {
        candidateSize--;
      }
      const capped = Math.max(1, candidateSize);
      if (capped < current) {
        current = capped;
        bindingCap = "tpm";
      }
    } else {
      const tpmCap = Math.max(1, Math.floor(tpmBudget / avgTokens));
      if (tpmCap < current) {
        current = tpmCap;
        bindingCap = "tpm";
      }
    }
  }

  if (quotaStateEntry) {
    const rampUp = quota.ramp_up_enabled !== false;
    const cap = rampUp
      ? computeRampUpConcurrency(quotaStateEntry, halfLifeHours)
      : computeMaxSafeConcurrency(quotaStateEntry, halfLifeHours);
    if (cap < current) {
      current = cap;
      bindingCap = "learned";
    }
    return { size: current, binding_cap: bindingCap };
  } else if (hostConcurrencyLimit !== null) {
    // The host explicitly reported its active-subagent capacity. That is a real
    // concurrency signal, so it supersedes the conservative unknown-provider
    // fallback. The reported limit is enforced as the hard ceiling by
    // applyHostConcurrencyLimit() at the call site, so nothing is capped here.
    return { size: current, binding_cap: bindingCap };
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
      const cap = Math.max(1, Math.floor(fallbackCap));
      if (cap < current) {
        current = cap;
        bindingCap = "fallback";
      }
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
      const firstContactCap = Math.max(
        1,
        quota.first_contact_concurrency ?? DEFAULT_FIRST_CONTACT_CONCURRENCY,
      );
      if (firstContactCap < current) {
        current = firstContactCap;
        bindingCap = "first_contact";
      }
    }
    return { size: current, binding_cap: bindingCap };
  }
}

export function scheduleWave(options: ScheduleWaveOptions): WaveSchedule {
  const {
    providerName,
    sessionConfig,
    hostModel,
    requestedConcurrency,
    estimatedSlotTokens,
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
    : 0;

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
      binding_cap: waveSize < requestedConcurrency ? "host_concurrency" : "none",
    };
  }

  const safetyMargin = quota.safety_margin ?? DEFAULT_SAFETY_MARGIN;
  const halfLifeHours =
    quota.empirical_half_life_hours ?? DEFAULT_EMPIRICAL_HALF_LIFE_HOURS;

  const { limits, source, confidence } = resolveLimits({ providerName, sessionConfig, hostModel });

  // Fill null RPM/TPM from discovered limits (provider query or header extraction)
  if (discoveredLimits) {
    limits.requests_per_minute ??= discoveredLimits.requests_per_minute ?? null;
    limits.input_tokens_per_minute ??= discoveredLimits.input_tokens_per_minute ?? null;
    limits.output_tokens_per_minute ??= discoveredLimits.output_tokens_per_minute ?? null;
  }

  let cooldownUntil: string | null = null;

  // Respect an active cooldown period
  if (quotaStateEntry?.cooldown_until) {
    const cooldownExpiry = new Date(quotaStateEntry.cooldown_until).getTime();
    if (cooldownExpiry > Date.now()) {
      cooldownUntil = quotaStateEntry.cooldown_until;
    }
  }

  // During an active cooldown we throttle to a single request and skip all cap
  // logic; otherwise apply RPM/TPM and learned/fallback caps. The host-concurrency
  // ceiling is enforced uniformly below by applyHostConcurrencyLimit().
  let waveSize = requestedConcurrency;
  let bindingCap: WaveBindingCap = "none";
  if (cooldownUntil) {
    waveSize = 1;
    bindingCap = "cooldown";
  } else {
    const uncapped = computeUncappedWaveSize(
      waveSize,
      limits,
      safetyMargin,
      avgTokens,
      slotsSorted,
      quotaStateEntry,
      hostConcurrencyLimit,
      providerName,
      quota,
      halfLifeHours,
    );
    waveSize = uncapped.size;
    bindingCap = uncapped.binding_cap;
  }

  // Apply real-time quota source data if available. A near-exhausted quota
  // snapshot is the strongest live signal, so when it reduces the wave it
  // becomes the binding cap (recorded as "cooldown" since it throttles to 1).
  if (quotaSourceSnapshot && !cooldownUntil) {
    if (
      quotaSourceSnapshot.remaining_pct != null &&
      quotaSourceSnapshot.remaining_pct < QUOTA_REMAINING_PCT_CRITICAL
    ) {
      if (waveSize > 1) bindingCap = "cooldown";
      waveSize = 1;
      if (quotaSourceSnapshot.reset_at) {
        cooldownUntil = quotaSourceSnapshot.reset_at;
      }
    } else if (
      quotaSourceSnapshot.remaining_pct != null &&
      quotaSourceSnapshot.remaining_pct < QUOTA_REMAINING_PCT_LOW
    ) {
      const reduced = Math.max(1, Math.floor(waveSize * QUOTA_LOW_WAVE_MULTIPLIER));
      if (reduced < waveSize) {
        waveSize = reduced;
        bindingCap = "cooldown";
      }
    }
  }

  const beforeHostCap = waveSize;
  waveSize = applyHostConcurrencyLimit(waveSize);
  if (waveSize < beforeHostCap) bindingCap = "host_concurrency";
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
    binding_cap: bindingCap,
  };
}

/** Build the state key used for indexing quota-state.json entries. */
export function buildProviderModelKey(
  providerName: string,
  hostModel: string | null | undefined,
): string {
  return hostModel ? `${providerName}/${hostModel}` : `${providerName}/*`;
}
