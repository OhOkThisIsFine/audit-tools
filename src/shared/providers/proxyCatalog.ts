import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeJsonFile } from "../io/json.js";
import { resolveAuditCodeStateDir } from "../io/stateDir.js";
import type { DispatchableSource } from "../types/sessionConfig.js";
import { validateSessionConfig } from "../validation/sessionConfig.js";

/**
 * The POPULATE cache for the repair-proxy lane: `GET <proxy>/registry` expanded into
 * ready-to-fold `claude-worker` {@link DispatchableSource}s, written once per populate
 * (Gate-0 build / explicit refresh) and READ by resolve — never fetched mid-resolve
 * (`docs/reviews/commit3-proxy-kind1-transport-plan-2026-07-16.md` §populate/resolve).
 *
 * Named `catalog-cache.json`, NOT the `catalog-<auditor-id>.json` the reserved-name
 * comment at `auditorSources.ts` anticipates: populate/resolve run on the AMBIENT
 * path, where no auditor id exists to key on. The cache is machine-level like the
 * declaration beside it — and it is a CACHE of live registry state, not resolved
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

/** One registry entry after tolerant extraction (malformed entries are filtered, never thrown). */
interface RegistryModel {
  provider: string;
  model: string;
  score: number | null;
  /** Raw relative-capability rank (LOWER = better) when the registry exposes one. */
  capabilityRank: number | undefined;
  costPerMtok: number | undefined;
  contextTokens: number | undefined;
}

export interface PopulateProxyCatalogOptions {
  /** The repair-proxy base url (`GET <endpoint>/registry`). */
  endpoint: string;
  /** Models expanded per backend provider (declared `repair_proxy.top_k`); default {@link DEFAULT_PROXY_TOP_K}. */
  topK?: number;
  /**
   * Operator-declared blended $/Mtok for the proxied lane (`repair_proxy.cost_per_mtok`,
   * the free-to-operator axis). WINS over any registry list price.
   */
  costPerMtok?: number;
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
 * Best-effort "higher = better" score for ranking. A flat `score` wins; otherwise
 * the live repair-proxy's `capability` block supplies someone-else-maintained
 * relative-capability RANKS (`composite_rank`, then `arena_rank`; lower = better,
 * so negated). A model with none stays unscored and ranks last — capability-less
 * registry rows are frequently non-chat models (TTS, embeddings) that cannot serve
 * as agentic workers.
 */
function deriveScore(entry: Record<string, unknown>): number | null {
  if (typeof entry.score === "number" && Number.isFinite(entry.score)) {
    return entry.score;
  }
  const rank = deriveRawCapabilityRank(entry);
  return rank === undefined ? null : -rank;
}

/**
 * The RAW relative-capability rank (LOWER = better) from a registry entry's
 * capability block, when the active proxy exposes one — best-effort and
 * proxy-agnostic (a registry with no capability data yields undefined; the floor
 * then fails open per the owner decision, [[litellm-replaces-repair-proxy]]).
 * Stamped onto the expanded source as `capability_rank` (unified-routing step C)
 * so the admission floor reads per-model capability with no operator declaration.
 */
function deriveRawCapabilityRank(entry: Record<string, unknown>): number | undefined {
  const capability = entry.capability;
  if (capability === null || typeof capability !== "object") return undefined;
  return (
    finiteNonNegative((capability as Record<string, unknown>).composite_rank) ??
    finiteNonNegative((capability as Record<string, unknown>).arena_rank)
  );
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
 * Tolerantly extract `{provider, model, score, price}` rows from a registry payload,
 * keeping only entries this process could actually dispatch through: `reachable` AND
 * `has_key` must be literally `true` (the proxy's own liveness/credential verdicts).
 * Anything malformed — wrong types, missing provider/model — is FILTERED, never thrown:
 * a half-broken registry degrades to a smaller expansion, not a failed populate.
 */
function extractRegistryModels(payload: unknown): RegistryModel[] {
  // The registry is providers × live models; tolerate a flat entry array, a
  // `{providers|models|entries: [...]}` wrapper, or the live repair-proxy's
  // provider-MAP form (`providers: {<name>: {has_key, reachable, models: [...]}}`
  // — the name is the key, so it is folded into each entry as `name`), plus
  // per-provider nested `models` in every form.
  let container: unknown[] | undefined;
  if (Array.isArray(payload)) {
    container = payload;
  } else if (payload !== null && typeof payload === "object") {
    for (const key of ["providers", "models", "entries"]) {
      const wrapped = (payload as Record<string, unknown>)[key];
      if (Array.isArray(wrapped)) {
        container = wrapped;
        break;
      }
      if (wrapped !== null && typeof wrapped === "object") {
        container = Object.entries(wrapped).map(([name, entry]) =>
          entry !== null && typeof entry === "object"
            ? { name, ...(entry as Record<string, unknown>) }
            : entry,
        );
        break;
      }
    }
  }
  if (!Array.isArray(container)) return [];

  const models: RegistryModel[] = [];
  const push = (entry: Record<string, unknown>, provider: unknown, model: unknown) => {
    if (typeof provider !== "string" || provider.trim().length === 0) return;
    if (typeof model !== "string" || model.trim().length === 0) return;
    if (entry.reachable !== true || entry.has_key !== true) return;
    models.push({
      provider: provider.trim(),
      model: model.trim(),
      score: deriveScore(entry),
      capabilityRank: deriveRawCapabilityRank(entry),
      costPerMtok:
        finiteNonNegative(entry.cost_per_mtok) ??
        finiteNonNegative(entry.price_per_mtok) ??
        finiteNonNegative(entry.price),
      contextTokens: deriveContextTokens(entry),
    });
  };
  for (const raw of container) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const provider = entry.provider ?? entry.name;
    if (Array.isArray(entry.models)) {
      // Provider-grouped form: reachable/has_key live on the provider row; each
      // model row contributes id + score/price (and may override the flags).
      for (const rawModel of entry.models) {
        if (rawModel === null || typeof rawModel === "string") {
          if (typeof rawModel === "string") push(entry, provider, rawModel);
          continue;
        }
        if (typeof rawModel !== "object") continue;
        const model = rawModel as Record<string, unknown>;
        push(
          { ...entry, ...model, models: undefined },
          provider,
          model.id ?? model.model,
        );
      }
      continue;
    }
    push(entry, provider, entry.model ?? entry.id);
  }
  return models;
}

/**
 * Expand registry models into `claude-worker` sources: per reachable+keyed backend
 * provider, the top-K models by best-effort score (higher = better; unscored last).
 * Shape per the plan's identity section: the transport never enters the identity —
 * `backend_provider` + `model` key quota; `endpoint` is the proxy url the launch
 * transport (3b) fronts the spawn with; `worker_kind` is `agentic` by definition
 * (the whole point of the proxied lane is tool-call repair for a harness worker).
 */
function expandSources(
  models: RegistryModel[],
  options: { endpoint: string; topK: number; costPerMtok?: number },
): DispatchableSource[] {
  const byProvider = new Map<string, RegistryModel[]>();
  // Dedup by (provider, model): live registries list some models twice, and one
  // pool identity must expand to exactly one source (first row wins).
  const seen = new Set<string>();
  for (const model of models) {
    const identity = `${model.provider}/${model.model}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const bucket = byProvider.get(model.provider) ?? [];
    bucket.push(model);
    byProvider.set(model.provider, bucket);
  }
  const sources: DispatchableSource[] = [];
  // Stable, content-derived order (provider, then score desc, then model id) so a
  // re-populate over identical registry state emits byte-identical sources.
  for (const provider of [...byProvider.keys()].sort()) {
    const ranked = byProvider
      .get(provider)!
      .sort(
        (a, b) =>
          (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY) ||
          a.model.localeCompare(b.model),
      )
      .slice(0, options.topK);
    for (const model of ranked) {
      // Cost precedence: operator-declared (free-to-operator axis) > registry list
      // price > absent (falls through to the models.dev catalog / tier downstream).
      const cost = options.costPerMtok ?? model.costPerMtok;
      sources.push({
        id: `claude-worker:${provider}/${model.model}`,
        provider: "claude-worker",
        endpoint: options.endpoint,
        backend_provider: provider,
        model: model.model,
        worker_kind: "agentic",
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
 * Probe a single source to verify the model is actually reachable.
 * Returns { dropped: true, reason } if the model should be excluded (404/unavailable),
 * or { dropped: false } to keep the source.
 */
async function probeSource(
  source: DispatchableSource,
  endpoint: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ dropped: boolean; reason?: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": "audit-tools-populate-probe",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: `${source.backend_provider}/${source.model}`,
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

    // 200, 401, 429, 5xx, etc. → keep the source
    return { dropped: false };
  } catch (error) {
    // Transport failure (timeout, network error) → fail-open, keep the source
    return { dropped: false };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Run probes with bounded concurrency using a simple worker pool.
 */
async function probeSourcesWithConcurrency(
  sources: DispatchableSource[],
  endpoint: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  concurrency: number,
): Promise<Array<{ source: DispatchableSource; dropped: boolean; reason?: string }>> {
  const results: Array<{ source: DispatchableSource; dropped: boolean; reason?: string }> = [];
  let index = 0;

  const worker = async () => {
    while (index < sources.length) {
      const currentIndex = index++;
      const source = sources[currentIndex];
      const probeResult = await probeSource(source, endpoint, fetchImpl, timeoutMs);
      results[currentIndex] = {
        source,
        dropped: probeResult.dropped,
        reason: probeResult.reason,
      };
    }
  };

  const workers = Array(Math.min(concurrency, sources.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  // results is index-assigned (results[currentIndex] = ...), so it is already in
  // the sources' order regardless of probe completion order.
  return results;
}

/**
 * POPULATE: fetch `GET <endpoint>/registry` and write the expanded `claude-worker`
 * sources to the machine-level cache. Network-bound and cacheable — runs at Gate-0
 * build / explicit refresh, NEVER inside `resolveAmbientSources` (which only READS
 * via {@link readProxyCatalog}). Never throws: a failed fetch returns
 * `{written:false, reason}` and leaves any prior cache untouched; an empty/zero-match
 * registry WRITES an empty expansion (fresh knowledge — resolve reports the lane
 * unexpanded with a reason).
 */
export async function populateProxyCatalog(
  options: PopulateProxyCatalogOptions,
): Promise<PopulateProxyCatalogResult> {
  const endpoint = options.endpoint.replace(/\/+$/u, "");
  const doFetch = options.fetchImpl ?? fetch;

  // Freshness short-circuit: the populate trigger fires on EVERY
  // confirmation-absent next-step (nextStepCommand.ts), and populate now carries
  // live per-model probes — real `/v1/messages` POSTs through the proxy that cost
  // seconds of wall AND burn free-tier rate quota. A same-endpoint cache younger
  // than the TTL answers instead (measured 2026-07-17: per-invocation populate
  // was ~5.6s live, which alone pushed the e2e wrapper tests past their
  // timeouts). This is a REFRESH throttle, not staleness acceptance — the
  // no-TTL-on-READ residual (backlog: catalog accepted arbitrarily stale by
  // resolve) is unchanged.
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

  let payload: unknown;
  try {
    const response = await doFetch(`${endpoint}/registry`);
    if (!response.ok) {
      return {
        sources: [],
        written: false,
        reason: `GET ${endpoint}/registry returned HTTP ${response.status}.`,
        dropped: [],
      };
    }
    payload = await response.json();
  } catch (error) {
    return {
      sources: [],
      written: false,
      reason: `GET ${endpoint}/registry failed: ${error instanceof Error ? error.message : String(error)}.`,
      dropped: [],
    };
  }
  let sources = expandSources(extractRegistryModels(payload), {
    endpoint,
    topK: options.topK ?? DEFAULT_PROXY_TOP_K,
    costPerMtok: options.costPerMtok,
  });

  // Probe each source to verify reachability
  const probeResults = await probeSourcesWithConcurrency(
    sources,
    endpoint,
    doFetch,
    POPULATE_PROBE_TIMEOUT_MS,
    POPULATE_PROBE_CONCURRENCY,
  );

  const dropped: Array<{ id: string; reason: string }> = [];
  sources = probeResults
    .filter((result) => {
      if (result.dropped) {
        dropped.push({
          id: result.source.id ?? `claude-worker:${result.source.backend_provider}/${result.source.model}`,
          reason: result.reason ?? "model unavailable",
        });
        return false;
      }
      return true;
    })
    .map((result) => result.source);

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
