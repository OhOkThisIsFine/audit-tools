import { z } from "zod";

export const LimitSourceSchema = z.enum([
  "explicit_config",
  "discovered_capability",
  "static_metadata",
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

export interface QuotaStateEntry {
  updated_at: string;
  cooldown_until: string | null;
  last_429_at: string | null;
  consecutive_429_count?: number;
  /**
   * Learned tokens→percent slope (EWMA), keyed by `windowSlopeKey(scope, label)`
   * (e.g. "account:session", "model:session") — NOT by bare label: an account-scoped
   * and a model-scoped window can share a group name while pricing different
   * allowances. `slope = Δtokens / Δpercent` where percent = remaining_pct*100.
   * Windows scale on different denominators, so each learns its own slope.
   *
   * Two consumers, and the distinction matters: the slope prices each window's
   * remaining percent into a token budget for REPORTING (the MIN across a pool's
   * windows), and it is the exchange rate ADMISSION uses to convert a packet's tokens
   * into a draw against a percent-denominated window. Absent until observed (cold
   * start), which reads as `calibrating`.
   */
  tokens_per_pct?: Record<string, number>;
  /**
   * Learned output/input token RATIO (EWMA), keyed PER LENS (e.g. "security",
   * "correctness"). Dispatch reserves an output ENVELOPE before a packet runs —
   * output (the findings) is unknown until generated yet is frequently the binding
   * rate-limit constraint, so reserving on input alone systematically
   * under-reserves. `ratio = actual_output_tokens / actual_input_tokens`, folded on
   * completion. When absent for a (key,lens) the caller falls back to the packet's
   * declared output cap (cold start); once learned, `output_reservation =
   * input_estimate * ratio`. Absent until observed.
   */
  output_per_input?: Record<string, number>;
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
  "cooldown",
  "host_concurrency",
  "none",
]);
export type WaveBindingCap = z.infer<typeof WaveBindingCapSchema>;

/**
 * The quota window that BOUND a pool's derived token budget (the MIN across the
 * pool's windows). Surfaced so an `empty_grant` wall can name WHY zero packets fit —
 * a low (or empty) window whose reset may be days out even while the session window
 * is fresh — and derive a reset time from it. `reset_at` can be null (a window with
 * no declared reset). Absent/null when there is no live budget signal (cold start).
 */
export interface QuotaBindingWindow {
  label: string;
  reset_at: string | null;
  /** The window's own remaining token budget (the value that won the MIN). */
  budget: number;
}

/**
 * One quota window's remaining allowance, expressed in THAT WINDOW'S OWN UNIT, as
 * the metering unit admission reserves against. This is what replaces the MIN
 * collapse as the basis for admission: the MIN survives only for REPORTING which
 * window binds ({@link QuotaBindingWindow}).
 *
 * ⚠ There is no unit shared across windows, which is the whole reason this is a
 * list rather than a number. A 5-hour `session` and a 7-day `weekly` scale on
 * different denominators, so the same N tokens is a different fraction of each.
 *
 * `unit` is decided per window, by what the provider actually reported:
 *  - `tokens` — the window reported an ABSOLUTE `tokens_remaining`. Tokens are
 *    directly commensurable here because no exchange rate is involved, so even an
 *    account-scoped window shared by N models can meter in tokens.
 *  - `percent` — only `remaining_pct` is known, priced through the pool's own
 *    learned `tokensPerPct`. This is REQUIRED for an account-scoped percent window:
 *    N models share one percent allowance but each converts its tokens at its OWN
 *    rate, so percent is the only unit in which their draws are comparable.
 *
 * A window that can be priced in NEITHER unit is not represented here at all — it
 * sets `calibrating`, which routes the pool through the cold-start clamp rather
 * than being waved through unmetered.
 */
export interface WindowBudget {
  /** Which partition the allowance belongs to — decided at the producer, never re-derived. */
  scope: import("./quotaSource.js").QuotaWindowScope;
  label: string;
  /** Remaining allowance, in `unit`. */
  budget: number;
  unit: "tokens" | "percent";
  /** Tokens per percentage point for this pool+window. Present iff `unit === "percent"`. */
  tokensPerPct?: number;
  /** The window's reset, carried for wall reporting. */
  reset_at: string | null;
}

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
  /**
   * The window that bound `remaining_token_budget` (the MIN-budget window) + its
   * reset. Lets an `empty_grant` wall surface WHY zero packets fit and derive a reset
   * time when there is no cooldown. Absent/null at cold start / no live snapshot.
   */
  binding_window?: QuotaBindingWindow | null;
  /**
   * Every window this pool must fit inside, each in its own unit — the METERING
   * basis. Admission reserves against ALL of them (all-or-nothing); an account-scoped
   * entry is shared with every sibling model on the credential, which is what stops N
   * models on one account from each admitting against their own copy of one allowance.
   *
   * Empty/absent when there is no live snapshot, or on the cooldown path where budget
   * derivation is skipped entirely — admission then falls back to a single pool-keyed
   * constraint carrying the scalar budget, i.e. exactly the pre-partition behaviour.
   */
  window_budgets?: WindowBudget[];
  /** Tokens already in flight against this pool when the wave was sized (0 default). */
  in_flight_tokens?: number;
  /**
   * Cold-start calibration: a live snapshot exists but at least one of the pool's
   * quota windows has no absolute token count and no learned tokens-per-percent
   * slope yet, so no real token budget can be derived. The scheduler already clamps
   * `max_concurrent` to a bounded calibration batch here; this flag propagates the
   * SAME bound to the host-path admission GRANT (which obeys `granted_packet_ids`,
   * not `max_concurrent`) so wave 1 cannot over-grant the whole frontier before the
   * slope is observed. Optional so existing constructions stay valid (⇒ not calibrating).
   */
  calibrating?: boolean;
}

export const BackoffStateSchema = z
  .object({
    consecutive_429_count: z.number().int().min(0),
    current_cooldown_ms: z.number().int().min(0),
  })
  .strict();
export type BackoffState = z.infer<typeof BackoffStateSchema>;

export interface ObservedWaveOutcome {
  /**
   * - `success`: wave completed without error — clears the 429 streak and cooldown,
   *   but NEVER a still-live cooldown (a concurrent success is not evidence a 429
   *   is over).
   * - `rate_limited`: provider signalled 429 / quota exhaustion — applies cooldown + backoff.
   * - `timeout`: execution deadline exceeded — no rate-limit cooldown.
   * - `error`: provider returned a non-quota error (crash, network failure) — no
   *   rate-limit cooldown (distinct from quota exhaustion).
   *
   * The outcome carries no `concurrency`: concurrency is DECLARED by the provider
   * or ABSENT, never inferred from an outcome stream.
   */
  outcome: "success" | "rate_limited" | "timeout" | "error";
  cooldown_until?: string | null;
  reset_at?: string | null;
}
