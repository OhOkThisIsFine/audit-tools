import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeJsonFile } from "../io/json.js";
import { resolveAuditCodeStateDir } from "../io/stateDir.js";
import type { DispatchableSource } from "../types/sessionConfig.js";
import { validateSessionConfig } from "../validation/sessionConfig.js";

/**
 * The POPULATE cache for the proxy lane: discovered via `GET <proxy>/v1/models` +
 * `GET <proxy>/model/info` (OpenAI-compatible surfaces) expanded into ready-to-fold
 * `claude-worker` {@link DispatchableSource}s, written once per populate (Gate-0 build
 * / explicit refresh) and READ by resolve — never fetched mid-resolve.
 *
 * Named `catalog-cache.json`, NOT the `catalog-<auditor-id>.json` the reserved-name
 * comment at `auditorSources.ts` anticipates: populate/resolve run on the AMBIENT
 * path, where no auditor id exists to key on. The cache is machine-level like the
 * declaration beside it — and it is a CACHE of live discovery state, not resolved
 * per-auditor capability, so an auditor-id key would assert an isolation the data
 * doesn't have. Per-auditor never-inherit still holds: every resolve re-proves proxy
 * REACH itself; the cache only supplies the expansion.
 */
export const PROXY_CATALOG_FILENAME = "catalog-cache.json";

/** Top-K models expanded per backend provider when the operator declares no `top_k`. */
export const DEFAULT_PROXY_TOP_K = 3;

/** Timeout (ms) for populate-time model verification probes. */
export const POPULATE_PROBE_TIMEOUT_MS = 3000;

/** Concurrency limit for populate-time model verification probes. */
export const POPULATE_PROBE_CONCURRENCY = 4;

/**
 * A same-endpoint cache younger than this skips the registry fetch + probes
 * entirely (see the freshness short-circuit in {@link populateProxyCatalog}).
 * Refresh throttle only — read-side staleness policy is a separate concern.
 */
export const POPULATE_CACHE_FRESH_TTL_MS = 10 * 60_000;

/** Resolve the populate-cache path for this machine (state dir via `io/stateDir.ts`). */
export function resolveProxyCatalogPath(homeDir?: string): string {
  return join(resolveAuditCodeStateDir(homeDir), PROXY_CATALOG_FILENAME);
}

/** The on-disk cache shape: expansion + when it was fetched (staleness policy later). */
export interface ProxyCatalog {
  /** ISO timestamp of the populate fetch. Read-side returns it; NO TTL is enforced yet. */
  fetched_at: string;
  /** The proxy endpoint the registry was fetched from. */
  endpoint: string;
  /** Expanded `claude-worker` sources, ready to fold into the dispatch pool. */
  sources: DispatchableSource[];
}

/**
 * Neutral proxy-contract model advert after shape adaptation.
 * Maps from proxy-specific field shapes (`/model/info` response) to a
 * generic contract. This is the edge adapter connecting proxy formats to generic types.
 */
interface ModelAdvert {
  alias: string;
  provider?: string;
  context_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  mode?: string;
  supports_tool_calls?: boolean;
  /** Operator-declared rank via advert custom key (when present). */
  declared_rank?: number;
}

/** One model after discovery + enrichment (malformed entries are filtered, never thrown). */
interface DiscoveredModel {
  alias: string;
  provider: string;
  score: number | null;
  /** Raw relative-capability rank (LOWER = better) when the advert exposes one. */
  capabilityRank: number | undefined;
  costPerMtok: number | undefined;
  contextTokens: number | undefined;
}

export interface PopulateProxyCatalogOptions {
  /** The proxy base url (`GET <endpoint>/v1/models`, `GET <endpoint>/model/info`). */
  endpoint: string;
  /** Models expanded per backend provider (declared `proxy.top_k`); default {@link DEFAULT_PROXY_TOP_K}. */
  topK?: number;
  /**
   * Operator-declared blended $/Mtok for the proxied lane (`proxy.cost_per_mtok`,
   * the free-to-operator axis). WINS over any advert price.
   */
  costPerMtok?: number;
  /** Env var holding the proxy's master key when authentication is required. */
  apiKeyEnv?: string;
  /** Injectable fetch (tests); defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Home dir override for the cache path (tests). */
  homeDir?: string;
  /** Clock (tests); defaults to `Date.now`-based ISO. */
  now?: () => Date;
}

export interface PopulateProxyCatalogResult {
  /** The expanded sources (also what was written when `written` is true). */
  sources: DispatchableSource[];
  /** Whether the cache file was (re)written. False only when the fetch itself failed. */
  written: boolean;
  /** Operator-facing explanation when the registry could not be fetched/parsed. */
  reason?: string;
  /** Models dropped during probe verification, with reasons. */
  dropped: Array<{ id: string; reason: string }>;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Edge adapter: proxy `/model/info` response shape → neutral ModelAdvert contract.
 * Maps from proxy-specific field names to a generic contract.
 *
 * Returns:
 * - { advert, filtered: false | undefined } for valid models
 * - { filtered: true } for models filtered by eligibility rules
 * - undefined for invalid data (missing modelName/model_info)
 */
function adaptProxyModelInfo(modelInfo: Record<string, unknown>): { advert?: ModelAdvert; filtered?: boolean } | undefined {
  const modelName = modelInfo.model_name;
  if (typeof modelName !== "string" || modelName.trim().length === 0) return undefined;

  const info = modelInfo.model_info;
  if (info === null || typeof info !== "object") return undefined;
  const infoObj = info as Record<string, unknown>;

  const proxyProvider = infoObj.litellm_provider;
  const provider = typeof proxyProvider === "string" ? proxyProvider : undefined;
  const mode = infoObj.mode;
  const supportsToolCalls = infoObj.supports_tool_calls;

  // Check eligibility: mode must be "chat" or absent (unknown ≠ incapable).
  // supports_tool_calls false → skip; absent or true → keep.
  if (typeof mode === "string" && mode !== "chat") return { filtered: true };
  if (supportsToolCalls === false) return { filtered: true };

  return {
    advert: {
      alias: modelName.trim(),
      ...(provider !== undefined ? { provider } : {}),
      context_tokens: finiteNonNegative(infoObj.max_input_tokens),
      input_cost_per_token: finiteNonNegative(infoObj.input_cost_per_token),
      output_cost_per_token: finiteNonNegative(infoObj.output_cost_per_token),
      mode: typeof mode === "string" ? mode : undefined,
      supports_tool_calls: typeof supportsToolCalls === "boolean" ? supportsToolCalls : undefined,
      // Operator-declared rank via advert custom key (consumed as-is when present).
      declared_rank: finiteNonNegative(infoObj.capability_rank),
    },
  };
}

/**
 * Best-effort "higher = better" score for ranking. Uses a flat `score` field
 * when present; absent/non-finite → null (unscored models rank last).
 */
function deriveScore(entry: Record<string, unknown>): number | null {
  if (typeof entry.score === "number" && Number.isFinite(entry.score)) {
    return entry.score;
  }
  return null;
}

/**
 * Tolerantly extract context-window field from a registry entry or its nested
 * `capability` block. Checks for `context_length`, `context_tokens`, `max_context`,
 * `context_window` (first finite positive number wins).
 */
function deriveContextTokens(entry: Record<string, unknown>): number | undefined {
  for (const key of ["context_length", "context_tokens", "max_context", "context_window"]) {
    const value = finiteNonNegative((entry as Record<string, unknown>)[key]);
    if (value !== undefined) return value;
  }
  const capability = entry.capability;
  if (capability !== null && typeof capability === "object") {
    for (const key of ["context_length", "context_tokens", "max_context", "context_window"]) {
      const value = finiteNonNegative((capability as Record<string, unknown>)[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

/**
 * Discover models via the neutral proxy contract: `GET /v1/models` (required baseline)
 * returns the alias roster; `GET /model/info` (optional enrichment) provides per-model
 * metadata. Tolerant at every step: missing/unparseable/malformed → graceful degradation.
 * Eligibility filters remove models from the pool entirely (mode != 'chat' or
 * supports_tool_calls === false).
 *
 * Returns { adverts, filtered } where adverts is a map of alias → ModelAdvert,
 * and filtered is a set of aliases that failed the eligibility filter.
 */
async function discoverModelAdverts(
  endpoint: string,
  fetchImpl: typeof fetch,
  authHeader?: string,
): Promise<{ adverts: Map<string, ModelAdvert>; filtered: Set<string> }> {
  const adverts = new Map<string, ModelAdvert>();
  const filtered = new Set<string>();
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authHeader) headers.authorization = authHeader;

    // Try /model/info first (richer advert); tolerate absent/unparseable
    try {
      const response = await fetchImpl(`${endpoint}/model/info`, { headers });
      if (response.ok) {
        const payload = await response.json();
        // Target the current array form: {data: [...]}
        if (payload !== null && typeof payload === "object") {
          const data = (payload as Record<string, unknown>).data;
          if (Array.isArray(data)) {
            for (const raw of data) {
              if (raw !== null && typeof raw === "object") {
                const result = adaptProxyModelInfo(raw as Record<string, unknown>);
                if (result) {
                  if (result.filtered) {
                    // Track which aliases failed the eligibility filter
                    const modelName = (raw as Record<string, unknown>).model_name;
                    if (typeof modelName === "string" && modelName.trim().length > 0) {
                      filtered.add(modelName.trim());
                    }
                  } else if (result.advert) {
                    // Successful adaptation
                    adverts.set(result.advert.alias, result.advert);
                  }
                }
                // If result is undefined, it's invalid data (not eligibility filter)
              }
            }
          }
        }
      }
    } catch {
      // /model/info absent/error → degrade to roster-only (no enrichment)
    }
  } catch {
    // No adverts → degrade to roster-only (carrier of aliases only)
  }
  return { adverts, filtered };
}

/**
 * Discover the model roster via the neutral proxy contract: `GET /v1/models`
 * (OpenAI-compatible list). Returns { aliases, error? }; absent/unparseable → empty aliases + reason.
 */
async function discoverModelRoster(
  endpoint: string,
  fetchImpl: typeof fetch,
  authHeader?: string,
): Promise<{ aliases: string[]; error?: string }> {
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authHeader) headers.authorization = authHeader;

    const response = await fetchImpl(`${endpoint}/v1/models`, { headers });
    if (!response.ok) {
      return {
        aliases: [],
        error: `HTTP ${response.status}`,
      };
    }

    const payload = await response.json();
    if (payload === null || typeof payload !== "object") return { aliases: [] };

    const data = (payload as Record<string, unknown>).data;
    if (!Array.isArray(data)) return { aliases: [] };

    const aliases: string[] = [];
    for (const entry of data) {
      if (entry !== null && typeof entry === "object") {
        const id = (entry as Record<string, unknown>).id;
        if (typeof id === "string" && id.trim().length > 0) {
          aliases.push(id.trim());
        }
      }
    }
    return { aliases };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { aliases: [], error: reason };
  }
}

/**
 * Expand discovered models into `claude-worker` sources: per backend provider,
 * the top-K models by best-effort score (higher = better; unscored last).
 * Shape per the plan's identity section: the transport never enters the identity —
 * `service` + `model` (alias) key quota; `endpoint` is the proxy url the
 * launch transport fronts the spawn with; `worker_kind` is `agentic` by definition.
 *
 * Provider derivation: advert `provider` (from /model/info) > slash-prefix of alias
 * (e.g., `anthropic/claude-*` → `anthropic`) > default shared `"proxy"` bucket
 * (coarse pool identity at degradation rung, revisitable per owner decision).
 */
function expandSources(
  discovered: DiscoveredModel[],
  options: { endpoint: string; topK: number; costPerMtok?: number; apiKeyEnv?: string },
): DispatchableSource[] {
  const byProvider = new Map<string, DiscoveredModel[]>();
  // Dedup by (provider, alias): first row wins.
  const seen = new Set<string>();
  for (const model of discovered) {
    const identity = `${model.provider}/${model.alias}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const bucket = byProvider.get(model.provider) ?? [];
    bucket.push(model);
    byProvider.set(model.provider, bucket);
  }
  const sources: DispatchableSource[] = [];
  // Stable, content-derived order (provider, then score desc, then alias) so
  // re-populate over identical state emits byte-identical sources.
  for (const provider of [...byProvider.keys()].sort()) {
    const ranked = byProvider
      .get(provider)!
      .sort(
        (a, b) =>
          (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY) ||
          a.alias.localeCompare(b.alias),
      )
      .slice(0, options.topK);
    for (const model of ranked) {
      // Cost precedence: operator-declared (free-to-operator axis) > advert price
      // > absent (falls through to models.dev catalog / tier downstream).
      const cost = options.costPerMtok ?? model.costPerMtok;
      sources.push({
        id: `claude-worker:${provider}/${model.alias}`,
        transport: "claude-worker",
        endpoint: options.endpoint,
        service: provider,
        model: model.alias, // Alias VERBATIM — the proxy's routing key
        worker_kind: "agentic",
        ...(options.apiKeyEnv !== undefined ? { api_key_env: options.apiKeyEnv } : {}),
        ...(cost !== undefined ? { cost_per_mtok: cost } : {}),
        // Step C: per-model capability (raw rank, LOWER = better) rides the source →
        // CapacityPool.declaredCapabilityRank → the admission capability floor.
        ...(model.capabilityRank !== undefined
          ? { capability_rank: model.capabilityRank }
          : {}),
        ...(model.contextTokens !== undefined
          ? { quota: { context_tokens: model.contextTokens } }
          : {}),
      });
    }
  }
  return sources;
}

/**
 * Probe a single model via Anthropic-compatible `/v1/messages` to verify it is
 * actually reachable. Returns { dropped: true, reason } if the model should be
 * excluded (404/unavailable), or { dropped: false } to keep it.
 */
async function probeModelViaMessages(
  alias: string,
  backendProvider: string,
  endpoint: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  authHeader?: string,
): Promise<{ dropped: boolean; reason?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    };
    if (authHeader) headers.authorization = authHeader;

    const response = await fetchImpl(`${endpoint}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: alias, // Route on proxy alias, not backend namespace
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
      signal: controller.signal,
    });

    // Check for 404 or model-not-found patterns
    if (response.status === 404) {
      return { dropped: true, reason: "HTTP 404" };
    }
    if (response.status >= 400) {
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        // If body read fails, just use status code
      }
      const patterns = [/model_not_found/i, /\bmay not exist\b/i, /no such model/i];
      if (patterns.some((p) => p.test(bodyText))) {
        return { dropped: true, reason: `HTTP ${response.status} (model unavailable)` };
      }
    }

    // 200, 401, 429, 5xx, etc. → keep the model
    return { dropped: false };
  } catch (error) {
    // Transport failure (timeout, network error) → fail-open, keep the model
    return { dropped: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Probe models with bounded concurrency using a simple worker pool.
 */
async function probeModelsWithConcurrency(
  aliases: string[],
  backendProvider: string,
  endpoint: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  concurrency: number,
  authHeader?: string,
): Promise<Array<{ alias: string; dropped: boolean; reason?: string }>> {
  const results: Array<{ alias: string; dropped: boolean; reason?: string }> = [];
  let index = 0;

  const worker = async () => {
    while (index < aliases.length) {
      const currentIndex = index++;
      const alias = aliases[currentIndex];
      const probeResult = await probeModelViaMessages(
        alias,
        backendProvider,
        endpoint,
        fetchImpl,
        timeoutMs,
        authHeader,
      );
      results[currentIndex] = {
        alias,
        dropped: probeResult.dropped,
        reason: probeResult.reason,
      };
    }
  };

  const workers = Array(Math.min(concurrency, aliases.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  // results is index-assigned, so already in order.
  return results;
}

/**
 * POPULATE: discover and expand models from an OpenAI-compatible proxy
 * (`GET <endpoint>/v1/models` + `GET <endpoint>/model/info`) into
 * ready-to-fold `claude-worker` sources, then write to the machine-level cache.
 * Network-bound and cacheable — runs at Gate-0 build / explicit refresh, NEVER
 * inside `resolveAmbientSources` (which only READS via {@link readProxyCatalog}).
 * Never throws: a failed fetch returns `{written:false, reason}` and leaves any
 * prior cache untouched; an empty discovery WRITES an empty expansion (fresh
 * knowledge — resolve reports the lane unexpanded with a reason).
 */
export async function populateProxyCatalog(
  options: PopulateProxyCatalogOptions,
): Promise<PopulateProxyCatalogResult> {
  const endpoint = options.endpoint.replace(/\/+$/u, "");
  const doFetch = options.fetchImpl ?? fetch;

  // Build auth header when api_key_env is declared and the env var is set.
  let authHeader: string | undefined;
  if (options.apiKeyEnv) {
    const keyValue = process.env[options.apiKeyEnv];
    if (keyValue?.trim()) {
      authHeader = `Bearer ${keyValue}`;
    }
  }

  // Freshness short-circuit: populate carries live per-model probes — real
  // `/v1/messages` POSTs through the proxy that cost seconds and burn quota.
  // A same-endpoint cache younger than the TTL answers instead. This is a
  // REFRESH throttle, not staleness acceptance — the no-TTL-on-READ residual
  // (backlog) is unchanged.
  const cached = readProxyCatalog({ homeDir: options.homeDir });
  if (cached && cached.endpoint === endpoint) {
    const nowMs = (options.now?.() ?? new Date()).getTime();
    const fetchedMs = Date.parse(cached.fetched_at);
    if (
      Number.isFinite(fetchedMs) &&
      nowMs - fetchedMs >= 0 &&
      nowMs - fetchedMs < POPULATE_CACHE_FRESH_TTL_MS
    ) {
      return {
        sources: cached.sources,
        written: false,
        reason: `cache is fresh (fetched ${Math.round((nowMs - fetchedMs) / 1000)}s ago); refresh skipped.`,
        dropped: [],
      };
    }
  }

  // Discover model roster (required baseline: /v1/models).
  const { aliases, error: rosterError } = await discoverModelRoster(endpoint, doFetch, authHeader);
  if (aliases.length === 0) {
    return {
      sources: [],
      written: false,
      reason: rosterError
        ? `GET ${endpoint}/v1/models failed: ${rosterError}`
        : `GET ${endpoint}/v1/models returned no models or was unreachable.`,
      dropped: [],
    };
  }

  // Discover model adverts (optional enrichment: /model/info).
  const { adverts, filtered } = await discoverModelAdverts(endpoint, doFetch, authHeader);

  // Build discovered models: join roster + adverts, deriving provider.
  const discovered: DiscoveredModel[] = [];
  for (const alias of aliases) {
    // Skip models that failed the eligibility filter
    if (filtered.has(alias)) continue;

    const advert = adverts.get(alias);

    // Provider derivation: advert provider > slash-prefix > default "proxy" bucket.
    let provider: string;
    if (advert?.provider) {
      provider = advert.provider;
    } else if (alias.includes("/")) {
      provider = alias.split("/")[0];
    } else {
      provider = "proxy";
    }

    // Cost blend: mean of input/output $/Mtok when both present; otherwise the one present.
    const availableCosts = [];
    if (advert?.input_cost_per_token !== undefined) availableCosts.push(advert.input_cost_per_token);
    if (advert?.output_cost_per_token !== undefined) availableCosts.push(advert.output_cost_per_token);

    let costPerMtok: number | undefined;
    if (availableCosts.length === 2) {
      costPerMtok = (availableCosts[0] + availableCosts[1]) / 2;
    } else if (availableCosts.length === 1) {
      costPerMtok = availableCosts[0];
    }

    discovered.push({
      alias,
      provider,
      score: advert?.declared_rank !== undefined ? -advert.declared_rank : null,
      capabilityRank: advert?.declared_rank,
      costPerMtok,
      contextTokens: advert?.context_tokens,
    });
  }

  // Probe to verify models are reachable and drop 404s.
  // Group by provider for parallel probing per provider.
  const byProvider = new Map<string, string[]>();
  for (const model of discovered) {
    const bucket = byProvider.get(model.provider) ?? [];
    bucket.push(model.alias);
    byProvider.set(model.provider, bucket);
  }

  const droppedAliases = new Set<string>();
  const dropped: Array<{ id: string; reason: string }> = [];

  for (const [provider, providerAliases] of byProvider) {
    const probeResults = await probeModelsWithConcurrency(
      providerAliases,
      provider,
      endpoint,
      doFetch,
      POPULATE_PROBE_TIMEOUT_MS,
      POPULATE_PROBE_CONCURRENCY,
      authHeader,
    );

    for (const result of probeResults) {
      if (result.dropped) {
        droppedAliases.add(result.alias);
        dropped.push({
          id: `claude-worker:${provider}/${result.alias}`,
          reason: result.reason ?? "model unavailable",
        });
      }
    }
  }

  // Filter out dropped models and expand sources.
  const toExpand = discovered.filter((m) => !droppedAliases.has(m.alias));
  let sources = expandSources(toExpand, {
    endpoint,
    topK: options.topK ?? DEFAULT_PROXY_TOP_K,
    costPerMtok: options.costPerMtok,
    apiKeyEnv: options.apiKeyEnv,
  });

  const catalog: ProxyCatalog = {
    fetched_at: (options.now?.() ?? new Date()).toISOString(),
    endpoint,
    sources,
  };
  const path = resolveProxyCatalogPath(options.homeDir);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeJsonFile(path, catalog);
  } catch (error) {
    return {
      sources,
      written: false,
      reason: `could not write ${path}: ${error instanceof Error ? error.message : String(error)}.`,
      dropped,
    };
  }
  return { sources, written: true, dropped };
}

export interface ReadProxyCatalogDeps {
  /** Home dir override for the cache path (tests). */
  homeDir?: string;
  /** Raw cache reader (tests inject); defaults to reading the cache file. */
  readCatalogFile?: (path: string) => string | null;
}

function defaultReadCatalogFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * READ the populate cache. Returns the entries + `fetched_at` (NO TTL enforcement —
 * staleness policy is a later commit; the caller decides). Degrades to `null` on
 * absent / unparseable / structurally-invalid content — never throws (same bar as
 * `readSourceDeclaration`: the resolve path must not be failable by a bad file).
 * Cached sources are held to the shared source validator, so a hand-edited or
 * version-skewed cache degrades to "no cache" rather than admitting a half-checked pool.
 */
export function readProxyCatalog(
  deps: ReadProxyCatalogDeps = {},
): ProxyCatalog | null {
  const path = resolveProxyCatalogPath(deps.homeDir);
  const raw = (deps.readCatalogFile ?? defaultReadCatalogFile)(path);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const { fetched_at, endpoint, sources } = parsed as Record<string, unknown>;
  if (typeof fetched_at !== "string" || typeof endpoint !== "string") return null;
  if (!Array.isArray(sources)) return null;
  const issues = validateSessionConfig({ sources });
  if (issues.some((issue) => issue.severity === "error")) return null;
  return { fetched_at, endpoint, sources: sources as DispatchableSource[] };
}
