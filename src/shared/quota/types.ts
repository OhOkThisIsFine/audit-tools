import { z } from "zod";

export const LimitSourceSchema = z.enum([
  "explicit_config",
  "discovered_capability",
  "cli_flags",
  "provider_default",
  "learned",
  "default",
]);
export type LimitSource = z.infer<typeof LimitSourceSchema>;

export const LimitConfidenceSchema = z.enum(["high", "medium", "low"]);
export type LimitConfidence = z.infer<typeof LimitConfidenceSchema>;

export const HostConcurrencyLimitSourceSchema = z.enum([
  "cli_flags",
  "host_reported",
  "session_config",
  "environment",
  // Read from a host's own config file (e.g. Codex `~/.codex/config.toml`
  // `[agents].max_threads`) — a real discovered value, not an env reading.
  "discovered_config",
  // A documented product default applied when the host exposes no configurable
  // signal (e.g. Codex's default `agents.max_threads` of 6). Honestly labelled
  // as a known constant rather than masquerading as an environment reading.
  "known_default",
]);
export type HostConcurrencyLimitSource = z.infer<
  typeof HostConcurrencyLimitSourceSchema
>;

export const HostConcurrencyLimitSchema = z
  .object({
    active_subagents: z.number().int().min(1),
    source: HostConcurrencyLimitSourceSchema,
    description: z.string().min(1),
  })
  .strict();
export type HostConcurrencyLimit = z.infer<typeof HostConcurrencyLimitSchema>;

export const ResolvedLimitsSchema = z
  .object({
    context_tokens: z.number().int().min(1),
    output_tokens: z.number().int().min(1),
    requests_per_minute: z.number().int().min(1).nullable(),
    input_tokens_per_minute: z.number().int().min(1).nullable(),
    output_tokens_per_minute: z.number().int().min(1).nullable(),
  })
  .strict();
export type ResolvedLimits = z.infer<typeof ResolvedLimitsSchema>;

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
  /**
   * Learned tokens→percent slope (EWMA) for the token-budget gate, keyed PER
   * WINDOW LABEL (e.g. "session", "weekly"). `slope = Δtokens / Δpercent` where
   * percent = remaining_pct*100. Windows scale on different denominators, so
   * each learns its own slope; the gate multiplies the right slope by that
   * window's remaining percent to get its token budget and takes the MIN across
   * a pool's own windows. Absent until observed (cold start).
   */
  tokens_per_pct?: Record<string, number>;
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
export const WaveBindingCapSchema = z.enum([
  "rpm",
  "tpm",
  "token_budget",
  "learned",
  "cooldown",
  "host_concurrency",
  "none",
]);
export type WaveBindingCap = z.infer<typeof WaveBindingCapSchema>;

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
  /**
   * The remaining token budget the token-budget gate spent against for this pool
   * (MIN across the pool's own quota windows), so the host-facing summary surfaces
   * the SAME number the gate used. null when no live snapshot was available, or at
   * cold start (no absolute/learned budget for any window yet).
   */
  remaining_token_budget?: number | null;
  /** Tokens already in flight against this pool when the wave was sized (0 default). */
  in_flight_tokens?: number;
}

export const BackoffStateSchema = z
  .object({
    consecutive_429_count: z.number().int().min(0),
    current_cooldown_ms: z.number().int().min(0),
    current_failure_weight: z.number().min(0),
  })
  .strict();
export type BackoffState = z.infer<typeof BackoffStateSchema>;

export interface ObservedWaveOutcome {
  concurrency: number;
  estimated_tokens: number;
  /**
   * - `success`: wave completed without error.
   * - `rate_limited`: provider signalled 429 / quota exhaustion — applies cooldown + backoff.
   * - `timeout`: execution deadline exceeded — records failure weight but no rate-limit cooldown.
   * - `error`: provider returned a non-quota error (crash, network failure) — records failure
   *   weight only; does NOT apply rate-limit cooldown (distinct from quota exhaustion).
   */
  outcome: "success" | "rate_limited" | "timeout" | "error";
  cooldown_until?: string | null;
  reset_at?: string | null;
}
