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
import { probeQuotaSource, resolveAccountIdSafe } from "./quotaSource.js";
import { buildProviderModelKey } from "./scheduler.js";
import { parseProviderModelKey } from "./httpQuotaSource.js";
import { buildAccountScopedQuotaSource } from "./compositeQuotaSource.js";
import { deriveLocalAccountId, foldAccountCooldown } from "./accountId.js";
import { classifyQuotaCoverage, sourceCoversProvider } from "./coverage.js";
import { hasConfiguredOpenAiCompatible } from "../providers/providerFactory.js";
import { resolveConversationHostProvider } from "../providers/providerPathGuard.js";

/**
 * The stable id of a dispatchable source — its explicit `id`, or a
 * `${provider}:${model ?? endpoint}` key so two sources of the same provider stay
 * distinct as long as their model/endpoint differ. This is the CapacityPool id and
 * the key learned quota is recorded under.
 */
export function dispatchableSourceId(source: DispatchableSource, account?: string | null): string {
  if (source.id) return account ? `${source.id}#${account}` : source.id;
  return buildProviderModelKey(source.provider, source.model ?? source.endpoint ?? null, account);
}

/**
 * A source's declared in-flight COUNT cap, normalized to a positive integer or null
 * (uncapped). Anything non-finite, ≤ 0, or fractional degrades to null rather than a
 * value that would either wedge the rolling engine (0 ⇒ zero admits) or violate the
 * summary schema's `min(1)`. The "0 = unlimited" operator convention maps to null.
 */
function positiveIntCapOrNull(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}

/**
 * A source's operator-declared `$/Mtok`, normalized to a non-negative finite number
 * or null (unknown → fall through to the models.dev price / tier at rank time). `0`
 * is a VALID declaration (a genuinely-free backend) and is preserved; only a
 * negative / non-finite value degrades to null so it can never be trusted as "free".
 */
function nonNegativeCostOrNull(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
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
    case "worker-command":
      // worker-command takes no construction config (host-dispatch default).
      return {};
    case "agy":
      return {
        agy: {
          command: source.endpoint,
          model: source.model,
          ...p,
        },
      };
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
 *
 * `hostModel` is DERIVED from `poolKey` (never accepted as a separate scalar) so the
 * pool is correct-by-construction: `pool.hostModel === parseProviderModelKey(pool.id).model`
 * always holds. A roster builds one pool per rank with a distinct per-rank model in
 * the key; passing a single scalar host model alongside would mis-stamp every
 * non-primary pool, which is the leak this seam closes. See {@link buildHostModelPools}.
 */
export async function buildHostModelPool(params: {
  poolKey: string;
  providerName: ResolvedProviderName;
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
    hostModel: parseProviderModelKey(params.poolKey).model,
    ...(params.rank ? { rank: params.rank } : {}),
    hostConcurrencyLimit: params.hostConcurrencyLimit,
    quotaStateEntry: params.quotaStateEntry ?? null,
    discoveredLimits: params.discoveredLimits,
    quotaSourceSnapshot: probe.snapshot,
    ...(probe.status === "degraded" ? { quotaSignalDegraded: true } : {}),
    quotaCoverage: classifyQuotaCoverage(
      params.providerName,
      sourceCoversProvider(params.quotaSource, params.providerName),
    ),
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
  // Resolve the host account ONCE from the host credential, then fold it into every
  // roster pool key — so the host's pools are keyed on its own (provider, account)
  // and never alias a same-provider dispatch source on a different account (§5).
  const hostAccount = await resolveAccountIdSafe(
    params.quotaSource,
    buildProviderModelKey(params.providerName, params.hostModel),
  );
  return Promise.all(
    (params.roster ?? [null]).map(async (entry) => {
      const resolved = await params.resolve(entry);
      // Re-key with the host account (the caller builds an account-less key; recover
      // its provider/model and re-stamp). Account-null → key is unchanged.
      const parsed = parseProviderModelKey(resolved.poolKey);
      const poolKey = buildProviderModelKey(parsed.provider, parsed.model, hostAccount);
      return buildHostModelPool({
        poolKey,
        providerName: params.providerName,
        rank: entry?.rank,
        hostConcurrencyLimit: params.hostConcurrencyLimit,
        quotaStateEntry: params.quotaEntries[poolKey] ?? null,
        discoveredLimits: resolved.discoveredLimits,
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
  // Scope the probe + account read to THIS source's own credential when it declares
  // one, so a same-provider second-account source forms a distinct pool (§5b).
  const scoped = buildAccountScopedQuotaSource(source, quotaSource);
  // Account: explicit override > read from the source's credential. A provider-shaped
  // key carries the provider for gating regardless of any explicit source.id.
  const account =
    source.account ??
    (await resolveAccountIdSafe(
      scoped,
      buildProviderModelKey(source.provider, source.model ?? source.endpoint ?? null),
    ));
  const poolKey = dispatchableSourceId(source, account);
  const probe = await probeQuotaSource(scoped, poolKey).catch(
    (): QuotaProbeResult => ({ snapshot: null, status: "degraded" }),
  );
  return {
    id: poolKey,
    providerName: source.provider,
    // Both the pool key (via dispatchableSourceId) and hostModel are derived from
    // THIS one source, so they cannot leak apart: for a provider-shaped key the model
    // segment is exactly `source.model ?? source.endpoint`; an explicit-`id` source is
    // launched from `source.{endpoint,model,parameters}` (not from a recovered key), so
    // its hostModel stays the source's own declared model rather than a parse of a
    // non-provider-shaped id. The single-source derivation is the invariant here.
    hostModel: source.model ?? null,
    hostConcurrencyLimit: null,
    // Endpoint-declared in-flight COUNT cap (independent of the host subagent
    // budget, which stays null for a backend source). Without it an optimistic
    // unmetered source (no token snapshot) dispatches every ready packet at once
    // and overruns the endpoint — the NIM `33/32` incident. A non-positive /
    // non-finite `max_concurrent` (incl. the "0 = unlimited" convention) clamps to
    // null (uncapped) — never 0, which would ceiling the pool to zero in-flight and
    // wedge the rolling engine, and would also violate the summary schema's min(1).
    concurrencyCap: positiveIntCapOrNull(source.quota?.max_concurrent),
    // Operator-declared a-priori $/Mtok for this endpoint → the admission cost rank
    // (rung 2, authoritative over the models.dev catalog). 0 = declared-free → routes
    // first. null when unset/invalid ⇒ falls through to the catalog price / tier.
    declaredCostPerMtok: nonNegativeCostOrNull(source.cost_per_mtok),
    quotaStateEntry: quotaEntries[poolKey] ?? null,
    // QuotaModelLimits is structurally a DiscoveredRateLimitsInput (RPM/TPM/context/
    // output) — the operator-declared per-source rate limit feeds the S4 fold.
    discoveredLimits: source.quota ?? null,
    quotaSourceSnapshot: probe.snapshot,
    ...(probe.status === "degraded" ? { quotaSignalDegraded: true } : {}),
    quotaCoverage: classifyQuotaCoverage(source.provider, sourceCoversProvider(scoped, source.provider)),
    source,
  };
}

/**
 * The in-process backends that can be DEMOTED to a source pool when an attended host
 * drives (defect-1): the API/CLI worker backends. Excludes `worker-command` /
 * `subprocess-template` — those are host-dispatch defaults, not standalone source
 * pools to fan out onto alongside the host.
 */
const DEMOTABLE_IN_PROCESS_PROVIDERS: ReadonlySet<string> = new Set([
  "openai-compatible",
  "codex",
  "opencode",
]);

/**
 * Whether a provider is an in-process backend that DEMOTES to a source pool when an
 * attended host drives (defect-1): the API/CLI worker backends only. Callers gate the
 * in-process-monopoly branch on this so an attended host fans out onto the backend as a
 * source (host + backend + NIM concurrent) while a non-demotable in-process provider
 * (`subprocess-template` / `worker-command`, which carry no standalone source pool)
 * keeps self-driving. Also the discriminator for demoting the host-pool identity back
 * to the conversation host when the configured primary is one of these backends.
 */
export function isDemotableInProcessProvider(providerName: string | undefined): boolean {
  return providerName !== undefined && DEMOTABLE_IN_PROCESS_PROVIDERS.has(providerName);
}

/**
 * Whether an attended host should DEMOTE its configured primary in-process backend
 * to a separate source pool (defect-1 concurrent fan-out). True only when the host
 * can dispatch subagents AND the primary is a demotable backend AND — the B1
 * same-agent guard — the resolved CONVERSATION HOST is a DIFFERENT provider than
 * that backend.
 *
 * The same-agent guard is load-bearing: the primary demoted source shares the
 * host's own credential (it carries no `credentials_path`), so when the host
 * provider equals the primary provider they are ONE account. Emitting both a
 * host pool AND a demoted-source pool for that one account double-books its
 * budget/concurrency and — because `dispatchableSourceId` falls through to the
 * same `buildProviderModelKey` format the host pool uses — can even collide on a
 * single pool id. In that case there is no distinct host to fan out alongside;
 * the host self-drives the backend as its single pool. Single-sourced so audit
 * and remediate apply the identical guard. [[host-provider-misattribution-nim-codex]]
 */
export function shouldDemotePrimaryInProcess(options: {
  sessionConfig: SessionConfig | null | undefined;
  hostCanDispatch: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  if (!options.hostCanDispatch) return false;
  const provider = options.sessionConfig?.provider;
  if (!isDemotableInProcessProvider(provider)) return false;
  const conversationHost = resolveConversationHostProvider({
    sessionConfig: options.sessionConfig,
    env: options.env,
  });
  return conversationHost !== provider;
}

/** Build a DispatchableSource for a configured `openai_compatible` block (the legacy
 * NIM source shape), reused by both the back-compat fold and the primary demote. */
function openAiCompatibleSource(
  oc: NonNullable<SessionConfig["openai_compatible"]>,
): DispatchableSource {
  return {
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
      ...(oc.referenced_files_max !== undefined ? { referenced_files_max: oc.referenced_files_max } : {}),
      ...(oc.referenced_file_byte_cap !== undefined
        ? { referenced_file_byte_cap: oc.referenced_file_byte_cap }
        : {}),
      ...(oc.referenced_files_total_byte_cap !== undefined
        ? { referenced_files_total_byte_cap: oc.referenced_files_total_byte_cap }
        : {}),
    },
    // C1: converge the legacy block's budget onto the source-pool quota so a
    // configured window/concurrency reaches buildSourcePool's discoveredLimits /
    // concurrencyCap instead of the default context/output floor. Absent quota
    // stays undefined → the conservative floor, exactly as before.
    ...(oc.quota !== undefined ? { quota: oc.quota } : {}),
  };
}

/**
 * The DispatchableSource for the primary in-process backend, built from its own config
 * block, so an attended host can fan out onto it as a source pool ALONGSIDE its own
 * subagents (defect-1: host + codex + NIM concurrent, no backend monopoly). Returns
 * null when the primary provider is not a demotable in-process backend, or its config
 * block is absent. The dispatch worker rebuilds the concrete provider from this
 * source's `{endpoint, model, parameters}` via `withSourceConfig`.
 */
export function primaryInProcessSource(
  sessionConfig: SessionConfig,
  primaryProviderName: string,
): DispatchableSource | null {
  if (!DEMOTABLE_IN_PROCESS_PROVIDERS.has(primaryProviderName)) return null;
  switch (primaryProviderName) {
    case "openai-compatible":
      return hasConfiguredOpenAiCompatible(sessionConfig.openai_compatible)
        ? openAiCompatibleSource(sessionConfig.openai_compatible!)
        : null;
    case "codex": {
      const c = sessionConfig.codex ?? {};
      return {
        provider: "codex",
        ...(c.command !== undefined ? { endpoint: c.command } : {}),
        ...(c.model !== undefined ? { model: c.model } : {}),
        parameters: {
          ...(c.sandbox_mode !== undefined ? { sandbox_mode: c.sandbox_mode } : {}),
          ...(c.extra_args !== undefined ? { extra_args: c.extra_args } : {}),
        },
      };
    }
    case "opencode": {
      const o = sessionConfig.opencode ?? {};
      return {
        provider: "opencode",
        ...(o.command !== undefined ? { endpoint: o.command } : {}),
        parameters: {
          ...(o.extra_args !== undefined ? { extra_args: o.extra_args } : {}),
        },
      };
    }
  }
  return null;
}

/**
 * Every dispatchable backend source configured for a run, in pool order: the explicit
 * `sessionConfig.sources`, optionally the DEMOTED primary in-process backend (defect-1,
 * when an attended host drives — `demotePrimaryInProcess`), plus — for back-compat — a
 * single implicit source folded in from a legacy `openai_compatible` block when it
 * isn't the primary provider and isn't already covered by an explicit source of the
 * same id.
 */
export function collectDispatchableSources(
  sessionConfig: SessionConfig,
  primaryProviderName: string,
  options?: { demotePrimaryInProcess?: boolean },
): DispatchableSource[] {
  const out: DispatchableSource[] = [...(sessionConfig.sources ?? [])];
  const pushUnique = (source: DispatchableSource): void => {
    const id = dispatchableSourceId(source);
    if (!out.some((s) => dispatchableSourceId(s) === id)) out.push(source);
  };
  // Defect-1: an attended host demotes its configured primary in-process backend to a
  // source pool so it fans out ALONGSIDE the host's subagents rather than monopolizing
  // the frontier. Inert (null) when the primary is the conversation host / an IDE.
  if (options?.demotePrimaryInProcess) {
    const demoted = primaryInProcessSource(sessionConfig, primaryProviderName);
    if (demoted) pushUnique(demoted);
  }
  if (
    primaryProviderName !== "openai-compatible" &&
    hasConfiguredOpenAiCompatible(sessionConfig.openai_compatible)
  ) {
    pushUnique(openAiCompatibleSource(sessionConfig.openai_compatible!));
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
  /** Defect-1: demote the primary in-process backend to a source when an attended host drives. */
  demotePrimaryInProcess?: boolean;
}): Promise<CapacityPool[]> {
  const sources = collectDispatchableSources(params.sessionConfig, params.primaryProviderName, {
    demotePrimaryInProcess: params.demotePrimaryInProcess,
  });
  const pools = await Promise.all(
    sources.map((source) =>
      buildSourcePool({ source, quotaSource: params.quotaSource, quotaEntries: params.quotaEntries }),
    ),
  );
  return foldAccountCooldownAcrossPools(pools);
}

/**
 * Re-derive each pool's `quotaStateEntry` by folding in the account-scoped
 * cooldown/429 signal from its siblings (Bug 3 / Slice A3: account-axis pool
 * identity). Applied ONCE across the whole freshly-built pool set — after
 * this, every pool's frozen `quotaStateEntry` already reflects the worst
 * cooldown its account has seen, so a peer whose OWN key never recorded a 429
 * still shows up degraded. This is the construction-time counterpart to the
 * live fold `selectProvider` applies mid-run in `rollingDispatch.ts` (same
 * {@link foldAccountCooldown} primitive, single-sourced). A pool with no
 * derivable account (not `openai-compatible`, missing endpoint/api_key_env, or
 * an explicit `source.account` override) is returned unchanged.
 */
function foldAccountCooldownAcrossPools(pools: CapacityPool[]): CapacityPool[] {
  return pools.map((pool) => {
    const accountId = pool.source ? deriveLocalAccountId(pool.source) : null;
    if (!accountId) return pool;
    const siblingEntries = pools
      .filter((p) => p !== pool && p.source && deriveLocalAccountId(p.source) === accountId)
      .map((p) => p.quotaStateEntry ?? null);
    if (siblingEntries.length === 0) return pool;
    const folded = foldAccountCooldown(pool.quotaStateEntry ?? null, siblingEntries);
    return folded === (pool.quotaStateEntry ?? null) ? pool : { ...pool, quotaStateEntry: folded };
  });
}
