/**
 * repair-proxy `/registry` discovery → dispatchable sources.
 *
 * repair-proxy is an OpenAI-compatible multiplexer fronting many HTTP providers/models
 * behind ONE endpoint. This module reads its `GET {base_url}/registry`, selects a
 * cost-aware top-K model candidate set per reachable+keyed backend provider, and expands
 * each candidate into a {@link DispatchableSource} that dispatches through the UNCHANGED
 * `openai-compatible` transport (the proxy routes the namespaced `provider/model`).
 *
 * Fail-open by contract: the fetch degrades to `null` on ANY failure (network / non-200 /
 * malformed body) and `expandRepairProxySources` returns `[]` — a `/registry` outage must
 * NEVER throw into the source-gather path.
 *
 * Per-backend-provider quota accounting: each source's `account` = its backend provider,
 * so 429 / cooldown folds PER PROVIDER (via `foldAccountCooldownAcrossPools`), not per
 * proxy URL. The pool key stays `(provider, model, account)`.
 */

import type { DispatchableSource, RepairProxyConfig } from "../types/sessionConfig.js";

/** A model entry as it appears under a provider in the `/registry` body. */
export interface RegistryModel {
  id: string;
  capability: {
    bfcl_overall?: number | null;
    bfcl_multi_turn?: number | null;
    bfcl_irrelevance?: number | null;
    arena_rating?: number | null;
    arena_rank?: number | null;
    composite_rank?: number | null;
  } | null;
}

/** One backend provider block in the `/registry` body. */
export interface RegistryProvider {
  base?: string;
  kind?: string;
  has_key?: boolean;
  reachable?: boolean;
  models?: RegistryModel[];
}

/** The parsed `/registry` view we consume (only the fields this path reads). */
export interface RegistryView {
  providers: Record<string, RegistryProvider>;
}

/** A selected candidate: a concrete backend `provider/model` with optional cost/quota. */
export interface RepairProxyCandidate {
  provider: string;
  model: string;
  cost_per_mtok?: number;
  quota?: DispatchableSource["quota"];
  /**
   * The model's raw `composite_rank` (LOWER = better), carried onto the source so it
   * flows into cost-ranking as a cost-equal tiebreak. Absent when the registry model
   * has no `composite_rank` (the null-capability, sorts-last case).
   */
  capability_rank?: number;
}

const DEFAULT_TOP_K = 5;

/** Strip a trailing slash so `${base}/registry` never doubles it. */
function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * GET `${baseUrl}/registry`, parse, and return a {@link RegistryView}. Returns `null`
 * on ANY failure — a thrown fetch, a non-2xx response, or a body that doesn't parse to
 * the expected `{providers}` shape. Never throws.
 */
export async function fetchRepairProxyRegistry(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<RegistryView | null> {
  const url = `${trimTrailingSlash(baseUrl)}/registry`;
  try {
    const res = await fetchFn(url);
    if (!res || !res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body) || !isRecord(body.providers)) return null;
    return { providers: body.providers as Record<string, RegistryProvider> };
  } catch {
    return null;
  }
}

/**
 * A model's capability sort key: lower `composite_rank` = better. Models with no
 * capability (or no composite_rank) sort LAST via a `+Infinity` sentinel.
 */
function capabilityRankOf(model: RegistryModel): number {
  const rank = model.capability?.composite_rank;
  return typeof rank === "number" && Number.isFinite(rank) ? rank : Number.POSITIVE_INFINITY;
}

/**
 * Cost-aware top-K candidate set: for each provider that is `reachable && has_key`
 * (and not disabled via `cfg.providers[name].enabled === false`), take the top-K models
 * (default {@link DEFAULT_TOP_K}, overridable by `cfg.top_k`) ranked by capability —
 * lower `composite_rank` better, null-capability models last. `cost_per_mtok` is attached
 * from the operator's `cfg.providers[name].cost_per_mtok` override when declared (else
 * left undefined → resolved by models.dev at rank time).
 */
export function selectRepairProxyCandidates(
  registry: RegistryView,
  cfg: RepairProxyConfig,
): RepairProxyCandidate[] {
  const topK =
    typeof cfg.top_k === "number" && Number.isInteger(cfg.top_k) && cfg.top_k > 0
      ? cfg.top_k
      : DEFAULT_TOP_K;
  const out: RepairProxyCandidate[] = [];
  // Stable provider iteration order (registry object order is not guaranteed stable
  // across proxy restarts) so the candidate set is content-derived, not map-order.
  const providerNames = Object.keys(registry.providers).sort();
  for (const name of providerNames) {
    const provider = registry.providers[name];
    if (!provider || provider.reachable !== true || provider.has_key !== true) continue;
    if (cfg.providers?.[name]?.enabled === false) continue;
    const models = Array.isArray(provider.models) ? provider.models : [];
    // Rank by capability (lower composite_rank first), tie-break by model id for a
    // stable, content-derived order; then take the top-K.
    const ranked = [...models].sort((a, b) => {
      const byRank = capabilityRankOf(a) - capabilityRankOf(b);
      if (byRank !== 0) return byRank;
      return a.id.localeCompare(b.id);
    });
    const costOverride = cfg.providers?.[name]?.cost_per_mtok;
    for (const model of ranked.slice(0, topK)) {
      // Carry the raw composite_rank (LOWER = better) onto the candidate — the same
      // score used for the top-K ordering above becomes the downstream cost-equal
      // tiebreak. Omitted for null-capability models (the +Infinity sentinel).
      const rank = model.capability?.composite_rank;
      const capabilityRank =
        typeof rank === "number" && Number.isFinite(rank) ? rank : undefined;
      out.push({
        provider: name,
        model: model.id,
        ...(typeof costOverride === "number" ? { cost_per_mtok: costOverride } : {}),
        ...(capabilityRank !== undefined ? { capability_rank: capabilityRank } : {}),
      });
    }
  }
  return out;
}

/**
 * Fetch the registry + select candidates + map each to a {@link DispatchableSource}
 * dispatched through the `openai-compatible` transport against the proxy root. Returns
 * `[]` on a null registry (fail-open) so a `/registry` outage never breaks source-gather.
 *
 * Each source:
 * - `id: "repair-proxy/<provider>/<model>"` — stable, distinct per backend model.
 * - `provider: "openai-compatible"` — the unchanged HTTP transport.
 * - `endpoint`: the proxy ROOT (`OpenAiCompatibleProvider` appends `/chat/completions`).
 * - `model: "<provider>/<model>"` — namespaced; the proxy routes it to the backend.
 * - `account: "<provider>"` — so 429 / cooldown folds PER BACKEND PROVIDER.
 */
export async function expandRepairProxySources(
  cfg: RepairProxyConfig,
  fetchFn: typeof fetch = fetch,
): Promise<DispatchableSource[]> {
  const registry = await fetchRepairProxyRegistry(cfg.base_url, fetchFn);
  if (!registry) return [];
  const baseUrl = cfg.base_url;
  return selectRepairProxyCandidates(registry, cfg).map((candidate) => {
    // 429/cooldown fold axis: provider-wide by DEFAULT (one 429 propagates across all the
    // provider's models), or per-model when the operator flags this provider as having
    // distinct per-model rate limits. Per-pool token/concurrency limits stay per-model.
    const perModel = cfg.providers?.[candidate.provider]?.per_model_limits === true;
    const account = perModel ? `${candidate.provider}/${candidate.model}` : candidate.provider;
    return {
      id: `repair-proxy/${candidate.provider}/${candidate.model}`,
      provider: "openai-compatible" as const,
      endpoint: baseUrl,
      model: `${candidate.provider}/${candidate.model}`,
      ...(cfg.api_key_env !== undefined ? { api_key_env: cfg.api_key_env } : {}),
      account,
      ...(candidate.cost_per_mtok !== undefined ? { cost_per_mtok: candidate.cost_per_mtok } : {}),
      ...(candidate.quota !== undefined ? { quota: candidate.quota } : {}),
      ...(candidate.capability_rank != null ? { capability_rank: candidate.capability_rank } : {}),
    };
  });
}
