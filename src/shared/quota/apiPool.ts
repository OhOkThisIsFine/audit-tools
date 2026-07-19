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
import {
  accountKeyFromProviderShapedKey,
  deriveAccountKey,
  deriveLocalAccountId,
  foldAccountCooldown,
} from "./accountId.js";
import { classifyQuotaCoverage, sourceCoversProvider } from "./coverage.js";
import { resolveModelStatics } from "./modelStatics.js";
import { DEFAULT_CONTEXT_TOKENS } from "../tokens.js";
import type { DispatchExclusion } from "../providers/sharedProviderConfirmation.js";
import { hasConfiguredOpenAiCompatible } from "../providers/providerFactory.js";
import {
  isHeadlessPrimaryProvider,
  isInProcessWorkerProvider,
} from "../providers/inProcessWorkers.js";

/**
 * The stable id of a dispatchable source — its explicit `id`, or the quota-ledger
 * pool identity `provider[#account]/(model ?? endpoint ?? *)` ({@link buildProviderModelKey})
 * so two sources of the same provider stay distinct as long as their model/endpoint
 * differ. This is the CapacityPool id and the key learned quota is recorded under.
 *
 * ⚠ Keyspace (1) of three, and NOT the `provider:model` operator exclusion grammar
 * (`DispatchExclusionPattern`) it superficially resembles — an account is load-bearing
 * here (the double-grant boundary) and irrelevant to a rule about a backend. Nor is it
 * the gate's `model_id ?? provider` compare key. Do not unify them.
 */
export function dispatchableSourceId(source: DispatchableSource, account?: string | null): string {
  // Transport-fronted lane (3c): the transport NEVER enters the quota identity. A
  // source declaring `backend_provider` keys on the BACKEND actually serving it —
  // `backend_provider[#account]/model` — so a proxied `claude-worker` lane and a
  // direct lane to the same backend DEDUP to ONE CapacityPool / ledger entry (the
  // `(provider, account)` double-grant boundary). This deliberately outranks an
  // explicit `id`: the populate cache stamps transport-shaped ids
  // (`claude-worker:<backend>/<model>`), and honoring them would re-split the
  // identity the field exists to merge. The declared `account` folds in even when
  // the caller resolves none, so two same-backend lanes on different accounts stay
  // distinct (the gather-time dedup path passes no account).
  if (source.backend_provider) {
    return buildProviderModelKey(
      source.backend_provider,
      source.model ?? source.endpoint ?? null,
      account ?? source.account ?? null,
    );
  }
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
 * The effective per-request context window (tokens) for a dispatchable source — a
 * positive integer that is NEVER null. This is the invariant that makes context-fit
 * gating REAL: a `null` cap meant "unknown ⇒ always fits", which silently no-op'd
 * every fit gate for a proxy pool whose registry entry carried no context field (the
 * 2026-07-17 host-only-collapse root cause — oversized packets were dispatched and
 * 413'd instead of being skipped). Fallback chain:
 *   1. operator/registry-declared `quota.context_tokens` (the stamp populate sets),
 *   2. else the BACKEND model's models.dev window (`resolveModelStatics(model,
 *      backend_provider ?? provider)` — a synced, someone-else-maintained table),
 *   3. else the blind `DEFAULT_CONTEXT_TOKENS` floor.
 * Single-sourced (exported) as the one fit-window resolver. Only `buildSourcePool`
 * stamps it — host-model pools carry no `contextCapTokens` and gate (on the admission
 * path) against their own per-pool `resolved_limits` window instead; the admission
 * builder folds the two (`context_cap_tokens ?? resolved_limits.context_tokens`) so
 * BOTH pool classes share one fit predicate (unified-routing step B).
 */
export function resolveSourceContextWindowTokens(source: DispatchableSource): number {
  const declared = positiveIntCapOrNull(source.quota?.context_tokens);
  if (declared !== null) return declared;
  const statics = resolveModelStatics(
    source.model ?? null,
    source.backend_provider ?? source.provider,
  );
  const fromCatalog = positiveIntCapOrNull(statics?.context_tokens);
  if (fromCatalog !== null) return fromCatalog;
  return DEFAULT_CONTEXT_TOKENS;
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
 * A source's raw capability rank (registry `composite_rank`, LOWER = more capable),
 * normalized to a finite number or null. Absent / non-finite ⇒ null (no finer
 * capability signal → admission falls back to the tier ordinal alone). No sign
 * constraint: a rank is a relative ordinal, not a cost.
 */
function finiteRankOrNull(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
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
    case "claude-worker":
      // The proxied isolated worker launches FROM the source itself: endpoint = the
      // proxy url ClaudeWorkerProvider fronts the spawn with, and model = the proxy
      // alias (routing key). `parameters` may carry the launcher tuning (command /
      // prompt_flag / extra_args / dangerously_skip_permissions).
      return {
        claude_worker: {
          endpoint: source.endpoint,
          backend_provider: source.backend_provider,
          model: source.model,
          ...(source.api_key_env !== undefined ? { api_key_env: source.api_key_env } : {}),
          ...p,
        },
      };
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
    // Host pool keys are provider-shaped by construction (buildProviderModelKey), so
    // the account segment is recoverable from the key here — unlike a source pool,
    // whose key may be an opaque operator-declared id.
    accountKey: accountKeyFromProviderShapedKey(params.poolKey),
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
    // The account comes from the SOURCE DECLARATION, not from `poolKey` — an
    // explicitly declared `source.id` is returned verbatim by `dispatchableSourceId`,
    // so two models on one credential (`nim-nano`, `nim-super`) yield keys with no
    // shared substring. Falls back to the pool key when the source declares neither an
    // account nor a credential we can identify: an unattributable pool meters alone
    // rather than joining someone else's allowance.
    accountKey: deriveAccountKey({ ...source, account }) ?? poolKey,
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
    // Effective per-request context window — NEVER null (declared quota.context_tokens
    // → backend model's models.dev window → DEFAULT_CONTEXT_TOKENS). A null cap used to
    // mean "always fits", which no-op'd every fit gate for a registry pool carrying no
    // context field; resolving to a concrete window means an oversized packet is skipped,
    // not 413'd. See resolveSourceContextWindowTokens.
    contextCapTokens: resolveSourceContextWindowTokens(source),
    // Operator-declared a-priori $/Mtok for this endpoint → the admission cost rank
    // (rung 2, authoritative over the models.dev catalog). 0 = declared-free → routes
    // first. null when unset/invalid ⇒ falls through to the catalog price / tier.
    declaredCostPerMtok: nonNegativeCostOrNull(source.cost_per_mtok),
    // Raw per-model capability rank (LOWER = more capable) → the host-path admission
    // tiebreak among cost-equal, same-tier pools. Finite-or-null; a non-finite value
    // degrades to null (no finer signal) rather than poisoning the comparator.
    declaredCapabilityRank: finiteRankOrNull(source.capability_rank),
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

/** Build a DispatchableSource for a configured `openai_compatible` block (the legacy
 * NIM source shape), reused by both the back-compat fold and the primary fold. */
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
 * block, so the primary is just a SOURCE POOL in the one eligible pool set (H2+H4
 * collapse): an attended host fans out onto it alongside its own subagents, and a
 * headless run's engine drives it as an ordinary member pool — there is no demote
 * flag and no monopoly branch. Returns null when the primary provider is not a
 * self-drivable in-process backend under the DRAW's policy (`commandWorkers` —
 * remediate admits the command-shaped backends, audit does not), or its config block
 * is absent where one is required. The dispatch worker rebuilds the concrete provider
 * from this source's `{endpoint, model, parameters}` via `withSourceConfig`.
 */
export function primaryInProcessSource(
  sessionConfig: SessionConfig,
  primaryProviderName: string,
  options?: { commandWorkers?: boolean },
): DispatchableSource | null {
  if (!isHeadlessPrimaryProvider(primaryProviderName, options)) return null;
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
    // D4: agy needs an EXPLICIT synthesis case (it does not "fall out" of un-gating):
    // without one, an attended `provider: agy` run would have NO pool and — with the
    // monopoly branch gone — no dispatch at all. Synthesized from its config block,
    // mirroring `sourceProviderConfig`'s agy mapping (command→endpoint, model→model).
    case "agy": {
      const a = sessionConfig.agy ?? {};
      return {
        provider: "agy",
        ...(a.command !== undefined ? { endpoint: a.command } : {}),
        ...(a.model !== undefined ? { model: a.model } : {}),
        parameters: {
          ...(a.extra_args !== undefined ? { extra_args: a.extra_args } : {}),
          ...(a.dangerously_skip_permissions !== undefined
            ? { dangerously_skip_permissions: a.dangerously_skip_permissions }
            : {}),
        },
      };
    }
    // D3 (command-shaped primaries — reachable only under a draw whose policy sets
    // `commandWorkers: true`, i.e. remediate): without these an attended run whose
    // primary is command-shaped would silently lose ALL dispatch
    // ([[silent-fail-closed-on-one-draw]] class).
    case "subprocess-template": {
      const s = sessionConfig.subprocess_template;
      // The template block is the whole launch contract — absent/empty ⇒ no pool
      // (mirrors the unconfigured openai-compatible case).
      if (!s || s.command_template.length === 0) return null;
      return {
        provider: "subprocess-template",
        parameters: {
          command_template: s.command_template,
          ...(s.env !== undefined ? { env: s.env } : {}),
        },
      };
    }
    case "worker-command":
      // No session-level config block exists for worker-command: each node carries
      // its own `task.worker_command`, resolved at dispatch. A bare provider source
      // is the correct pool identity.
      return { provider: "worker-command" };
  }
  return null;
}

/**
 * Every dispatchable backend source configured for a run, in pool order: the explicit
 * `sessionConfig.sources`, the primary in-process backend folded in UNCONDITIONALLY
 * (H2+H4 collapse: the primary is just a source pool — there is no demote flag; which
 * providers fold is the draw's `commandWorkers` policy), plus — for back-compat — a
 * single implicit source folded in from a legacy `openai_compatible` block when it
 * isn't the primary provider and isn't already covered by an explicit source of the
 * same id.
 */
export function collectDispatchableSources(
  sessionConfig: SessionConfig,
  primaryProviderName: string,
  options?: { commandWorkers?: boolean },
): DispatchableSource[] {
  const out: DispatchableSource[] = [...(sessionConfig.sources ?? [])];
  const pushUnique = (source: DispatchableSource): void => {
    const id = dispatchableSourceId(source);
    if (!out.some((s) => dispatchableSourceId(s) === id)) out.push(source);
  };
  // The unconditional primary fold: a self-drivable in-process primary is a member
  // pool of the ONE eligible set, whether the run is attended (host + backend + NIM
  // fan out concurrently) or headless (the engine drives it as its pool). Inert
  // (null) when the primary is the conversation host / an IDE, or the draw's policy
  // excludes a command-shaped primary.
  {
    const primary = primaryInProcessSource(sessionConfig, primaryProviderName, options);
    if (primary) pushUnique(primary);
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
 * The FULL dispatchable source list for a run — the configured
 * `collectDispatchableSources` set. The single async source-gather point: both the
 * dispatch pool builder ({@link buildSourcePools}) and the Gate-0 confirmation surface
 * consume it, so what the operator confirms is exactly what routes (no display/dispatch
 * drift on the source set). Async is retained as the stable seam for the per-auditor
 * inventory resolution the handshake will feed here.
 */
export async function gatherDispatchableSources(
  sessionConfig: SessionConfig,
  primaryProviderName: string,
  options?: { commandWorkers?: boolean },
): Promise<DispatchableSource[]> {
  return collectDispatchableSources(sessionConfig, primaryProviderName, options);
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
  /** The draw's fold policy: admit command-shaped primaries (remediate) or not (audit). */
  commandWorkers?: boolean;
  /**
   * The backends the operator ruled out at Gate-0, plus any recomputed as
   * self-spawn-blocked in THIS process (`resolveDispatchExclusion`). Applied as a
   * set-difference over freshly-gathered reach — never additively.
   *
   * A matcher rather than a name set because the grammar is MODEL-granular
   * (`provider:model`): excluding one model of a multi-model backend must leave that
   * backend's other sources routable, which a provider-name set cannot express.
   *
   * Filtered HERE, on the routing side, rather than inside
   * {@link gatherDispatchableSources}: the gather also feeds the Gate-0 confirmation
   * display, where an excluded provider must stay VISIBLE and marked excluded so the
   * operator can see it and opt it back in. Display and routing diverge deliberately.
   *
   * Omit ⇒ no filtering (the pool build is unaware of Gate-0), so a caller that has
   * no confirmation to read behaves exactly as before.
   */
  excludedBackends?: DispatchExclusion;
}): Promise<CapacityPool[]> {
  const gathered = await gatherDispatchableSources(params.sessionConfig, params.primaryProviderName, {
    commandWorkers: params.commandWorkers,
  });
  const excluded = params.excludedBackends;
  const sources = excluded
    ? gathered.filter((source) => !excluded.excludes(source))
    : gathered;
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
/**
 * Cross-class host-vs-source pool dedup (H2+H4 collapse, plan D1) — the ONE shared
 * collision rule both draws apply when assembling their eligible pool set. With the
 * primary in-process backend folded in UNCONDITIONALLY, the attended host's pool
 * identity can collide with a folded source's `dispatchableSourceId` (the classic
 * case: conversation host codex + `provider: codex` — one credential, one account;
 * emitting both pools double-books that one meter and can collide on a single pool
 * id, the retired B1 same-agent guard's bug class
 * [[host-provider-misattribution-nim-codex]]).
 *
 * Collision = same provider identity on the same account axis. Provider identity is
 * the BACKEND when the source declares one (`backend_provider` — a proxied lane onto
 * the host's own backend is exactly the double-grant this guards; review h2c3 F5),
 * else the pool's providerName. The account compare is DIRECTIONAL (review h2c3 F3):
 * a source with NO declared account collides on provider alone — the synthesized
 * primary fold shares the host credential by construction — but a source with an
 * EXPLICIT account collides only when the host's account resolves equal; a host
 * whose account is merely unresolved (dark credential) must never lose its lane to
 * a source declared on a DIFFERENT account. Deliberately NOT model-granular: the
 * double-grant boundary this protects is `(provider, account)`, not the model axis.
 *
 * Survivor rule (D1): on collision the SOURCE/engine pool survives when its provider
 * is an in-process worker — the engine drives that one account and the host has no
 * separate pool to double-book (preserving self-drive for attended
 * provider=codex=host); the HOST pool survives otherwise (a host-shaped identity is
 * not an engine-drivable source).
 *
 * `hostProviderName` serves the draw whose host is NOT a member pool (audit, plan
 * D6: the host is the coverage-driven complement): with no host pools to drop, the
 * rule degenerates to dropping a colliding non-in-process source.
 */
export function dedupHostAndSourcePools(params: {
  hostPools: CapacityPool[];
  sourcePools: CapacityPool[];
  /** Attended host identity for a draw whose host is not a member pool (audit). */
  hostProviderName?: ResolvedProviderName | null;
  /**
   * The DRAW's worker policy for the D1 survivor rule (remediate admits
   * command-shaped workers; audit does not) — a command-shaped source can only
   * survive a collision on a draw whose engine can actually drive it.
   */
  commandWorkers?: boolean;
}): { hostPools: CapacityPool[]; sourcePools: CapacityPool[] } {
  const identityOf = (pool: CapacityPool): { provider: string; account: string | null } => {
    const parsed = parseProviderModelKey(pool.id);
    // Backend outranks transport (h2c3 F5): a proxied lane's double-grant axis is
    // its backend, the same axis `dispatchableSourceId` keys such pools on. A
    // source with an explicit non-provider-shaped `id` parses to an arbitrary
    // head; providerName is the fallback routing identity.
    return { provider: pool.source?.backend_provider ?? pool.providerName, account: parsed.account };
  };
  const hostIdentities: Array<{ provider: string; account: string | null }> =
    params.hostPools.length > 0
      ? params.hostPools.map(identityOf)
      : params.hostProviderName
        ? [{ provider: params.hostProviderName, account: null }]
        : [];
  if (hostIdentities.length === 0) {
    return { hostPools: params.hostPools, sourcePools: params.sourcePools };
  }
  // Directional account compare (h2c3 F3): an accountless SOURCE shares the host
  // credential by construction (the synthesized primary fold) → provider-only
  // collide; an explicitly-accounted source collides only on a RESOLVED equal
  // host account — an unresolved host account is never surrendered to it.
  const collide = (
    host: { provider: string; account: string | null },
    source: { provider: string; account: string | null },
  ): boolean =>
    host.provider === source.provider &&
    (source.account === null ? true : host.account === source.account);

  const survivingSourceIdentities: Array<{ provider: string; account: string | null }> = [];
  const sourcePools = params.sourcePools.filter((source) => {
    const id = identityOf(source);
    if (!hostIdentities.some((host) => collide(host, id))) return true;
    if (
      isInProcessWorkerProvider(source.providerName, {
        commandWorkers: params.commandWorkers === true,
      })
    ) {
      // D1: the engine pool survives; the colliding host pool(s) drop below.
      survivingSourceIdentities.push(id);
      return true;
    }
    // Host survives; the colliding non-in-process source drops.
    return false;
  });
  const hostPools = params.hostPools.filter(
    (pool) => !survivingSourceIdentities.some((id) => collide(identityOf(pool), id)),
  );
  return { hostPools, sourcePools };
}

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
