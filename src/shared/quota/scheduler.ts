import { z } from "zod";
import type { QuotaConfig, ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type { DispatchModelTier } from "../types/stepContract.js";
import { DispatchModelTierSchema } from "../types/stepContract.js";
import type {
  HostConcurrencyLimit,
  QuotaStateEntry,
  ResolvedLimits,
  WaveBindingCap,
  WaveSchedule,
} from "./types.js";
import type { QuotaUsageSnapshot } from "./quotaSource.js";
import {
  hostClassFor,
  resolveLimits,
  type ProviderType,
} from "./limits.js";
import { computeMaxSafeConcurrency, computeRampUpConcurrency } from "./state.js";

/**
 * Minimal structural shape of capabilities discovered at runtime — RPM/TPM (e.g.
 * via response-header extraction) plus, from the dispatch-time capability
 * handshake, the dispatching model's real context/output window. Declared here
 * so the scheduler stays decoupled from any package-specific discovery
 * implementation — callers may pass a richer object (with a `source` field,
 * etc.); only these fields are read.
 *
 * `context_tokens`/`output_tokens`, when present, are the discovered model's
 * window and take precedence over the static known-model table — they are how
 * dispatch escapes the conservative 32k default once a host reports its real
 * capabilities (see spec/audit-workflow-design.md).
 */
export interface DiscoveredRateLimitsInput {
  requests_per_minute?: number | null;
  input_tokens_per_minute?: number | null;
  output_tokens_per_minute?: number | null;
  /** Discovered context window for the dispatching model, if reported. */
  context_tokens?: number | null;
  /** Discovered output cap for the dispatching model, if reported. */
  output_tokens?: number | null;
}

/**
 * One entry of the host's model roster, reported at the dispatch handshake
 * (lowest rank first). `rank` is a RELATIVE capability label that reuses the
 * `DispatchModelTier` vocabulary so it lines up with each packet's
 * `model_hint.tier`; the windows are discovered, never assumed. The host still
 * never names a model to the backend (no-hardcoded-models invariant).
 */
export const HostModelRosterEntrySchema = z
  .object({
    rank: DispatchModelTierSchema,
    /** Context window (input tokens) of the model serving this rank. */
    context_tokens: z.number().int().min(1),
    /** Output-token cap of the model serving this rank. */
    output_tokens: z.number().int().min(1),
    /**
     * Optional OPAQUE identity for the model serving this rank, used ONLY as a
     * quota-key segment (`provider/<model_id>`) so quota learning stays
     * per-model. Never a window authority and never compared against a name
     * table — the no-hardcoded-models invariant holds.
     */
    model_id: z.string().optional(),
  })
  .strict();
export type HostModelRosterEntry = z.infer<typeof HostModelRosterEntrySchema>;

const HOST_MODEL_RANKS = new Set<string>(["small", "standard", "deep"]);

/**
 * Parse and validate a `--host-models` handshake value (JSON array, lowest
 * rank first) into a roster. Single-sourced here so both orchestrators accept
 * the identical contract. Malformed input throws so a mistyped handshake fails
 * loudly instead of silently downgrading to the conservative floor.
 */
export function parseHostModelRoster(raw: string): HostModelRosterEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `--host-models must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "--host-models must be a non-empty JSON array of {rank, context_tokens, output_tokens} entries.",
    );
  }
  return parsed.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`--host-models[${index}] must be a JSON object.`);
    }
    const { rank, context_tokens, output_tokens } = entry as Record<string, unknown>;
    if (typeof rank !== "string" || !HOST_MODEL_RANKS.has(rank)) {
      throw new Error(
        `--host-models[${index}].rank must be one of: small, standard, deep.`,
      );
    }
    if (!Number.isInteger(context_tokens) || (context_tokens as number) <= 0) {
      throw new Error(
        `--host-models[${index}].context_tokens must be a positive integer.`,
      );
    }
    if (!Number.isInteger(output_tokens) || (output_tokens as number) <= 0) {
      throw new Error(
        `--host-models[${index}].output_tokens must be a positive integer.`,
      );
    }
    const { model_id } = entry as Record<string, unknown>;
    if (
      model_id !== undefined &&
      (typeof model_id !== "string" || model_id.trim().length === 0)
    ) {
      throw new Error(
        `--host-models[${index}].model_id must be a non-empty string when provided.`,
      );
    }
    return {
      rank: rank as DispatchModelTier,
      context_tokens: context_tokens as number,
      output_tokens: output_tokens as number,
      ...(model_id !== undefined ? { model_id: model_id as string } : {}),
    };
  });
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
/**
 * Conservative cold-start ceiling applied on first contact with an unconfigured
 * provider. Private to this module: it is NOT a separable public export — the
 * resolved cold-start / agent-host floor is surfaced ONLY via the
 * {@link classifyProvider} struct's `concurrencyFloor`
 * (INV-BROKER-CLASSIFY-SINGLE-SOURCE / CE-005), so a call site cannot re-derive
 * a floor from a standalone constant.
 */
const COLD_START_CONCURRENCY = 3;

/**
 * Parallel cold-start floor for a capable agent host that fans out to fresh
 * subagent sessions (each with its own context window). Private — surfaced only
 * through {@link classifyProvider}'s `concurrencyFloor`. Collapsing such a host
 * to serial dispatch (1) is pathological for the conversation-first flow, so the
 * floor is lifted when nothing else constrains concurrency. The host's own
 * reported cap still binds at dispatch time, and an explicit
 * `quota.unknown_hosted_concurrency` still overrides it.
 */
const AGENT_HOST_CONCURRENCY = 8;

/**
 * How a provider's dispatch slots are driven once admitted by the broker.
 * - `y_dispatcher`: a thin host-side dispatcher agent (Y) launches fresh
 *   subagent sessions for each slot (capable agent hosts / command-template
 *   backends routed through the conversation host).
 * - `in_process_slot_pull`: the in-process rolling engine pulls slots directly
 *   against the backend (local subprocess pools, single-shot API backends).
 */
export type DriverMechanism = "y_dispatcher" | "in_process_slot_pull";

/**
 * The SINGLE host-classification struct (INV-BROKER-CLASSIFY-SINGLE-SOURCE /
 * CE-005, S-BROKER-WIRING-tier-classification decision B). Every dispatch path
 * reads `hostClass`, `concurrencyFloor`, and `driverMechanism` off this one
 * struct rather than re-deriving any of them — there is no separable exported
 * floor constant to re-derive from, and no second cold-start / host-class table
 * may live in the dispatch layer.
 */
export interface ProviderClassification {
  /**
   * Relative host-class keyed off provider-class — never a model-name table.
   * `hosted` (capable hosted-model agent backend), `local` (local subprocess
   * pool), or `unknown` (operator-configured command-template backend).
   */
  hostClass: ProviderType;
  /**
   * Resolved cold-start / agent-host concurrency floor for this provider, ALREADY
   * lifted for a capable agent host. This is the only public surface of the floor
   * — there is no standalone floor constant to re-derive it from at a call site.
   */
  concurrencyFloor: number;
  /** How admitted slots are driven for this provider. */
  driverMechanism: DriverMechanism;
}

/**
 * Is this provider a capable agent host that fans out to parallel subagent
 * sessions? Such hosts get the lifted agent-host concurrency floor rather than
 * the conservative cold-start floor. (opencode also fans out but classifies
 * `local` and uses the local path, so it is intentionally excluded here.)
 */
function isCapableAgentHost(providerName: ResolvedProviderName): boolean {
  return providerName === "claude-code" || providerName === "vscode-task";
}

/**
 * Classify a provider for dispatch in ONE struct: its host-class, its resolved
 * cold-start / agent-host concurrency floor, and its driver mechanism
 * (INV-BROKER-CLASSIFY-SINGLE-SOURCE / CE-005). This is the only
 * classification / cold-start site in the codebase — the broker and every
 * dispatch path (M5-WIRING) read all three fields off this struct verbatim and
 * never re-derive a host-class, concurrency floor, or mechanism→floor mapping of
 * their own. No standalone floor constant is exported, so a second derivation of
 * the floor is mechanically impossible at any call site.
 */
export function classifyProvider(
  providerName: ResolvedProviderName,
): ProviderClassification {
  const hostClass = hostClassFor(providerName);
  const agentHost = isCapableAgentHost(providerName);
  return {
    hostClass,
    // Capable agent hosts are lifted to the parallel agent-host floor; every
    // other provider stays at the conservative cold-start floor.
    concurrencyFloor: agentHost ? AGENT_HOST_CONCURRENCY : COLD_START_CONCURRENCY,
    driverMechanism: hostClass === "local" ? "in_process_slot_pull" : "y_dispatcher",
  };
}
/**
 * Real-time quota-source `remaining_pct` thresholds. At/under CRITICAL we throttle
 * to a single request; at/under LOW we halve the wave.
 */
export const QUOTA_REMAINING_PCT_CRITICAL = 0.1;
export const QUOTA_REMAINING_PCT_LOW = 0.3;
/** Multiplier applied to the wave when remaining quota is in the LOW band. */
const QUOTA_LOW_WAVE_MULTIPLIER = 0.5;

interface QuotaSourceAdjustmentResult {
  waveSize: number;
  bindingCap: WaveBindingCap;
  cooldownUntil: string | null;
}

/**
 * Apply a real-time quota-source snapshot to the current wave size. The snapshot
 * is the strongest live signal: when quota is near-exhausted we throttle to 1 and
 * record the reset time as a cooldown; when it is low (but not critical) we halve
 * the wave.
 *
 * Returns the adjusted wave size, binding cap, and cooldown timestamp. When no
 * adjustment is needed the inputs are returned unchanged.
 */
function applyQuotaSourceAdjustment(
  waveSize: number,
  bindingCap: WaveBindingCap,
  cooldownUntil: string | null,
  quotaSourceSnapshot: QuotaUsageSnapshot,
): QuotaSourceAdjustmentResult {
  if (
    quotaSourceSnapshot.remaining_pct != null &&
    quotaSourceSnapshot.remaining_pct < QUOTA_REMAINING_PCT_CRITICAL
  ) {
    return {
      waveSize: 1,
      bindingCap: waveSize > 1 ? "cooldown" : bindingCap,
      cooldownUntil: quotaSourceSnapshot.reset_at ?? cooldownUntil,
    };
  }
  if (
    quotaSourceSnapshot.remaining_pct != null &&
    quotaSourceSnapshot.remaining_pct < QUOTA_REMAINING_PCT_LOW
  ) {
    const reduced = Math.max(1, Math.floor(waveSize * QUOTA_LOW_WAVE_MULTIPLIER));
    if (reduced < waveSize) {
      return { waveSize: reduced, bindingCap: "cooldown", cooldownUntil };
    }
  }
  return { waveSize, bindingCap, cooldownUntil };
}

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

interface ComputeUncappedWaveSizeInput {
  waveSize: number;
  limits: ResolvedLimits;
  safetyMargin: number;
  avgTokens: number;
  slotsSorted: number[] | null;
  quotaStateEntry: QuotaStateEntry | null;
  hostConcurrencyLimit: HostConcurrencyLimit | null;
  providerName: ResolvedProviderName;
  quota: QuotaConfig;
  halfLifeHours: number;
}

function computeUncappedWaveSize(input: ComputeUncappedWaveSizeInput): UncappedWaveSize {
  const {
    waveSize: initialSize,
    limits,
    safetyMargin,
    avgTokens,
    slotsSorted,
    quotaStateEntry,
    hostConcurrencyLimit,
    providerName,
    quota,
    halfLifeHours,
  } = input;
  let current = initialSize;
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
    const classification = classifyProvider(providerName);
    const agentHostFloor = isCapableAgentHost(providerName)
      ? classification.concurrencyFloor
      : 1;
    const fallbackCap =
      classification.hostClass === "local"
        ? quota.unknown_local_concurrency
        : (quota.unknown_hosted_concurrency ?? agentHostFloor);
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
        quota.first_contact_concurrency ?? classification.concurrencyFloor,
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
      max_concurrent: waveSize,
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

  const { limits, source, confidence } = resolveLimits({ providerName, sessionConfig, hostModel, discoveredLimits });

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
    const uncapped = computeUncappedWaveSize({
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
    });
    waveSize = uncapped.size;
    bindingCap = uncapped.binding_cap;
  }

  // Apply real-time quota source data if available (strongest live signal).
  if (quotaSourceSnapshot && !cooldownUntil) {
    ({ waveSize, bindingCap, cooldownUntil } = applyQuotaSourceAdjustment(
      waveSize,
      bindingCap,
      cooldownUntil,
      quotaSourceSnapshot,
    ));
  }

  const beforeHostCap = waveSize;
  waveSize = applyHostConcurrencyLimit(waveSize);
  if (waveSize < beforeHostCap) bindingCap = "host_concurrency";
  waveSize = Math.max(1, waveSize);

  return {
    max_concurrent: waveSize,
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

/**
 * Build the quota pool key used for indexing quota-state.json entries and gating
 * sources. Pool identity is `(provider, account, model)` — quota is billed
 * per-ACCOUNT, so two same-provider accounts must NOT alias to one pool (see
 * docs/quota-dispatch-design.md §5). Format: `provider[#account]/model`. The
 * account segment is OMITTED when null, so a single-account run keeps the legacy
 * `provider/model` key (no migration). The `model` tail may itself contain `/`;
 * provider + account live in the head before the first `/`.
 */
export function buildProviderModelKey(
  providerName: string,
  hostModel: string | null | undefined,
  account?: string | null,
): string {
  const head = account ? `${providerName}#${account}` : providerName;
  return hostModel ? `${head}/${hostModel}` : `${head}/*`;
}
