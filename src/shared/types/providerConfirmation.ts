/**
 * Versioned seam contract for Gate-0/Gate-1 Provider Confirmation (N-X06).
 *
 * Pins the output shape of the provider confirmation step so that
 * consumers (audit-code, remediate-code) can be validated against a single,
 * version-stamped result interface.
 *
 * The implementing functions live in src/providers/providerConfirmation.ts.
 * This file ONLY declares the contract types and the version constant.
 */

import type { ResolvedProviderName } from "./sessionConfig.js";
import type { CapabilityTier } from "../providers/providerConfirmation.js";

// ---------------------------------------------------------------------------
// Version constant
// ---------------------------------------------------------------------------

/**
 * Version string for the ProviderConfirmationResult contract.
 * Increment when any breaking interface change lands.
 *
 * 1.1.0 — additive cost-first-routing fields on ConfirmedPoolEntry
 * (`model_id`, `blended_price_usd_per_mtok`, `cost_order`). See
 * spec/cost-first-routing.md.
 */
export const PROVIDER_CONFIRMATION_RESULT_VERSION = "1.1.0" as const;

// ---------------------------------------------------------------------------
// Interactive Gate-0 operator input (spec/cost-first-routing.md — Gate-0)
// ---------------------------------------------------------------------------

/**
 * Schema version for the operator-written Gate-0 input file
 * (`<root>/.audit-tools/provider-confirmation.input.json`). The HOST writes this
 * plain input; the tool owns the canonical envelope it is promoted into (the
 * per-tool `provider_confirmation.json` seam + the shared
 * `provider-confirmation.json`) — the input/envelope split so the tool stays the
 * sole writer of the discovered pool + cost annotation.
 */
export const PROVIDER_CONFIRMATION_INPUT_VERSION =
  "provider-confirmation-input/v1" as const;

/**
 * One model the host self-reports at the confirmation step so its host-native
 * tiers are priced + ordered at Gate-0 (follow-up c) rather than only
 * deterministically at dispatch. `model_id` is both the price-lookup key
 * (models.dev) and the dispatch cost-position key. Never hardcoded — the host
 * supplies it.
 */
export interface HostRosterModel {
  /** Model id used to price (models.dev) and to key the dispatch cost position. */
  model_id: string;
  /** Optional capability tier for the price-unknown tiebreak in the suggestion. */
  tier?: CapabilityTier;
}

/**
 * The operator's Gate-0 submission. Every field is optional beyond the version:
 * an empty `{ schema_version }` accepts the tool's suggested ordering verbatim
 * (the presence of the file is the "operator has acted" signal). The tool applies
 * it degrade-safe — unknown keys in `cost_order` are ignored, omitted candidates
 * keep their suggested relative order.
 */
export interface ProviderConfirmationInput {
  /** Must equal PROVIDER_CONFIRMATION_INPUT_VERSION. */
  schema_version: typeof PROVIDER_CONFIRMATION_INPUT_VERSION;
  /**
   * Operator's confirmed ordering as a list of candidate keys (provider names
   * and/or host `model_id`s), cheapest-first. Array index becomes `cost_order`.
   * Omit to accept the tool's price-ascending suggestion. A unified space over
   * both provider pools and host models so one total cost order drives dispatch.
   */
  cost_order?: string[];
  /**
   * Exclusion patterns ruling backends out of the dispatchable pool
   * (`DispatchExclusionPattern`): `provider:model` (the default granularity — the
   * operator confirms *model* choices), the coarser bare `provider`, or an
   * endpoint host. Kept verbatim: the grammar is open, so an unrecognized pattern
   * is inert rather than dropped.
   */
  exclude?: string[];
  /** Self-spawn-blocked provider names the operator opts back IN. */
  include?: ResolvedProviderName[];
  /**
   * Host self-reported model roster (follow-up c). Each becomes a priced,
   * orderable candidate whose confirmed position threads to dispatch by
   * `model_id` via `host_model_cost_order`.
   */
  host_models?: HostRosterModel[];
  /**
   * Cost↔speed dispatch bias (λ) ∈ [0, 1] — the operator's durable operating point
   * on the cost-vs-throughput frontier (spec/dispatch-cost-speed-dial.md). 0 (default)
   * = cost-first (today's behavior); 1 = throughput-first. Out-of-range values clamp
   * to [0, 1]; omit to keep the cost-first default. Persisted on the shared
   * confirmation and applied by `admitBatch` at every dispatch.
   */
  dispatch_bias?: number;
}

/**
 * A host-native model's persisted cost position (follow-up c). Lives on the
 * shared confirmation alongside `provider_pool`; merged into the model-keyed
 * dispatch positions map by `resolveConfirmedCostPositions` so a host tier routes
 * by its operator-confirmed order exactly like a configured pool does. Kept as a
 * separate list (not extra `provider_pool` entries) so no `provider_pool` consumer
 * has to tolerate duplicate provider names.
 */
export interface HostModelCostEntry {
  /** Host model id — the dispatch cost-position key. */
  model_id: string;
  /** Blended $/Mtok from models.dev, or `null` when unpriceable. Advisory. */
  blended_price_usd_per_mtok: number | null;
  /** Operator-confirmed 0-based cost position (rung 1 of costRank). */
  cost_order: number;
}

/**
 * A configured/discovered dispatchable SOURCE pool's persisted cost position (Gate-0
 * source fold). Lives on the shared confirmation alongside `provider_pool` +
 * `host_model_cost_order`; merged into the model-keyed dispatch positions map by
 * `readConfirmedCostPositions` so a source pool (an explicit `sources[]` entry OR a
 * repair-proxy-expanded `provider/model`) routes by its operator-confirmed order exactly
 * like a configured provider pool or host tier. Kept as a separate list (not extra
 * `provider_pool` entries) because a source is keyed by `(provider, model)`, not by a
 * single provider name — many sources can share the `openai-compatible` provider.
 */
export interface SourcePoolCostEntry {
  /** Dispatchable source id (`id` or `provider:model`) — stable display + reorder key. */
  source_id: string;
  /** The source's provider transport (e.g. `openai-compatible`). */
  provider: string;
  /**
   * The source's model id — the DISPATCH cost-position key (a repair-proxy source's
   * namespaced `provider/model`, or a plain source model). Absent when the source
   * declares no model (then it contributes no dispatch position, only display).
   */
  model_id?: string;
  /**
   * Declared ($/Mtok) when the source set one (authoritative; `0` = free), else the
   * models.dev blended price, else `null` when unpriceable. Advisory.
   */
  blended_price_usd_per_mtok: number | null;
  /** Whether {@link blended_price_usd_per_mtok} came from the source's declared cost. */
  price_declared: boolean;
  /** Raw per-model capability rank (LOWER = more capable), when the source carries one. */
  capability_rank?: number;
  /** Operator-confirmed 0-based cost position (rung 1 of costRank). */
  cost_order: number;
}

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

/** One entry in the confirmed provider pool. */
/**
 * One entry of the PERSISTED confirmed pool — the operator's DECISION, and nothing
 * else (G3 B+D).
 *
 * Deliberately a strict subset of {@link ConfirmedPoolEntry}: the reach half
 * (`capability_tier` / `self_spawn_blocked` / `excluded` / `reason` /
 * `blended_price_usd_per_mtok`) is the WRITING auditor's assessment of its own
 * environment and must never be inherited by a reading auditor — reach is
 * re-resolved per-auditor at the moment of use. Those fields live only on the
 * in-memory render DTO, which never reaches disk.
 *
 * This is enforced by TYPE, not by a projection at the write site: if the persisted
 * field were typed `ConfirmedPoolEntry[]`, `writeJsonFile` would serialize the reach
 * fields regardless of intent. Unrepresentable, not guarded.
 */
export interface PersistedPoolEntry {
  /** Canonical provider name. Half of the gate's `model_id ?? name` compare key. */
  name: ResolvedProviderName;
  /**
   * The reach half, branded `never` so it is genuinely UNREPRESENTABLE here.
   *
   * ⚠ These are load-bearing, not documentation. `PersistedPoolEntry` is otherwise a
   * structural SUBSET of {@link ConfirmedPoolEntry}, and TypeScript's excess-property
   * check fires only on fresh object literals — so without these, a `ConfirmedPoolEntry`
   * (or a `RenderedProviderConfirmation`) assigns cleanly to the persisted type and the
   * writer's whole reach assessment serializes to disk with NO compiler signal. An
   * independent review proved exactly that against this file. The two builders take
   * identical parameter lists and differ by one word, so a swapped call site is a real
   * hazard; this is what makes the swap a type error instead of a silent leak.
   */
  capability_tier?: never;
  self_spawn_blocked?: never;
  excluded?: never;
  reason?: never;
  blended_price_usd_per_mtok?: never;
  /**
   * Representative model id this entry is priced/ordered by. The dispatch
   * cost-position key, and the finer half of the gate's compare key. Absent when the
   * model is not knowable at confirmation time (a CLI backend's model arrives only
   * at the dispatch handshake).
   */
  model_id?: string;
  /**
   * Operator-confirmed 0-based cost position (rung 1 of costRank). Lower routes
   * first. Read back at dispatch via `resolveConfirmedCostPositions`.
   */
  cost_order?: number;
}

/**
 * The FULL in-memory pool entry — the Gate-0 RENDER DTO. Carries the persisted
 * decision ({@link PersistedPoolEntry}) plus this auditor's freshly-derived reach,
 * which the operator needs to SEE (tier, price, why a backend is excluded) but which
 * must never be persisted for another auditor to inherit.
 */
export interface ConfirmedPoolEntry {
  /** Canonical provider name. */
  name: ResolvedProviderName;
  /** Capability tier assessed at discovery time. */
  capability_tier: CapabilityTier;
  /**
   * Whether this provider was explicitly excluded from the pool by the user
   * (or by self-spawn guard). Excluded entries are recorded but not dispatched.
   */
  excluded: boolean;
  /**
   * Machine-readable self-spawn-blocked flag. True when this provider was
   * detected on PATH but cannot be launched as a fresh subprocess from inside an
   * active session of that same agent (claude-code under `CLAUDECODE`, codex
   * under `CODEX`). Such an entry is `excluded: true` by default — and so out of
   * the dispatchable pool — unless the operator explicitly re-includes it. This
   * flag is the security signal.
   */
  self_spawn_blocked?: boolean;
  /**
   * Representative model id this entry is priced/ordered by (cost-first routing;
   * spec/cost-first-routing.md). For a configured API pool it is the configured
   * model; for a host-reported roster entry it is that roster model. Absent when
   * the concrete model is not knowable at confirmation time (e.g. a CLI backend
   * whose roster arrives only at the dispatch handshake).
   */
  model_id?: string;
  /**
   * Suggested blended price ($/Mtok) the tool computed from the models.dev
   * snapshot for `model_id`, or `null` when the dataset can't price it (surfaced
   * to the operator as "price unknown"). Advisory — the authoritative routing key
   * is `cost_order` once the operator confirms.
   */
  blended_price_usd_per_mtok?: number | null;
  /**
   * Operator-confirmed 0-based cost position (rung 1 of costRank). Lower routes
   * first. Defaults to the tool's price-ascending suggestion; the operator may
   * reorder. Read back at dispatch via `resolveConfirmedCostPositions`. Absent ⇒
   * the pool falls to real price then tier at dispatch.
   */
  cost_order?: number;
}

/**
 * Output of Gate-0 / Gate-1 provider confirmation.
 *
 * session_level: true because the pool applies to the entire audit run,
 * not to individual dispatch waves.
 */
export interface ProviderConfirmationResult {
  /** Schema version — must equal PROVIDER_CONFIRMATION_RESULT_VERSION. */
  schema_version: typeof PROVIDER_CONFIRMATION_RESULT_VERSION;
  /** ISO-8601 timestamp of when the pool was confirmed. */
  confirmed_at: string;
  /** All discovered (and any manually added) providers, with exclusion flag. */
  provider_pool: ConfirmedPoolEntry[];
  /**
   * True: the confirmation is session-level and applies to the whole run.
   * False would mean per-step confirmation (not currently used).
   */
  session_level: boolean;
}
