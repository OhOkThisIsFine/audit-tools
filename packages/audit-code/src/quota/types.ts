export type LimitSource =
  | "explicit_config"
  | "cli_flags"
  | "known_metadata"
  | "learned"
  | "default";

export type LimitConfidence = "high" | "medium" | "low";

export type HostConcurrencyLimitSource =
  | "cli_flags"
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

export interface WaveSchedule {
  wave_size: number;
  estimated_wave_tokens: number;
  cooldown_until: string | null;
  confidence: LimitConfidence;
  source: LimitSource;
  resolved_limits: ResolvedLimits;
  host_concurrency_limit: HostConcurrencyLimit | null;
  model: string | null;
  quota_source_snapshot?: import("./quotaSource.js").QuotaUsageSnapshot | null;
}

export interface BackoffState {
  consecutive_429_count: number;
  current_cooldown_ms: number;
  current_failure_weight: number;
}

export interface DispatchQuota {
  contract_version: "audit-code-dispatch-quota/v1alpha1" | "audit-code-dispatch-quota/v1alpha2";
  run_id: string;
  model: string | null;
  resolved_limits: ResolvedLimits;
  confidence: LimitConfidence;
  source: LimitSource;
  host_concurrency_limit: HostConcurrencyLimit | null;
  wave_size: number;
  estimated_wave_tokens: number;
  cooldown_until: string | null;
  quota_source_snapshot?: import("./quotaSource.js").QuotaUsageSnapshot | null;
  backoff_state?: BackoffState | null;
}

export interface ObservedWaveOutcome {
  concurrency: number;
  estimated_tokens: number;
  outcome: "success" | "rate_limited" | "timeout";
  cooldown_until?: string | null;
  reset_at?: string | null;
}
