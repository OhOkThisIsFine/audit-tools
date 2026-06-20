import type { CapacityPool } from "./capacity.js";
import type {
  DispatchableSource,
  ResolvedProviderName,
  SessionConfig,
} from "../types/sessionConfig.js";
import type { DispatchModelTier } from "../types/stepContract.js";
import type { HostConcurrencyLimit, QuotaStateEntry } from "./types.js";
import type { QuotaSource, QuotaProbeResult } from "./quotaSource.js";
import type { DiscoveredRateLimitsInput, HostModelRosterEntry } from "./scheduler.js";
import { probeQuotaSource } from "./quotaSource.js";
import { buildProviderModelKey } from "./scheduler.js";
import { hasConfiguredOpenAiCompatible } from "../providers/providerFactory.js";

/**
 * The stable id of a dispatchable source — its explicit `id`, or a
 * `${provider}:${model ?? endpoint}` key so two sources of the same provider stay
 * distinct as long as their model/endpoint differ. This is the CapacityPool id and
 * the key learned quota is recorded under.
 */
export function dispatchableSourceId(source: DispatchableSource): string {
  return source.id ?? buildProviderModelKey(source.provider, source.model ?? source.endpoint ?? null);
}

/**
 * Bridge a generic {@link DispatchableSource} to the concrete per-provider config
 * block its provider constructor expects, so `createFreshSessionProvider` can build
 * the right backend FROM the source (not the global block). `endpoint` + `parameters`
 * are interpreted per provider: the API base_url + sampling params for
 * `openai-compatible`; the launcher command + CLI args for the headless CLIs.
 */
export function sourceProviderConfig(source: DispatchableSource): Partial<SessionConfig> {
  const p = source.parameters ?? {};
  switch (source.provider) {
    case "openai-compatible":
      return {
        openai_compatible: {
          base_url: source.endpoint,
          model: source.model,
          api_key_env: source.api_key_env,
          api_key: source.api_key,
          ...p,
        },
      };
    case "codex":
      return { codex: { command: source.endpoint, model: source.model, ...p } };
    case "opencode":
      return { opencode: { command: source.endpoint, ...p } };
    case "subprocess-template":
      return {
        subprocess_template: {
          command_template: (p.command_template as string[] | undefined) ?? [],
          ...p,
        },
      };
    case "local-subprocess":
      // local-subprocess takes no construction config (host-dispatch default).
      return {};
  }
}

/**
 * Overlay a dispatchable source's per-provider config block onto the session config,
 * so `createFreshSessionProvider` builds the backend FROM that source — the launch
 * reads THIS source's `{endpoint, model, parameters}`, not the global block. This is
 * what lets two sources of the same provider (e.g. two NIM endpoints) launch
 * distinctly. A node on the host's own pool (no source) passes the config through.
 */
export function withSourceConfig(
  sessionConfig: SessionConfig,
  source: DispatchableSource | undefined,
): SessionConfig {
  return source ? { ...sessionConfig, ...sourceProviderConfig(source) } : sessionConfig;
}

/**
 * Assemble ONE host-model CapacityPool from already-resolved inputs — the shared
 * pool-shape + quota-probe core both orchestrators' host-pool builders use, so the
 * CapacityPool shape can't drift between them. The per-tool parts (the pool key and
 * the discovered-limits computation) are resolved by the caller and passed in.
 */
export async function buildHostModelPool(params: {
  poolKey: string;
  providerName: ResolvedProviderName;
  hostModel: string | null;
  rank?: DispatchModelTier;
  hostConcurrencyLimit: HostConcurrencyLimit | null;
  quotaStateEntry: QuotaStateEntry | null;
  discoveredLimits: DiscoveredRateLimitsInput | null;
  quotaSource: QuotaSource;
}): Promise<CapacityPool> {
  const probe = await probeQuotaSource(params.quotaSource, params.poolKey).catch(
    (): QuotaProbeResult => ({ snapshot: null, status: "degraded" }),
  );
  return {
    id: params.poolKey,
    providerName: params.providerName,
    hostModel: params.hostModel,
    ...(params.rank ? { rank: params.rank } : {}),
    hostConcurrencyLimit: params.hostConcurrencyLimit,
    quotaStateEntry: params.quotaStateEntry ?? null,
    discoveredLimits: params.discoveredLimits,
    quotaSourceSnapshot: probe.snapshot,
    ...(probe.status === "degraded" ? { quotaSignalDegraded: true } : {}),
  };
}

/**
 * Build a host-model CapacityPool per roster rank (or one pool for the scalar/absent
 * handshake) — the shared host-pool-from-roster core both orchestrators drive. The
 * caller's `resolve(entry)` supplies the only per-tool parts: the pool key and the
 * discovered-limits (audit merges capability + provider + cached limits; remediate
 * uses the roster/capability pair). Everything else — the roster iteration, the
 * learned-quota lookup, and the pool assembly — is shared. Audit layers its
 * contextBudget / tierBudget computation on top of the returned pools.
 */
export async function buildHostModelPools(params: {
  providerName: ResolvedProviderName;
  hostModel: string | null;
  hostConcurrencyLimit: HostConcurrencyLimit | null;
  quotaSource: QuotaSource;
  quotaEntries: Record<string, QuotaStateEntry>;
  roster: HostModelRosterEntry[] | null;
  resolve: (
    entry: HostModelRosterEntry | null,
  ) => Promise<{ poolKey: string; discoveredLimits: DiscoveredRateLimitsInput | null }> | {
    poolKey: string;
    discoveredLimits: DiscoveredRateLimitsInput | null;
  };
}): Promise<CapacityPool[]> {
  return Promise.all(
    (params.roster ?? [null]).map(async (entry) => {
      const { poolKey, discoveredLimits } = await params.resolve(entry);
      return buildHostModelPool({
        poolKey,
        providerName: params.providerName,
        hostModel: params.hostModel,
        rank: entry?.rank,
        hostConcurrencyLimit: params.hostConcurrencyLimit,
        quotaStateEntry: params.quotaEntries[poolKey] ?? null,
        discoveredLimits,
        quotaSource: params.quotaSource,
      });
    }),
  );
}

/** Index the source-backed pools by their pool id, for per-node provider resolution. */
export function sourceByPoolId(
  pools: Array<{ id: string; source?: DispatchableSource }>,
): Map<string, DispatchableSource> {
  const map = new Map<string, DispatchableSource>();
  for (const pool of pools) {
    if (pool.source) map.set(pool.id, pool.source);
  }
  return map;
}

/**
 * Build one CapacityPool for a configured dispatchable backend source — generic over
 * the source's provider. An independent backend pool: it does not draw on the host
 * subagent budget (`hostConcurrencyLimit: null`); its rate limits come from the
 * source's own `quota` (RPM/TPM/context/output) plus learned 429 state; it carries
 * its real-time quota probe (degraded → the raw `quotaSignalDegraded` marker). The
 * pool is TAGGED with its `source` so the dispatch worker rebuilds the provider from
 * the source's `{endpoint, model, parameters}`, not the global per-provider block.
 */
export async function buildSourcePool(params: {
  source: DispatchableSource;
  quotaSource: QuotaSource;
  quotaEntries: Record<string, QuotaStateEntry>;
}): Promise<CapacityPool> {
  const { source, quotaSource, quotaEntries } = params;
  const poolKey = dispatchableSourceId(source);
  const probe = await probeQuotaSource(quotaSource, poolKey).catch(
    (): QuotaProbeResult => ({ snapshot: null, status: "degraded" }),
  );
  return {
    id: poolKey,
    providerName: source.provider,
    hostModel: source.model ?? null,
    hostConcurrencyLimit: null,
    quotaStateEntry: quotaEntries[poolKey] ?? null,
    // QuotaModelLimits is structurally a DiscoveredRateLimitsInput (RPM/TPM/context/
    // output) — the operator-declared per-source rate limit feeds the S4 fold.
    discoveredLimits: source.quota ?? null,
    quotaSourceSnapshot: probe.snapshot,
    ...(probe.status === "degraded" ? { quotaSignalDegraded: true } : {}),
    source,
  };
}

/**
 * Every dispatchable backend source configured for a run, in pool order: the explicit
 * `sessionConfig.sources`, plus — for back-compat — a single implicit source folded in
 * from a legacy `openai_compatible` block when it isn't the primary provider and isn't
 * already covered by an explicit source of the same id.
 */
export function collectDispatchableSources(
  sessionConfig: SessionConfig,
  primaryProviderName: string,
): DispatchableSource[] {
  const out: DispatchableSource[] = [...(sessionConfig.sources ?? [])];
  if (
    primaryProviderName !== "openai-compatible" &&
    hasConfiguredOpenAiCompatible(sessionConfig.openai_compatible)
  ) {
    const oc = sessionConfig.openai_compatible!;
    const legacy: DispatchableSource = {
      provider: "openai-compatible",
      endpoint: oc.base_url,
      model: oc.model,
      api_key_env: oc.api_key_env,
      api_key: oc.api_key,
      parameters: {
        ...(oc.temperature !== undefined ? { temperature: oc.temperature } : {}),
        ...(oc.headers !== undefined ? { headers: oc.headers } : {}),
        ...(oc.max_output_tokens !== undefined ? { max_output_tokens: oc.max_output_tokens } : {}),
        ...(oc.response_format_json !== undefined ? { response_format_json: oc.response_format_json } : {}),
        ...(oc.include_referenced_files !== undefined
          ? { include_referenced_files: oc.include_referenced_files }
          : {}),
      },
    };
    const legacyId = dispatchableSourceId(legacy);
    if (!out.some((s) => dispatchableSourceId(s) === legacyId)) out.push(legacy);
  }
  return out;
}

/**
 * Build the CapacityPool for every configured dispatchable backend source (the
 * generalization of the former openai-compatible-only `buildConfiguredApiPool`): one
 * pool per source, the IDENTICAL shape across audit + remediate, so the spill topology
 * can't drift and the operator can configure ANY non-IDE source — multiple NIM/vLLM
 * endpoints, a CLI pool, … — each with its own rate limit.
 */
export async function buildSourcePools(params: {
  sessionConfig: SessionConfig;
  primaryProviderName: string;
  quotaSource: QuotaSource;
  quotaEntries: Record<string, QuotaStateEntry>;
}): Promise<CapacityPool[]> {
  const sources = collectDispatchableSources(params.sessionConfig, params.primaryProviderName);
  return Promise.all(
    sources.map((source) =>
      buildSourcePool({ source, quotaSource: params.quotaSource, quotaEntries: params.quotaEntries }),
    ),
  );
}
