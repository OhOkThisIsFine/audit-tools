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
  /**
   * Tokens already in flight against THIS pool (sum of estimated tokens for
   * dispatched-but-not-yet-completed packets). Added to the wave's projected slot
   * tokens when checking the token-budget gate so concurrent dispatch never
   * over-subscribes the remaining window. Defaults to 0.
   */
  inFlightTokens?: number;
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
 * Reference cold-start floor for the capable-vs-cold host CLASSIFICATION (no
 * longer a scheduler wave cap — the token-budget gate replaced the invented
 * caps). Private to this module: NOT a separable public export — the resolved
 * cold-start / agent-host floor is surfaced ONLY via the {@link classifyProvider}
 * struct's `concurrencyFloor` (INV-BROKER-CLASSIFY-SINGLE-SOURCE / CE-005), so a
 * call site cannot re-derive a floor from a standalone constant.
 */
const COLD_START_CONCURRENCY = 3;

/**
 * Parallel cold-start floor for a capable agent host that fans out to fresh
 * subagent sessions (each with its own context window). Private — surfaced only
 * through {@link classifyProvider}'s `concurrencyFloor`. This floor is NO LONGER a
 * scheduler wave-sizing cap (the invented cold-start/fallback caps were removed in
 * favour of the token-budget gate); it survives solely as the reference point for
 * the capable-vs-cold host CLASSIFICATION in `classifyCapableHost`
 * (brokeredDispatch): a host reporting a ceiling above this floor, or learned
 * evidence above it, is "capable".
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
 * Minimum eligible-item count at/above which it is worth delegating the rolling
 * dispatch loop to a dedicated dispatcher subagent (Y) on a capable agent host.
 * Below it, spinning a separate dispatcher costs more (an extra agent + its
 * context) than it saves, so the top host drives the loop directly (slot-pull).
 * A tuning constant, not a hard limit — both strategies use the SAME broker and
 * concurrency cap; only who runs the refill loop differs.
 */
export const DISPATCH_Y_DISPATCHER_MIN_ITEMS = 6;

/**
 * How the admitted dispatch slots are actually DRIVEN this dispatch, resolved
 * from the provider classification plus the live frontier size and slot count.
 * Distinct from {@link DriverMechanism} (a static provider property): the same
 * `y_dispatcher` provider drives `slot_pull` for a small frontier and only
 * escalates to a dedicated dispatcher agent once the frontier is large enough to
 * pay for it.
 * - `y_dispatcher`: delegate the rolling refill loop to ONE dispatcher subagent.
 * - `slot_pull`: the top host runs the rolling refill loop itself.
 * - `in_process`: the in-process rolling engine pulls slots directly (local).
 */
export type DispatchDriverStrategy = "y_dispatcher" | "slot_pull" | "in_process";

export interface DispatchDriverSelection {
  strategy: DispatchDriverStrategy;
  /** Human-readable rationale (for the dispatch plan + logs). */
  reason: string;
}

export interface SelectDispatchDriverInput {
  /** The provider classification (its `driverMechanism` gates the choice). */
  classification: ProviderClassification;
  /** Number of currently-eligible nodes/packets in the dispatch frontier. */
  eligibleItemCount: number;
  /** Admitted concurrency for this dispatch (broker `total_slots`). */
  slots: number;
  /** Override the dispatcher-agent threshold (defaults to the constant). */
  threshold?: number;
}

/**
 * Choose the dispatch DRIVER for this dispatch (S-BROKER-WIRING: the
 * capability-tiered driver-selection half of the dispatch broker track). The
 * broker and concurrency cap are identical across strategies — this picks ONLY
 * who runs the rolling refill loop, so the host can't get it wrong by prose:
 *
 * - A `local` provider always uses the in-process rolling engine.
 * - A capable agent host (`y_dispatcher` mechanism) with a real rolling loop to
 *   run (more than one slot) AND a frontier at/above the threshold delegates the
 *   loop to a dedicated dispatcher subagent (keeps the top host's context clean).
 * - Otherwise (one slot, or a small frontier) the top host drives the loop
 *   itself — no dispatcher-agent overhead for a handful of nodes.
 */
export function selectDispatchDriver(
  input: SelectDispatchDriverInput,
): DispatchDriverSelection {
  const threshold = input.threshold ?? DISPATCH_Y_DISPATCHER_MIN_ITEMS;
  if (input.classification.driverMechanism === "in_process_slot_pull") {
    return {
      strategy: "in_process",
      reason: "local provider — the in-process rolling engine pulls slots directly",
    };
  }
  if (input.slots <= 1) {
    return {
      strategy: "slot_pull",
      reason: "single concurrency slot — no rolling loop to delegate; host drives serially",
    };
  }
  if (input.eligibleItemCount < threshold) {
    return {
      strategy: "slot_pull",
      reason: `frontier (${input.eligibleItemCount}) below the dispatcher-agent threshold (${threshold}) — host drives the rolling loop directly`,
    };
  }
  return {
    strategy: "y_dispatcher",
    reason: `frontier (${input.eligibleItemCount}) ≥ threshold (${threshold}) with ${input.slots} slots — delegate the rolling loop to a dedicated dispatcher subagent`,
  };
}

/**
 * Real-time quota-source `remaining_pct` thresholds retained for consumers that
 * classify a pool's health from its live snapshot (e.g. the rolling engine's
 * proactive cross-pool spill, INV-QD-14). These are NO LONGER wave-sizing
 * cliffs: the scheduler sizes the wave against the learned token BUDGET gate
 * ({@link deriveTokenBudget}), not a fixed remaining_pct step function.
 */
export const QUOTA_REMAINING_PCT_CRITICAL = 0.1;
export const QUOTA_REMAINING_PCT_LOW = 0.3;

/**
 * Cold-start per-window calibration batch: with no learned tokens_per_pct slope
 * for a window and no absolute tokens_remaining, admit at most this many slots so
 * the run can OBSERVE Δutilization and seed the slope. This is a BOOTSTRAP, not a
 * permanent cap — once even one slope sample lands, the learned budget governs.
 */
export const TOKEN_BUDGET_COLD_START_SLOTS = 2;

/**
 * Derive a single window's remaining token budget, in learned/absolute priority:
 *  1. absolute `tokens_remaining` when the window reports one;
 *  2. else the learned `tokens_per_pct[label]` × remaining_pct × 100;
 *  3. else `null` (cold start — the caller applies the calibration bootstrap).
 */
function deriveWindowTokenBudget(
  windowLabel: string,
  remainingPct: number | null | undefined,
  tokensRemaining: number | null | undefined,
  learnedSlopes: Record<string, number> | undefined,
): number | null {
  if (typeof tokensRemaining === "number" && Number.isFinite(tokensRemaining)) {
    return Math.max(0, tokensRemaining);
  }
  // A window reported as fully consumed (remaining fraction 0) has a KNOWN budget
  // of 0 for ANY positive slope — 0 × slope = 0 — so it is knowable even with no
  // learned slope. This is NOT the removed 0.1 cliff: it fires only at genuine
  // emptiness (a HostSessionQuotaSource hard-limit reading, or an exhausted
  // absolute count), and lets the gate throttle + persist a cooldown so a later
  // transiently-null snapshot cannot re-expand a walled pool (anti-flap).
  if (remainingPct != null && Number.isFinite(remainingPct) && remainingPct <= 0) {
    return 0;
  }
  const slope = learnedSlopes?.[windowLabel];
  if (
    typeof slope === "number" &&
    Number.isFinite(slope) &&
    slope > 0 &&
    remainingPct != null &&
    Number.isFinite(remainingPct)
  ) {
    return Math.max(0, remainingPct * 100 * slope);
  }
  return null;
}

interface TokenBudgetResolution {
  /** Remaining token budget across the pool's own windows (MIN), or null cold-start. */
  budget: number | null;
  /** True when at least one window is in calibration (no absolute + no learned slope). */
  calibrating: boolean;
  /**
   * Earliest reset among windows whose budget is GENUINELY 0 (fully consumed), so
   * the gate can persist a cooldown and not flap. Null unless a window is empty.
   */
  exhaustedResetAt: string | null;
}

/**
 * Resolve the pool's remaining token budget from its snapshot, reducing across
 * the pool's OWN windows with MIN (the binding window governs). Uses the
 * per-window breakdown when present, else the flat top-level snapshot as a
 * single implicit window. Per-window: absolute → learned-slope → cold-start.
 */
function deriveTokenBudget(
  snapshot: QuotaUsageSnapshot,
  learnedSlopes: Record<string, number> | undefined,
): TokenBudgetResolution {
  interface BudgetWindow {
    label: string;
    remaining_pct: number | null;
    tokens_remaining: number | null;
    reset_at: string | null;
  }
  const windows: BudgetWindow[] =
    snapshot.windows && snapshot.windows.length > 0
      ? snapshot.windows.map((w) => ({
          label: w.label,
          remaining_pct: w.remaining_pct,
          tokens_remaining: w.tokens_remaining ?? null,
          reset_at: w.reset_at,
        }))
      : [
          {
            label: "default",
            remaining_pct: snapshot.remaining_pct,
            tokens_remaining: snapshot.tokens_remaining,
            reset_at: snapshot.reset_at,
          },
        ];

  let budget: number | null = null;
  let calibrating = false;
  let exhaustedResetAt: string | null = null;

  for (const w of windows) {
    const windowBudget = deriveWindowTokenBudget(
      w.label,
      w.remaining_pct,
      w.tokens_remaining,
      learnedSlopes,
    );
    if (windowBudget == null) {
      calibrating = true;
      continue;
    }
    // A near-empty window needs no special-case cliff: its own budget
    // (remaining_pct × slope, or an absolute tokens_remaining) is already tiny,
    // so the MIN reduction and the K-clamp below throttle it naturally. A
    // GENUINELY empty window (budget 0) additionally records its reset so the gate
    // can persist a cooldown (anti-flap).
    if (windowBudget === 0 && w.reset_at != null) {
      const reset: string = w.reset_at;
      if (exhaustedResetAt == null || reset < exhaustedResetAt) {
        exhaustedResetAt = reset;
      }
    }
    budget = budget == null ? windowBudget : Math.min(budget, windowBudget);
  }

  return { budget, calibrating, exhaustedResetAt };
}

function sumTopN(sorted: number[], n: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(n, sorted.length); i++) sum += sorted[i];
  return sum;
}

/**
 * Compute the wave size after applying the RPM cap, the TPM cap, and the
 * learned-limit cap — but BEFORE the token-budget gate and the host-concurrency
 * ceiling, both of which `scheduleWave` applies. Pure: it never mutates an outer
 * variable, so each cap is a single `Math.min` at the end of its branch.
 *
 * The host-concurrency limit and the token-budget gate are deliberately NOT
 * considered here — they are the only two things allowed to constrain
 * concurrency beyond real provider RPM/TPM/learned limits, and both are applied
 * by `scheduleWave`. With no learned history, no RPM/TPM, no host limit, and no
 * token budget signal, this function invents NO ceiling.
 */
/**
 * Result of the uncapped wave-size computation. `binding_cap` records which of
 * the RPM / TPM / learned caps last reduced the value (or "none" if nothing did),
 * so the caller can attribute the decision. The cooldown, token-budget, and
 * host-concurrency caps are applied by `scheduleWave` itself and folded into the
 * final `binding_cap` there.
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

  // Learned concurrency cap (from recorded safe/failure buckets). With no learned
  // history there is NO invented ceiling here: concurrency is governed solely by
  // real provider limits (RPM/TPM above), the host-reported subagent ceiling
  // (applied at the call site), and the token-budget gate (applied by
  // scheduleWave). An unconfigured provider with no signals stays uncapped.
  if (quotaStateEntry) {
    const rampUp = quota.ramp_up_enabled !== false;
    const cap = rampUp
      ? computeRampUpConcurrency(quotaStateEntry, halfLifeHours)
      : computeMaxSafeConcurrency(quotaStateEntry, halfLifeHours);
    if (cap < current) {
      current = cap;
      bindingCap = "learned";
    }
  }
  return { size: current, binding_cap: bindingCap };
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
    inFlightTokens = 0,
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
  // logic; otherwise apply RPM/TPM and learned caps. The token-budget gate and
  // host-concurrency ceiling are applied below.
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
      quota,
      halfLifeHours,
    });
    waveSize = uncapped.size;
    bindingCap = uncapped.binding_cap;
  }

  // Token-budget gate (the everything-agnostic live cap). When a live snapshot is
  // present and no cooldown is active, cap concurrency to the largest K whose
  // top-K slot tokens plus the pool's in-flight tokens fit the pool's remaining
  // token budget (MIN across the pool's own windows), safety-scaled. A window
  // that is (near) exhausted forces cooldown to its reset_at. A cold-start window
  // (no absolute tokens, no learned slope) admits a small calibration batch so
  // the run can observe Δutilization and seed the slope.
  // The remaining token budget the gate spent against (MIN across the pool's own
  // windows), stamped on the schedule so the host-facing summary surfaces the SAME
  // number the gate used — never a re-derived one. null when no live snapshot, or
  // cold-start (no absolute/learned budget for any window yet).
  let remainingTokenBudget: number | null = null;
  if (quotaSourceSnapshot && !cooldownUntil) {
    const { budget, calibrating, exhaustedResetAt } = deriveTokenBudget(
      quotaSourceSnapshot,
      quotaStateEntry?.tokens_per_pct,
    );
    remainingTokenBudget = budget;
    if (budget === 0) {
      // A genuinely empty window (remaining fraction 0 / absolute count 0):
      // throttle to 1 and persist a cooldown to its reset so a later transiently
      // -null snapshot cannot re-expand the walled pool (anti-flap, CE-010).
      const beforeBudget = waveSize;
      waveSize = 1;
      cooldownUntil = exhaustedResetAt ?? quotaSourceSnapshot.reset_at ?? cooldownUntil;
      if (cooldownUntil) bindingCap = "cooldown";
      else if (beforeBudget > 1) bindingCap = "token_budget";
    } else if (budget != null) {
      const budgetTokens = budget * safetyMargin;
      let k = waveSize;
      if (slotsSorted && slotsSorted.length > 0) {
        while (k > 1 && sumTopN(slotsSorted, k) + inFlightTokens > budgetTokens) k--;
      } else if (avgTokens > 0) {
        k = Math.max(1, Math.floor((budgetTokens - inFlightTokens) / avgTokens));
      }
      // If another of the pool's own windows is still cold (no absolute + no
      // learned slope), that window can't be budgeted yet — clamp to the
      // per-window cold-start batch too so a healthy window's budget can't
      // over-dispatch an un-calibrated one (MIN across the pool's windows).
      if (calibrating) k = Math.min(k, TOKEN_BUDGET_COLD_START_SLOTS);
      k = Math.max(1, k);
      if (k < waveSize) {
        waveSize = k;
        bindingCap = "token_budget";
      }
    } else if (calibrating) {
      // Cold start: no window has an absolute or learned budget. Admit a small
      // bounded batch to observe Δutilization and seed the slope — a bootstrap,
      // not a permanent ceiling.
      if (TOKEN_BUDGET_COLD_START_SLOTS < waveSize) {
        waveSize = TOKEN_BUDGET_COLD_START_SLOTS;
        bindingCap = "token_budget";
      }
    }
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
    remaining_token_budget: remainingTokenBudget,
    in_flight_tokens: inFlightTokens,
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
