import type {
  DispatchableSource,
  ResolvedProviderName,
  SessionConfig,
} from "../types/sessionConfig.js";
import type { FreshSessionProvider, ProviderRateLimits } from "./types.js";
import {
  resolveFreshSessionProviderName,
  hasConfiguredOpenAiCompatible,
  hasConfiguredOpenCode,
} from "./providerFactory.js";
import { commandExists, isSelfSpawnBlocked } from "./providerPathGuard.js";
import { suggestCostOrdering, resolveModelPrice, type CostCandidate } from "../dispatch/costRank.js";
import type {
  ConfirmedPoolEntry,
  HostModelCostEntry,
  SourcePoolCostEntry,
  ProviderConfirmationInput,
} from "../types/providerConfirmation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CapabilityTier = "frontier" | "capable" | "fast" | "unknown";

export interface DiscoveredProvider {
  name: ResolvedProviderName;
  command?: string;
  capabilityTier: CapabilityTier;
  quotaState?: ProviderRateLimits | null;
  detected: boolean;
  /**
   * Machine-readable self-spawn-blocked flag. True when the provider is detected
   * on PATH but cannot be launched as a fresh subprocess because the host is
   * already inside an active session of that same agent (claude-code while
   * `CLAUDECODE` is set, codex while `CODEX` is set). The Gate-0 confirmation
   * EXCLUDES a self-spawn-blocked provider from the dispatchable pool unless the
   * operator explicitly includes it — a free-text `reason` string is advisory
   * only and must never be the thing a downstream consumer parses to make that
   * security decision.
   */
  selfSpawnBlocked?: boolean;
  reason?: string;
}

export interface ConfirmedProviderPool {
  providers: DiscoveredProvider[];
  excluded: ResolvedProviderName[];
  addedUndetected: DiscoveredProvider[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Default capability tier for a given provider name.
 *
 * This is a fallback used only when no session-config override is available.
 * Tiers are intentionally coarse and static here; the scheduler discovery
 * path (HostModelRosterEntry / DiscoveredRateLimitsInput) is the authoritative
 * source of per-model capability at dispatch time.
 *
 * INV-shared-core-02: provider-name → tier mapping must NOT be a flat lookup
 * table that gates dispatch routing. Capability tier on DiscoveredProvider is
 * a declared/discoverable input, not an opaque internal enum. This function
 * is the single place where a default is applied; all routing uses the
 * DispatchModelTier vocabulary on CapacityPool, not this field.
 */
function defaultCapabilityTier(name: ResolvedProviderName): CapabilityTier {
  switch (name) {
    case "claude-code":
      return "frontier";
    case "opencode":
    case "codex":
    case "openai-compatible":
    case "subprocess-template":
    case "vscode-task":
    case "antigravity":
    case "agy":
      return "capable";
    case "worker-command":
      return "unknown";
  }
}

/**
 * CLI probe table: maps the binary name as it appears on PATH to the canonical
 * ResolvedProviderName and any config command override to try first.
 */
interface CliProbe {
  providerName: ResolvedProviderName;
  /** Default CLI binary name when no config override present. */
  defaultCommand: string;
  /** Retrieve the configured command override from sessionConfig, if any. */
  configCommand: (cfg: SessionConfig) => string | undefined;
}

const CLI_PROBES: CliProbe[] = [
  {
    providerName: "claude-code",
    defaultCommand: "claude",
    configCommand: (cfg) => cfg.claude_code?.command,
  },
  {
    providerName: "opencode",
    defaultCommand: "opencode",
    configCommand: (cfg) => cfg.opencode?.command,
  },
  {
    providerName: "codex",
    defaultCommand: "codex",
    configCommand: (cfg) => cfg.codex?.command,
  },
  {
    providerName: "agy",
    defaultCommand: "agy",
    configCommand: (cfg) => {
      if (cfg.agy?.command) return cfg.agy.command;
      // Gated for July 18, 2026 sunset cleanup: fallback to gemini command
      if (commandExists("agy")) return "agy";
      if (commandExists("gemini")) return "gemini";
      return undefined;
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Probe PATH for each known CLI and return a DiscoveredProvider entry for each
 * detected tool. Uses `resolveFreshSessionProviderName` to honour session-config
 * overrides when determining which CLI name to probe.
 *
 * @param sessionConfig - Current session config (may be empty `{}`).
 * @param env           - Process env snapshot; defaults to `process.env`.
 * @param detectCommand - Injectable PATH-detection hook (defaults to the
 *   single-sourced `commandExists`). Lets tests drive discovery deterministically
 *   without a real CLI on PATH, so the self-spawn-blocked security obligations are
 *   testable red-before-green regardless of what is installed in CI.
 */
export function discoverProviders(
  sessionConfig: SessionConfig,
  env: NodeJS.ProcessEnv = process.env,
  detectCommand: (command: string) => boolean = commandExists,
): DiscoveredProvider[] {
  const discovered: DiscoveredProvider[] = [];

  for (const probe of CLI_PROBES) {
    const command =
      (probe.configCommand(sessionConfig) ?? "").trim() || probe.defaultCommand;
    const available = detectCommand(command);

    if (!available) continue;

    // PB-1: a bare-PATH opencode (no opencode.* config) is OPT-IN, not an
    // eligible auto-dispatch target. Surfacing it here would let it join the
    // confirmed pool and be launched unprompted. Only surface opencode when the
    // operator has explicitly configured it (opencode.command / opencode.extra_args);
    // all other PATH-detected providers are surfaced as before.
    if (probe.providerName === "opencode" && !hasConfiguredOpenCode(sessionConfig)) {
      continue;
    }

    // Self-spawn guard: mirror providerFactory — don't surface claude-code when
    // already inside a claude-code session, codex when inside codex, etc.
    const resolvedName = resolveFreshSessionProviderName("auto", sessionConfig, {
      env,
      commandExists: (cmd: string) => cmd === command,
    });

    // Machine-readable self-spawn-blocked flag, derived from the single-sourced
    // guard. A self-spawn-blocked provider is still SURFACED (the operator may
    // override) but carries the flag so Gate-0 can EXCLUDE it from the
    // dispatchable pool without parsing the advisory `reason` string.
    const blocked = isSelfSpawnBlocked(probe.providerName, env);

    discovered.push({
      name: probe.providerName,
      command,
      capabilityTier: defaultCapabilityTier(probe.providerName),
      detected: true,
      selfSpawnBlocked: blocked,
      reason: blocked
        ? `detected on PATH but cannot self-spawn from within an active ${probe.providerName} session`
        : resolvedName === probe.providerName
          ? undefined
          : `detected on PATH; auto-resolution may prefer a higher-priority provider`,
    });
  }

  // openai-compatible (NIM / vLLM / LM Studio / …) is an API pool, not a CLI: it
  // is config-gated (base_url + model), never PATH-probed, so the CLI loop above
  // can't surface it. Surface it here when configured so it joins the confirmed
  // pool as a real spill target (INV-QD-14) alongside the PATH-detected CLIs.
  if (hasConfiguredOpenAiCompatible(sessionConfig.openai_compatible)) {
    discovered.push({
      name: "openai-compatible",
      command: sessionConfig.openai_compatible?.model,
      capabilityTier: defaultCapabilityTier("openai-compatible"),
      detected: true,
      reason: "configured background API pool (base_url + model); not PATH-probed",
    });
  }

  return discovered;
}

/**
 * Query the rate-limit state from a live provider if the `queryLimits` method
 * is available. Returns `null` on timeout/error — never throws.
 *
 * OBS-9a9091ad: a `queryLimits` rejection was previously swallowed with no
 * signal, so a provider whose rate-limit query consistently fails was invisible
 * to operators (the sibling CompositeQuotaSource logs the same swallow). Accept
 * an optional injectable `log` (mirroring analyzerDeps' injectable-log pattern)
 * that is invoked with the provider name + error on the swallowed-error path.
 * The contract is unchanged — `log` is optional, the function still never throws
 * and still returns null — so existing callers need no change while a caller
 * that cares can route the diagnostic into its RunLogger.
 */
export async function queryProviderQuota(
  provider: DiscoveredProvider,
  freshSessionProvider: FreshSessionProvider,
  log?: (providerName: string, error: unknown) => void,
): Promise<ProviderRateLimits | null> {
  if (typeof freshSessionProvider.queryLimits !== "function") {
    return null;
  }
  try {
    return await freshSessionProvider.queryLimits(null);
  } catch (error) {
    log?.(provider.name, error);
    return null;
  }
}

/**
 * Apply user selections to the discovered pool, returning a ConfirmedProviderPool
 * suitable for persistence in SessionConfig.confirmed_provider_pool.
 *
 * @param discovered      - Output of `discoverProviders`.
 * @param exclude         - Provider names to remove from the pool.
 * @param addUndetected   - Manually specified providers not found on PATH.
 */
/**
 * The representative model id a provider is priced/ordered by at Gate-0 (cost-first
 * routing; spec/cost-first-routing.md). Only the providers that carry a configured
 * model in session config are knowable here — a host-native model roster and a CLI
 * backend's model arrive only at the dispatch handshake, so those return `undefined`
 * and are priced deterministically at dispatch instead. Never hardcodes a model
 * name; reads only operator-supplied config.
 */
export function representativeModelId(
  name: ResolvedProviderName,
  sessionConfig: SessionConfig,
): string | undefined {
  switch (name) {
    case "openai-compatible":
      return sessionConfig.openai_compatible?.model?.trim() || undefined;
    case "codex":
      return sessionConfig.codex?.model?.trim() || undefined;
    default:
      return undefined;
  }
}

/** A confirmed pool annotated with cost-first fields, plus any host-model tiers. */
export interface AnnotatedConfirmation {
  /** Provider-keyed pool, each entry carrying model_id/price/cost_order. */
  provider_pool: ConfirmedPoolEntry[];
  /**
   * Host self-reported model tiers with their confirmed positions (follow-up c),
   * kept separate from `provider_pool` so no pool consumer sees duplicate names.
   */
  host_model_cost_order: HostModelCostEntry[];
  /**
   * Dispatchable SOURCE pools (explicit `sources[]` + repair-proxy expansion) with
   * their confirmed positions (Gate-0 source fold). Kept separate from `provider_pool`
   * because a source is keyed by `(provider, model)`, not a single provider name.
   */
  source_pool_cost_order: SourcePoolCostEntry[];
}

/** Stable source id (matches `deriveSourcePoolDisplay` / the dispatch id convention). */
function dispatchSourceKey(source: DispatchableSource): string {
  return source.id ?? `${source.provider}:${source.model ?? source.endpoint ?? "default"}`;
}

/**
 * Internal candidate key for a source in the unified cost ordering. Prefixed so a source's
 * operator-set id can never collide with a provider-NAME key or a host `model_id` key in
 * the shared position map (they share one keyspace in `resolveFinalCostOrder`) — a collision
 * would let one entry's `cost_order` silently overwrite the other's. The prefix is internal
 * only; the emitted `source_id` + the operator `cost_order` keyspace are unaffected.
 */
function sourceCandidateKey(source: DispatchableSource): string {
  return `source::${dispatchSourceKey(source)}`;
}

/**
 * Resolve the FINAL 0-based cost position for every candidate key. Without an
 * operator ordering this is the tool's price-ascending suggestion. With one, the
 * operator's `cost_order` wins for the keys it names (dense from 0, unknown keys
 * ignored); candidates it omits keep their suggested relative order, appended
 * after. Single-sourced so provider pools and host models share one total order.
 */
function resolveFinalCostOrder(
  candidates: CostCandidate[],
  operatorOrder?: string[],
): Map<string, number> {
  const suggested = suggestCostOrdering(candidates);
  if (!operatorOrder || operatorOrder.length === 0) {
    return new Map(suggested.map((c) => [c.key, c.suggested_order]));
  }
  const knownKeys = new Set(candidates.map((c) => c.key));
  const seen = new Set<string>();
  const orderedNamed: string[] = [];
  for (const key of operatorOrder) {
    if (knownKeys.has(key) && !seen.has(key)) {
      seen.add(key);
      orderedNamed.push(key);
    }
  }
  const rest = suggested.map((c) => c.key).filter((k) => !seen.has(k));
  const finalOrder = [...orderedNamed, ...rest];
  return new Map(finalOrder.map((key, index) => [key, index]));
}

/**
 * Annotate + order a confirmed pool with cost-first-routing fields, optionally
 * applying an operator Gate-0 input. Each provider entry gets its representative
 * `model_id`, `blended_price_usd_per_mtok` (or `null` when the dataset can't price
 * it), and a `cost_order`. When `input` is absent this is the tool's
 * price-ascending SUGGESTION (headless / no-operator path). When present, the
 * operator's `cost_order` overrides the suggested positions and each
 * `host_models` entry becomes a priced, orderable candidate whose confirmed
 * position threads to dispatch by `model_id` via `host_model_cost_order`. Read
 * back at dispatch (`resolveConfirmedCostPositions`) as rung 1 of `costRank`.
 * Single-sourced so every confirmation site annotates identically.
 */
export function annotateConfirmedPool(
  pool: ConfirmedPoolEntry[],
  sessionConfig: SessionConfig,
  input?: ProviderConfirmationInput,
  sources: DispatchableSource[] = [],
): AnnotatedConfirmation {
  const hostModels = input?.host_models ?? [];
  const providerCandidates: CostCandidate[] = pool.map((entry) => ({
    key: entry.name,
    model: representativeModelId(entry.name, sessionConfig),
  }));
  // tier is omitted: it only tiebreaks UNPRICED candidates, and HostRosterModel's
  // CapabilityTier is a different vocabulary from CostCandidate's DispatchModelTier
  // — host models are keyed + priced by model_id, which is what threads to dispatch.
  const hostCandidates: CostCandidate[] = hostModels.map((m) => ({
    key: m.model_id,
    model: m.model_id,
  }));
  // Gate-0 source fold: every dispatchable source pool (explicit sources[] + repair-proxy
  // expansion) becomes a ranked candidate, keyed by its stable source id so a namespaced
  // `provider/model` never collides with a provider-name key. Each carries its declared
  // cost (authoritative; 0 = free) and raw capability rank so the suggestion is truthful
  // and the capability tiebreak applies among cost-equal source pools.
  const sourceCandidates: CostCandidate[] = sources.map((source) => ({
    key: sourceCandidateKey(source),
    model: source.model ?? null,
    provider: source.provider,
    ...(source.cost_per_mtok !== undefined ? { declaredCost: source.cost_per_mtok } : {}),
    ...(source.capability_rank != null ? { capabilityRank: source.capability_rank } : {}),
  }));
  const positions = resolveFinalCostOrder(
    [...providerCandidates, ...hostCandidates, ...sourceCandidates],
    input?.cost_order,
  );
  const provider_pool = pool.map((entry) => {
    const model = representativeModelId(entry.name, sessionConfig);
    const order = positions.get(entry.name);
    return {
      ...entry,
      ...(model ? { model_id: model } : {}),
      blended_price_usd_per_mtok: model ? resolveModelPrice(model) ?? null : null,
      ...(order !== undefined ? { cost_order: order } : {}),
    };
  });
  const host_model_cost_order: HostModelCostEntry[] = hostModels.map((m) => ({
    model_id: m.model_id,
    blended_price_usd_per_mtok: resolveModelPrice(m.model_id) ?? null,
    cost_order: positions.get(m.model_id) ?? 0,
  }));
  const source_pool_cost_order: SourcePoolCostEntry[] = sources.map((source) => {
    const key = sourceCandidateKey(source);
    const declared =
      typeof source.cost_per_mtok === "number" && Number.isFinite(source.cost_per_mtok) && source.cost_per_mtok >= 0
        ? source.cost_per_mtok
        : undefined;
    const price =
      declared ?? (source.model ? resolveModelPrice(source.model, source.provider) ?? null : null);
    return {
      source_id: dispatchSourceKey(source),
      provider: source.provider,
      ...(source.model ? { model_id: source.model } : {}),
      blended_price_usd_per_mtok: price,
      price_declared: declared !== undefined,
      ...(source.capability_rank != null ? { capability_rank: source.capability_rank } : {}),
      cost_order: positions.get(key) ?? 0,
    };
  });
  return { provider_pool, host_model_cost_order, source_pool_cost_order };
}

/**
 * The suggestion-only annotation (no operator input, no host models). Preserved
 * for the headless / auto-complete callers that just need the provider pool with
 * the tool's price-ascending `cost_order`. Delegates to `annotateConfirmedPool`.
 */
export function annotateConfirmedPoolCost(
  pool: ConfirmedPoolEntry[],
  sessionConfig: SessionConfig,
): ConfirmedPoolEntry[] {
  return annotateConfirmedPool(pool, sessionConfig).provider_pool;
}

export function applyProviderConfirmationSelections(
  discovered: DiscoveredProvider[],
  exclude: ResolvedProviderName[],
  addUndetected: DiscoveredProvider[],
): ConfirmedProviderPool {
  const excludeSet = new Set<ResolvedProviderName>(exclude);
  const filtered = discovered.filter((p) => !excludeSet.has(p.name));
  const undetectedNormalized = addUndetected.map((p) => ({
    ...p,
    detected: false,
  }));
  return {
    providers: [...filtered, ...undetectedNormalized],
    excluded: exclude,
    addedUndetected: undetectedNormalized,
  };
}

// ---------------------------------------------------------------------------
// sources[] roster display (Gate-0 backlog follow-up a)
// ---------------------------------------------------------------------------

/**
 * Display-only view of one `sessionConfig.sources[]` pool for the Gate-0 roster.
 *
 * Backlog gap (a): `discoverProviders`/`buildSharedProviderConfirmation` only ever
 * looked at PATH-probed CLIs + the legacy `openai_compatible` block, so an explicit
 * `sources[]` pool (e.g. an opencode-free endpoint) never appeared at Gate-0 even
 * though `collectDispatchableSources` (apiPool.ts) folds EVERY `sources[]` entry
 * into what actually dispatches — the operator was confirming an ordering that
 * omitted pools that WILL route. This type/derivation is display-only: it never
 * round-trips through `ConfirmedPoolEntry` / the persisted `SharedProviderConfirmation`,
 * so it can't perturb the existing cost_order/dispatch contract.
 */
export interface SourcePoolDisplayEntry {
  /**
   * Same id convention the dispatch side uses (explicit `id`, else
   * `${provider}:${model ?? endpoint ?? "default"}`) — display-only, not a
   * guaranteed exact match of the dispatch-side pool key.
   */
  id: string;
  provider: DispatchableSource["provider"];
  model?: string;
  /**
   * Operator-declared `cost_per_mtok` on this source. Authoritative over the
   * models.dev catalog price when present (mirrors the dispatch-side authority
   * rule on `DispatchableSource.cost_per_mtok` — see sessionConfig.ts).
   */
  declared_cost_per_mtok?: number;
  /**
   * models.dev blended price, computed only when the source has no declared cost
   * and a model id is known; `null` when the dataset can't price it.
   */
  blended_price_usd_per_mtok?: number | null;
}

/**
 * Derive the Gate-0 display view of every configured `sessionConfig.sources[]`
 * entry (backlog follow-up a). Read-only and additive: mirrors the same
 * `sessionConfig.sources` array `collectDispatchableSources` (apiPool.ts) folds
 * into dispatch, so what the operator sees at Gate-0 includes every pool that will
 * actually route. Order is preserved from the operator-authored config array
 * (content-derived, stable — never re-sorted by iteration/readdir order).
 */
export function deriveSourcePoolDisplay(
  sessionConfig: SessionConfig,
): SourcePoolDisplayEntry[] {
  return deriveSourcePoolDisplayFromSources(sessionConfig.sources ?? []);
}

/**
 * Same display derivation as {@link deriveSourcePoolDisplay} but over an EXPLICIT source
 * list — used by the Gate-0 confirmation display so the roster includes the async
 * repair-proxy `/registry` expansion (which is not in `sessionConfig.sources`), matching
 * exactly what {@link gatherDispatchableSources} folds into dispatch.
 */
export function deriveSourcePoolDisplayFromSources(
  sources: DispatchableSource[],
): SourcePoolDisplayEntry[] {
  return sources.map((source) => {
    const id =
      source.id ?? `${source.provider}:${source.model ?? source.endpoint ?? "default"}`;
    const entry: SourcePoolDisplayEntry = {
      id,
      provider: source.provider,
      ...(source.model ? { model: source.model } : {}),
      ...(source.cost_per_mtok !== undefined
        ? { declared_cost_per_mtok: source.cost_per_mtok }
        : {}),
    };
    if (source.cost_per_mtok === undefined) {
      entry.blended_price_usd_per_mtok = source.model
        ? (resolveModelPrice(source.model) ?? null)
        : null;
    }
    return entry;
  });
}
