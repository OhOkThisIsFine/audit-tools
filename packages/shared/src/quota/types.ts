export type LimitSource =
  | "explicit_config"
  | "cli_flags"
  | "known_metadata"
  | "provider_default"
  | "learned"
  | "default";

export type LimitConfidence = "high" | "medium" | "low";

export type HostConcurrencyLimitSource =
  | "cli_flags"
  | "host_reported"
  | "session_config"
  | "environment";

export interface HostConcurrencyLimit {
  active_subagents: number;
  source: HostConcurrencyLimitSource;
  description: string;
}

export interface ResolvedLimits {
  context_tokens: number;
  output_tokens: number;
  requests_per_minute: number | null;
  input_tokens_per_minute: number | null;
  output_tokens_per_minute: number | null;
}

export interface ConcurrencyBucket {
  success_weight: number;
  failure_weight: number;
}

export interface QuotaStateEntry {
  updated_at: string;
  buckets: Record<string, ConcurrencyBucket>;
  cooldown_until: string | null;
  last_429_at: string | null;
  consecutive_429_count?: number;
}

export interface QuotaState {
  version: 1 | 2;
  entries: Record<string, QuotaStateEntry>;
}

/**
 * Identifies which cap actually bound the final wave size, so an operator can
 * see *why* a wave was throttled (or that nothing throttled it) without
 * re-deriving the decision. Set by `scheduleWave`; logged by callers that hold a
 * RunLogger as a `kind:"scope"` event.
 */
export type WaveBindingCap =
  | "rpm"
  | "tpm"
  | "learned"
  | "fallback"
  | "first_contact"
  | "cooldown"
  | "host_concurrency"
  | "none";

export interface WaveSchedule {
  max_concurrent: number;
  estimated_wave_tokens: number;
  cooldown_until: string | null;
  confidence: LimitConfidence;
  source: LimitSource;
  resolved_limits: ResolvedLimits;
  host_concurrency_limit: HostConcurrencyLimit | null;
  model: string | null;
  quota_source_snapshot?: import("./quotaSource.js").QuotaUsageSnapshot | null;
  /**
   * Which cap bound the final `max_concurrent` ("none" if nothing reduced the
   * requested concurrency). Optional so existing constructions stay valid.
   */
  binding_cap?: WaveBindingCap;
}

export interface BackoffState {
  consecutive_429_count: number;
  current_cooldown_ms: number;
  current_failure_weight: number;
}

export interface ObservedWaveOutcome {
  concurrency: number;
  estimated_tokens: number;
  outcome: "success" | "rate_limited" | "timeout";
  cooldown_until?: string | null;
  reset_at?: string | null;
}
