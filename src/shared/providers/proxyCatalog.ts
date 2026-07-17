import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { writeJsonFile } from "../io/json.js";
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

/** `~/.audit-code` — the established home-dir state dir (mirrors `auditorSources.ts`). */
const STATE_DIR_NAME = ".audit-code";

/** Top-K models expanded per backend provider when the operator declares no `top_k`. */
export const DEFAULT_PROXY_TOP_K = 3;

/** Resolve the populate-cache path for this machine. */
export function resolveProxyCatalogPath(homeDir?: string): string {
  return join(homeDir ?? homedir(), STATE_DIR_NAME, PROXY_CATALOG_FILENAME);
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
  costPerMtok: number | undefined;
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
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * Tolerantly extract `{provider, model, score, price}` rows from a registry payload,
 * keeping only entries this process could actually dispatch through: `reachable` AND
 * `has_key` must be literally `true` (the proxy's own liveness/credential verdicts).
 * Anything malformed — wrong types, missing provider/model — is FILTERED, never thrown:
 * a half-broken registry degrades to a smaller expansion, not a failed populate.
 */
function extractRegistryModels(payload: unknown): RegistryModel[] {
  // The registry is providers × live models; tolerate either a flat entry array or a
  // `{providers|models|entries: [...]}` wrapper, and per-provider nested `models`.
  const container = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object"
      ? (["providers", "models", "entries"]
          .map((key) => (payload as Record<string, unknown>)[key])
          .find(Array.isArray) as unknown[] | undefined)
      : undefined;
  if (!Array.isArray(container)) return [];

  const models: RegistryModel[] = [];
  const push = (entry: Record<string, unknown>, provider: unknown, model: unknown) => {
    if (typeof provider !== "string" || provider.trim().length === 0) return;
    if (typeof model !== "string" || model.trim().length === 0) return;
    if (entry.reachable !== true || entry.has_key !== true) return;
    const score = entry.score;
    models.push({
      provider: provider.trim(),
      model: model.trim(),
      score: typeof score === "number" && Number.isFinite(score) ? score : null,
      costPerMtok:
        finiteNonNegative(entry.cost_per_mtok) ??
        finiteNonNegative(entry.price_per_mtok) ??
        finiteNonNegative(entry.price),
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
  for (const model of models) {
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
      });
    }
  }
  return sources;
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
  let payload: unknown;
  try {
    const response = await doFetch(`${endpoint}/registry`);
    if (!response.ok) {
      return {
        sources: [],
        written: false,
        reason: `GET ${endpoint}/registry returned HTTP ${response.status}.`,
      };
    }
    payload = await response.json();
  } catch (error) {
    return {
      sources: [],
      written: false,
      reason: `GET ${endpoint}/registry failed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  const sources = expandSources(extractRegistryModels(payload), {
    endpoint,
    topK: options.topK ?? DEFAULT_PROXY_TOP_K,
    costPerMtok: options.costPerMtok,
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
    };
  }
  return { sources, written: true };
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
