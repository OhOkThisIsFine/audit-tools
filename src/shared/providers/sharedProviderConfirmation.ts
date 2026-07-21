/**
 * DC-2 — shared, session-scoped provider confirmation (Gate-0).
 *
 * The design wants ONE provider confirmation spanning an audit→remediate run:
 * the first tool to run writes the operator's confirmed route DECISION to a
 * SHARED artifact at `<root>/.audit-tools/provider-confirmation.json` (NOT the
 * per-tool audit artifacts dir); the second tool reads and honors it. "Session" =
 * the shared `.audit-tools` dir for that repo+run, so no new identity scheme is
 * needed.
 *
 * **What this artifact carries is POLICY, not reach (G3).** The operator's
 * decision — exclusions, cost order, λ — is a set of *rules*, valid for any
 * auditor. What is *reachable* is per-auditor capability and is re-resolved from
 * live env/PATH at the moment of use, never inherited from whoever wrote this
 * file. So every read here is reach-free: it returns the persisted decision and
 * nothing else.
 *
 * INV-DC1-6 (never-block) is the only invariant left in tension, and it now
 * resolves to a plain two-valued read: a remediate run standalone with no prior
 * audit resolves its provider independently — absence or corruption of the
 * artifact is NOT an error, it is `null`.
 *
 * The former roster-staleness check (and its CE-012 three-valued `reconfirm`
 * state) is GONE. It compared the *writing* auditor's roster against the reader's
 * — meaningless cross-auditor by construction — and answered a real event (a
 * backend the operator never confirmed became reachable) by silently discarding
 * the operator's cost order and λ, while reaching no obligation at all. The
 * `autonomous_mode`-keyed reconciliation gate
 * ({@link computeNewlyReachableBackends}) replaces it: it compares the operator's
 * DECISION against *this* auditor's freshly-resolved reach, which is well-defined
 * across auditors, and it actually fires.
 *
 * CE-003 (lockless read races the writer rename): writes go through the shared
 * atomic writer (temp + atomic rename) under `withFileLock`, so a lockless
 * reader always observes either the complete old file or the complete new file —
 * never a torn intermediate.
 *
 * PB-1 (opencode opt-in): the confirmed pool is derived from `discoverProviders`,
 * which already withholds a bare-PATH opencode unless it is explicitly
 * configured, so the shared confirmation inherits that opt-in for free.
 */

import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { DispatchableSource, ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import { PROVIDER_NAMES } from "../types/sessionConfig.js";
import { isSelfSpawnBlocked } from "./providerPathGuard.js";
import { auditToolsDir } from "../io/auditToolsPaths.js";
import { readJsonFile, writeJsonFile } from "../io/json.js";
import { withFileLock } from "../quota/fileLock.js";
import type { RunLogger } from "../observability/runLog.js";
import {
  discoverProviders,
  annotateConfirmedPool,
  representativeModelId,
  type CapabilityTier,
} from "./providerConfirmation.js";
import {
  backendIdentity,
  sourceService,
  exclusionPattern,
  serviceExclusionPattern,
} from "./identity.js";
import { resolveConfirmedCostPositions } from "../dispatch/costRank.js";
import { gatherDispatchableSources } from "../quota/apiPool.js";
import { resolveFreshSessionProviderName } from "./providerFactory.js";
import type {
  ConfirmedPoolEntry,
  PersistedPoolEntry,
  HostModelCostEntry,
  SourcePoolCostEntry,
  ProviderConfirmationInput,
} from "../types/providerConfirmation.js";
import { PROVIDER_CONFIRMATION_INPUT_VERSION } from "../types/providerConfirmation.js";

// ---------------------------------------------------------------------------
// Version + on-disk location
// ---------------------------------------------------------------------------

/**
 * Schema version for the shared confirmation artifact. Bumped independently of
 * the per-tool seam contract (PROVIDER_CONFIRMATION_RESULT_VERSION) — this is
 * the cross-tool session artifact carrying the operator's route DECISION
 * (exclusions, cost order, λ), a distinct shape from the seam's pool snapshot.
 */
export const SHARED_PROVIDER_CONFIRMATION_VERSION = "1.0.0" as const;

/**
 * Clamp an operator-supplied cost↔speed dispatch bias (λ) to [0, 1], or `undefined`
 * when it is absent/non-finite. Single-sourced so parse-time and read-time agree.
 * (spec/dispatch-cost-speed-dial.md).
 */
export function clampDispatchBias(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** File name of the shared session-level confirmation under `.audit-tools/`. */
export const SHARED_PROVIDER_CONFIRMATION_FILENAME =
  "provider-confirmation.json";

/** `<root>/.audit-tools/provider-confirmation.json` (absolute). */
export function sharedProviderConfirmationPath(root: string): string {
  return join(auditToolsDir(root), SHARED_PROVIDER_CONFIRMATION_FILENAME);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The operator's explicit route DECISION — reach-free by construction.
 *
 * This is the POLICY half of the Gate-0 confirmation: it names *rules* (which
 * provider names the operator ruled out, which self-spawn-blocked ones they ruled
 * back in), never *reachable endpoints*. It is deliberately the operator's raw
 * `exclude` / `include` input rather than the derived per-entry `excluded` flag,
 * because that flag folds in the WRITING auditor's `CLAUDECODE`/`CODEX` env via
 * `isSelfSpawnBlocked` — persisting it would make one auditor's environment
 * decide another's routing. Self-spawn-blocked is therefore recomputed in the
 * READING process (see {@link resolveDispatchExclusion}).
 *
 * Because policy is reach-independent, it stays valid when the discovered reach
 * changes. No read of this artifact gates on a reach check, for exactly that
 * reason: an exclusion must fail CLOSED (keep excluding) when reach shifts, never
 * fail open — and neither may the cost order or λ be discarded by a reach event
 * they do not depend on (G3 step 1).
 */
export interface ConfirmedDispatchPolicy {
  /**
   * {@link DispatchExclusionPattern}s **the OPERATOR** ruled out of the dispatchable
   * pool. Model-granular by default (`provider:model`) — the operator confirms
   * *model* choices, so excluding one model of a multi-model backend must not drop
   * the backend's other models.
   *
   * ⚠ Operator-authored ONLY. Tool-generated fail-closed patterns live in
   * {@link auto_exclude} and must never be merged into this list: the two have
   * different lifetimes, and once merged they are indistinguishable, so a
   * carry-forward would launder a tool guess into permanent operator policy.
   */
  exclude?: DispatchExclusionPattern[];
  /**
   * Patterns **the GATE** authored on the operator's behalf — the fail-closed
   * reconciliation excluding a newly-reachable backend that no operator decision
   * covers (autonomous/headless path only).
   *
   * Kept separate from {@link exclude} because provenance decides lifetime. An
   * operator exclusion is a durable rule and is carried forward across promotions; an
   * auto-exclusion is a *placeholder for an answer that was never given*, so the next
   * operator submission SUPERSEDES it. Merged into one list, the carry-forward cannot
   * tell them apart and makes the tool's guess permanent — with no signal, because the
   * backend is a confirmed key by then and the reconciliation delta never re-surfaces
   * it. Honored at dispatch exactly like {@link exclude} (see
   * {@link resolveDispatchExclusion}), so separating them weakens nothing.
   */
  auto_exclude?: DispatchExclusionPattern[];
  /** Self-spawn-blocked provider names the operator explicitly opted back IN. */
  include?: ResolvedProviderName[];
  /**
   * The operator's RAW capability answer — the `capability_order` key list exactly as
   * submitted, most-capable-first.
   *
   * Stored verbatim rather than reconstructed from the resulting `capability_rank`s,
   * which is the same reason `exclude` stores raw patterns. Reconstruction cannot
   * distinguish a rank the operator authored from one that came from EXTERNAL evidence
   * (a source's own registry rank), so it laundered external numbers into the
   * operator's answer: a no-op promotion silently re-ranked confirmed models, and the
   * laundered id then read as "evidenced" permanently — even after the external
   * evidence disappeared, which is precisely the fail-open this obligation exists to
   * close. Persisting the answer makes the distinction unrepresentable instead of
   * merely documented.
   */
  capability_order?: string[];
}

/**
 * The string form of an exclusion pattern. Axis-explicit: the rule names its
 * axis as a prefix, so the grammar is unambiguous against open namespaces and
 * an unknown axis is a PARSE ERROR, not an inert rule.
 *
 * | Pattern | Axis | Matches |
 * |---|---|---|
 * | `transport:codex` | transport | every model on that adapter |
 * | `transport:openai-compatible/glm-5.2` | transport | one model on that adapter (model after `/`) |
 * | `service:nim` | service | every model from that vendor, however reached |
 * | `service:nim/z-ai/glm-5.2` | service | one model from that vendor |
 * | `host:localhost:8000` | host | by endpoint address (port-specific) |
 * | `host:integrate.api.nvidia.com` | host | by endpoint address (port-agnostic) |
 *
 * There is deliberately **no `model:` axis** — a cross-service model rule
 * recombines the identities the gate exists to keep apart.
 *
 * ⚠ This is a THIRD keyspace, deliberately distinct from the quota-ledger pool
 * identity (`provider[#account]/model`, `quotaPoolKey`): an account is
 * irrelevant to a rule about a backend. Do not unify them.
 */
export type DispatchExclusionPattern = string;

/** A backend an exclusion rule can be evaluated against — structurally a `DispatchableSource`. */
export interface ExcludableBackend {
  transport: string;
  service?: string;
  model?: string;
  endpoint?: string;
}

/**
 * The resolved exclusion rule set for THIS process: the operator's persisted
 * patterns plus every locally self-spawn-blocked provider. Applied as a
 * set-difference FILTER over freshly-gathered reach, never additively.
 */
export interface DispatchExclusion {
  /** True ⇒ this backend is ruled out and must not become a dispatch pool. */
  excludes(backend: ExcludableBackend): boolean;
  /**
   * The first pattern that rules this backend out, or null when none does.
   *
   * Attribution for the capacity guard: when the rule set removes EVERY gathered
   * source, "zero capacity" alone sends the operator hunting through their whole
   * policy — the guard has to be able to name the rules that did it. `excludes` is
   * derived from this (`excludedBy(b) !== null`), so the boolean verdict and the
   * attributed pattern can never disagree.
   */
  excludedBy(backend: ExcludableBackend): DispatchExclusionPattern | null;
}

export interface SharedProviderConfirmation {
  /** Must equal SHARED_PROVIDER_CONFIRMATION_VERSION. */
  schema_version: typeof SHARED_PROVIDER_CONFIRMATION_VERSION;
  /**
   * The operator's explicit, reach-free route decision. Read at dispatch by
   * {@link resolveDispatchExclusion} and applied as a set-difference filter over
   * freshly-discovered reach — never additively. Absent ⇒ no operator exclusions
   * (self-spawn-blocked providers are still excluded, recomputed locally).
   */
  policy?: ConfirmedDispatchPolicy;
  /** Always true: the pool applies to the whole audit→remediate session. */
  session_level: true;
  /** ISO-8601 timestamp of when the pool was confirmed. */
  confirmed_at: string;
  /**
   * The confirmed provider pool as PERSISTED — decision only, no reach (G3 B+D).
   * See {@link PersistedPoolEntry}: the reach half is deliberately unrepresentable
   * here, so one auditor's environment can never route another's.
   */
  provider_pool: PersistedPoolEntry[];
  /**
   * Host self-reported model tiers with their operator-confirmed cost positions
   * (follow-up c). Merged into the model-keyed dispatch positions map by
   * `readConfirmedCostPositions` so host-native tiers route by their confirmed
   * order. Absent/empty on the headless path (no host roster is reported).
   */
  host_model_cost_order?: HostModelCostEntry[];
  /**
   * Dispatchable SOURCE pools (explicit `sources[]` + proxy expansion) with their
   * operator-confirmed cost positions (Gate-0 source fold). Merged into the model-keyed
   * dispatch positions map by `readConfirmedCostPositions` so a source pool routes by its
   * confirmed order exactly like a provider pool / host tier. Absent when no source is
   * configured (or a confirmation written before this field existed) ⇒ dispatch falls to
   * declared/catalog price then tier, exactly as before.
   */
  source_pool_cost_order?: SourcePoolCostEntry[];
  /**
   * Operator-confirmed cost↔speed dispatch bias (λ) ∈ [0, 1], the durable operating
   * point on the cost-vs-throughput frontier (spec/dispatch-cost-speed-dial.md). Read
   * back at dispatch by `readConfirmedDispatchBias` and applied by `admitBatch`. Absent
   * ⇒ the cost-first default (λ=0), so a confirmation written before this field existed
   * (or a headless run) behaves exactly as before.
   */
  dispatch_bias?: number;
}

/**
 * The Gate-0 confirmation as RENDERED to the operator — identical to the persisted
 * {@link SharedProviderConfirmation} except that `provider_pool` carries the FULL
 * {@link ConfirmedPoolEntry} (this auditor's freshly-derived reach: tier, price, why
 * a backend is excluded). This shape exists ONLY in memory; it never reaches disk.
 */
export interface RenderedProviderConfirmation
  extends Omit<SharedProviderConfirmation, "provider_pool"> {
  provider_pool: ConfirmedPoolEntry[];
}

/**
 * Project the render DTO down to what actually gets PERSISTED: the operator's
 * decision, with this auditor's reach assessment dropped (G3 B+D).
 *
 * The PRODUCER is split — not the write site. `writeSharedProviderConfirmation`
 * receives an already-typed value, so projecting THERE would leave the reach fields
 * representable on the persisted type and a future caller could put them back.
 * Projecting here makes the persisted shape carry no reach BY CONSTRUCTION.
 */
export function buildSharedProviderConfirmation(
  ...args: Parameters<typeof buildProviderConfirmationRender>
): SharedProviderConfirmation {
  const rendered = buildProviderConfirmationRender(...args);
  return {
    ...rendered,
    provider_pool: rendered.provider_pool.map(toPersistedPoolEntry),
  };
}

/** The decision half of one pool entry. Reach is dropped, never persisted. */
function toPersistedPoolEntry(entry: ConfirmedPoolEntry): PersistedPoolEntry {
  return {
    name: entry.name,
    ...(entry.model_id !== undefined ? { model_id: entry.model_id } : {}),
    ...(entry.cost_order !== undefined ? { cost_order: entry.cost_order } : {}),
    // The capability-evidence decision persists (it is a DECISION, not reach) — and it
    // must be carried explicitly: this builder reconstructs field-by-field, so a field
    // absent here is silently dropped on every round-trip.
    ...(entry.capability_rank !== undefined ? { capability_rank: entry.capability_rank } : {}),
  };
}

function sortNames(names: readonly ResolvedProviderName[]): ResolvedProviderName[] {
  // Deduplicate + sort so a persisted list is order-insensitive and stable.
  return [...new Set(names)].sort();
}

function sortStrings(values: readonly string[]): string[] {
  // Deduplicate + sort so a persisted list is order-insensitive and stable.
  return [...new Set(values)].sort();
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build a fresh shared confirmation from auto-discovery. Guarantees the
 * always-available `worker-command` fallback is present in the pool (it blocks
 * auto-dispatch and so is never PATH-detected, but the pool must always be able
 * to fall back to it) and stamps the schema version, session-level flag, and
 * confirmation timestamp.
 *
 * SECURITY (self-spawn exclusion): a provider that `discoverProviders` flags as
 * `selfSpawnBlocked` (claude-code under `CLAUDECODE`, codex under `CODEX`) is set
 * `excluded: true` AND carries the machine-readable `self_spawn_blocked` flag, so
 * it is OUT of the dispatchable pool by default — launching it would self-spawn a
 * fresh agent from inside an active session of the same agent. The operator can
 * deliberately re-include it by naming it in `include`; that overrides the
 * exclusion (the host still always retains the worker-command fallback).
 *
 * @param sessionConfig - Current session config; may be an empty `{}`.
 * @param env           - Process env snapshot; defaults to `process.env`.
 * @param exclude       - {@link DispatchExclusionPattern}s to pre-exclude (from a
 *   prior gate). A `provider:model` pattern marks a pool entry excluded only when
 *   that entry's `representativeModelId` IS that model — the same key the routing
 *   filter matches on, so display and dispatch cannot disagree.
 * @param include       - Provider names the operator explicitly opts back IN,
 *   overriding the default self-spawn-blocked exclusion for those names.
 * @param detectCommand - Injectable PATH-detection hook, forwarded to
 *   `discoverProviders` so tests can drive discovery deterministically.
 * @param input         - Operator's Gate-0 submission (interactive path): its
 *   `cost_order` overrides the suggested ordering and its `host_models` become
 *   priced, orderable host-native tiers (`host_model_cost_order`). Omit for the
 *   headless / no-operator path — the tool then emits its price-ascending
 *   suggestion with no host models, exactly as before. `exclude`/`include` are
 *   passed via the dedicated params above (the executor forwards them from the
 *   same input), so this arg governs ordering + host roster only.
 */
export function buildProviderConfirmationRender(
  sessionConfig: SessionConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  exclude: DispatchExclusionPattern[] = [],
  include: ResolvedProviderName[] = [],
  detectCommand?: (command: string) => boolean,
  input?: ProviderConfirmationInput,
  sources: DispatchableSource[] = [],
  /**
   * Gate-authored fail-closed patterns, kept SEPARATE from the operator's `exclude`
   * so provenance survives to disk (see {@link ConfirmedDispatchPolicy.auto_exclude}).
   * Both kinds mark a pool entry excluded in the render — the split governs lifetime,
   * not enforcement — so the two are unioned for the display/routing decision below
   * and only split again when the policy is persisted.
   */
  autoExclude: DispatchExclusionPattern[] = [],
): RenderedProviderConfirmation {
  const discovered = discoverProviders(sessionConfig, env, detectCommand);
  const operatorExcluded = buildExclusion(migrateExclusionPatterns([...exclude, ...autoExclude]));
  const includeSet = new Set<ResolvedProviderName>(include);
  // Evaluate a pool entry against the operator's rules at the SAME key the routing
  // filter uses — `representativeModelId` is what `computeNewlyReachableBackends`
  // and `annotateConfirmedPool` key a provider by, so a `provider:model` rule marks
  // exactly the entry it will later filter.
  //
  // ⚠ The provider + model tiers ONLY. `provider_pool` is provider-granular and an
  // entry has no endpoint, so an endpoint-host rule can never mark one — that tier
  // addresses SOURCES, which this pool does not enumerate. The direction is safe
  // (the rule is still honored at `buildSourcePools`; the Gate-0 table merely
  // under-reports it as "included"), but it is a real display/routing gap and it is
  // NOT closed here. Backlog: the Gate-0 sources table carries no status column at
  // all, so no tier is reflected for a source today.
  const ruledOut = (name: ResolvedProviderName): boolean =>
    operatorExcluded.excludes({
      transport: name,
      model: representativeModelId(name, sessionConfig),
    });

  const pool: ConfirmedPoolEntry[] = [];

  // Always include worker-command as a fallback — it's always available and is
  // never surfaced by PATH discovery (it blocks auto-dispatch by design).
  if (!discovered.some((p) => p.name === "worker-command")) {
    pool.push({
      name: "worker-command",
      capability_tier: "unknown" satisfies CapabilityTier,
      excluded: ruledOut("worker-command"),
    });
  }

  for (const provider of discovered) {
    // Self-spawn-blocked providers are excluded from the dispatchable pool by
    // default; the operator can opt one back in via `include`. An operator-named
    // `exclude` always wins.
    const blocked = provider.selfSpawnBlocked === true;
    const operatorIncluded = includeSet.has(provider.name);
    const excluded = ruledOut(provider.name) || (blocked && !operatorIncluded);
    pool.push({
      name: provider.name,
      capability_tier: provider.capabilityTier,
      excluded,
      ...(blocked ? { self_spawn_blocked: true } : {}),
    });
  }

  // Cost-first routing: annotate with representative model price + cost_order,
  // read at dispatch as rung 1 of costRank (spec/cost-first-routing.md). When an
  // operator input is present its ordering wins and its host roster is priced.
  // `env` is threaded rather than left to `process.env`: host-provider resolution
  // falls through to env detection when `host_provider` is unset, and an injected-env
  // caller must not derive provider DISCOVERY and HOST IDENTITY from two different
  // environments.
  const annotated = annotateConfirmedPool(pool, sessionConfig, input, sources, env);
  return {
    schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
    session_level: true,
    confirmed_at: new Date().toISOString(),
    provider_pool: annotated.provider_pool,
    // NOTE: the FULL entries. This is the render DTO; `buildSharedProviderConfirmation`
    // projects them to `PersistedPoolEntry[]` on the way to disk.
    ...(annotated.host_model_cost_order.length > 0
      ? { host_model_cost_order: annotated.host_model_cost_order }
      : {}),
    ...(annotated.source_pool_cost_order.length > 0
      ? { source_pool_cost_order: annotated.source_pool_cost_order }
      : {}),
    ...(clampDispatchBias(input?.dispatch_bias) != null
      ? { dispatch_bias: clampDispatchBias(input?.dispatch_bias) }
      : {}),
    ...(buildConfirmedDispatchPolicy(
      exclude,
      include,
      autoExclude,
      // The operator's RAW capability answer, persisted verbatim so the next
      // carry-forward reads back what they SAID rather than re-deriving it from the
      // ranks it produced (which cannot distinguish it from external evidence).
      input?.capability_order ?? [],
    ) ?? {}),
  };
}

/**
 * Lift the operator's explicit route decision out of their Gate-0 input into the
 * persisted policy half. Returns `undefined` when the operator named neither list
 * (so the field stays absent rather than persisting an empty shell).
 */
function buildConfirmedDispatchPolicy(
  exclude: readonly DispatchExclusionPattern[],
  include: readonly ResolvedProviderName[],
  autoExclude: readonly DispatchExclusionPattern[] = [],
  capabilityOrder: readonly string[] = [],
): { policy: ConfirmedDispatchPolicy } | undefined {
  if (
    exclude.length === 0 &&
    include.length === 0 &&
    autoExclude.length === 0 &&
    capabilityOrder.length === 0
  ) {
    return undefined;
  }
  return {
    policy: {
      ...(exclude.length > 0 ? { exclude: sortStrings(exclude) } : {}),
      // Sorted like its sibling — an auto-exclusion is a set membership, order-free.
      ...(autoExclude.length > 0 ? { auto_exclude: sortStrings(autoExclude) } : {}),
      ...(include.length > 0 ? { include: sortNames(include) } : {}),
      // NOT sorted, NOT deduped by sortStrings: this is a positional ORDERING, and
      // sorting it would destroy the operator's answer outright.
      ...(capabilityOrder.length > 0 ? { capability_order: [...capabilityOrder] } : {}),
    },
  };
}

/**
 * Keep every non-empty pattern verbatim — **no membership check.** Unlike
 * {@link parseProviderNameList}, this list is an open grammar: a pattern whose head
 * is not a provider name is a legitimate endpoint-host rule, so "unknown ⇒ drop"
 * would silently delete the operator's endpoint tier. An unmatchable pattern is
 * inert (it simply matches nothing), which is the safe direction for a filter.
 *
 * Returns `undefined` for a non-array or an all-empty array, so the field stays
 * absent rather than persisting an empty shell.
 */
function parseExclusionPatterns(
  value: unknown,
): DispatchExclusionPattern[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const patterns = value.filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return patterns.length > 0 ? patterns.map((p) => p.trim()) : undefined;
}

/**
 * Keep only real provider names, dropping anything unknown. Returns `undefined` for a
 * non-array or an array with no recognizable name, so an unknown entry degrades that
 * entry — never the whole list.
 *
 * Retained for `include` ONLY: that list opts a *self-spawn-blocked provider* back in,
 * and self-spawn-blockedness is a property of a provider (`isSelfSpawnBlocked` keys on
 * the provider name), so its keyspace is genuinely the closed name set — not the open
 * exclusion grammar.
 */
function parseProviderNameList(
  value: unknown,
): ResolvedProviderName[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((v): v is ResolvedProviderName =>
    typeof v === "string" && RESOLVED_PROVIDER_NAMES.includes(v as ResolvedProviderName),
  );
  return names.length > 0 ? names : undefined;
}

/** Every concrete provider name — `auto` is a resolution directive, not a backend. */
const RESOLVED_PROVIDER_NAMES: readonly ResolvedProviderName[] = PROVIDER_NAMES.filter(
  (name): name is ResolvedProviderName => name !== "auto",
);

// ---------------------------------------------------------------------------
// The reconciliation gate (G3): operator DECISION vs THIS auditor's reach
// ---------------------------------------------------------------------------

/**
 * The keys of the operator's persisted DECISION — the CONFIRMED half of the gate.
 *
 * All three pools contribute, and each is load-bearing: `annotateConfirmedPool`
 * folds a source away when its model is already claimed by a provider entry, so a
 * source can be represented ONLY by `provider_pool[].model_id`; and a host tier
 * appears only in `host_model_cost_order`. Reading fewer than all three would
 * manufacture a phantom delta for an already-confirmed backend.
 *
 * A host tier with no `provider` contributes NOTHING, and that is the deliberate
 * fail-SAFE degradation for a confirmation written before the field existed. The
 * alternative — falling back to the bare `model_id` — is precisely the bypass this
 * identity exists to close: a confirmed *host* model would silently approve an
 * identically-named model on some other provider. Contributing no key can only ever
 * cause the gate to ASK about a backend again (loud, and the operator's answer then
 * records the provider); it can never approve one unseen.
 */
export function confirmedBackendKeys(
  confirmation: SharedProviderConfirmation,
): Set<string> {
  const keys = new Set<string>();
  for (const entry of confirmation.provider_pool) {
    keys.add(backendIdentity(entry.model_id, entry.name));
  }
  for (const entry of confirmation.source_pool_cost_order ?? []) {
    keys.add(backendIdentity(entry.model_id, entry.service ?? entry.transport));
  }
  for (const entry of confirmation.host_model_cost_order ?? []) {
    if (entry.provider === undefined) continue;
    keys.add(backendIdentity(entry.model_id, entry.provider));
  }
  return keys;
}

/** One backend in the gate's delta: reachable now, absent from the decision. */
export interface NewlyReachableBackend {
  /**
   * The gate key — {@link backendIdentity}. Stable, operator-facing, and
   * provider-qualified.
   */
  key: string;
  /** The backend's provider name. Display only — the prompt names it beside `key`. */
  provider: ResolvedProviderName;
  /**
   * The backend's serving vendor / service name (`service ?? transport`).
   */
  service?: string;
  /**
   * The transport-qualified {@link DispatchExclusionPattern} that rules out
   * **exactly this transport route**, built HERE beside the key it was compared on.
   */
  exclusion_pattern: DispatchExclusionPattern;
  /**
   * The service-qualified {@link DispatchExclusionPattern} (`service:vendor/model` or `service:vendor`)
   * that rules out **every transport reaching this vendor/service**. Emitted by autonomous fail-closed
   * writes so unconfirmed backends stay excluded across transport/proxy changes.
   */
  service_exclusion_pattern?: DispatchExclusionPattern;
}

/**
 * DELTA = **REACH-NOW \ CONFIRMED**: the backends this auditor can reach *right
 * now* that the operator's persisted decision never mentions. Sorted by key, so the
 * result is stable for prompt rendering + comparison.
 *
 * This is a **set difference — a FILTER over fresh reach, never additive.** The
 * opposite direction (CONFIRMED \ REACH-NOW: a backend the operator confirmed that
 * this auditor cannot reach) is the harmless *subset* case and is deliberately
 * silent — it is also why the synthetic `worker-command` entry and
 * `host_model_cost_order` need no special-casing here.
 *
 * @param confirmation - The persisted decision (CONFIRMED).
 * @param sessionConfig - The EFFECTIVE config, so `representativeModelId` derives
 *   keys identically to the write side.
 * @param sources - REACH-NOW's source half. MUST come from the
 *   `gatherDispatchableSources` chokepoint — the single async source-gather point
 *   both `buildSourcePools` and the Gate-0 surface consume, so what the operator
 *   confirms is exactly what routes. Re-deriving it from `resolveAmbientSources`
 *   would reintroduce the display/dispatch drift that invariant forbids, and is
 *   structurally blind to descriptor-supplied sources, the demoted primary, and the
 *   legacy `openai_compatible` fold.
 * @param env - Process env, for `discoverProviders` (REACH-NOW's provider half).
 * @param detectCommand - Injectable PATH-detection hook so tests drive discovery
 *   deterministically instead of shelling out.
 */
export function computeNewlyReachableBackends(
  confirmation: SharedProviderConfirmation,
  sessionConfig: SessionConfig,
  sources: readonly DispatchableSource[] = [],
  env: NodeJS.ProcessEnv = process.env,
  detectCommand?: (command: string) => boolean,
): NewlyReachableBackend[] {
  const confirmed = confirmedBackendKeys(confirmation);
  const reachNow = new Map<string, NewlyReachableBackend>();
  // `provider` is the TRANSPORT (what spawns / what the routing filter matches);
  // `backendProvider` is the BACKEND ACTUALLY SERVING the model, and only a proxied
  // source distinguishes them. The identity keys on the backend, the rule on the
  // transport — see `backendIdentity`.
  const record = (
    modelId: string | undefined,
    provider: ResolvedProviderName,
    backendProvider?: string,
  ): void => {
    const service = backendProvider ?? provider;
    const identity = backendIdentity(modelId, service);
    // First writer wins: when a proxied lane and a direct lane resolve to the SAME
    // backend identity, they are one backend reached two ways, and the rule kept is
    // the one that rules out the lane already recorded.
    if (reachNow.has(identity)) return;
    reachNow.set(identity, {
      key: identity,
      provider,
      service,
      exclusion_pattern: exclusionPattern(modelId, provider),
      service_exclusion_pattern: serviceExclusionPattern(modelId, service),
    });
  };
  for (const provider of discoverProviders(sessionConfig, env, detectCommand)) {
    // A discovered provider IS its own backend — no proxy indirection to unwrap.
    record(representativeModelId(provider.name, sessionConfig), provider.name);
  }
  for (const source of sources) {
    record(source.model, source.transport, source.service);
  }
  return [...reachNow.values()]
    .filter((backend) => !confirmed.has(backend.key))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The dispatchable-pool exclusion rules for THIS process: the operator's explicit
 * {@link DispatchExclusionPattern}s, plus every provider that is self-spawn-blocked
 * *in this process's env* and was not explicitly opted back in.
 *
 * Reach is recomputed here rather than read from the artifact's derived `excluded`
 * flag — that flag encodes the WRITING auditor's env, and an auditor for whom a
 * provider is perfectly spawnable must not inherit another's block. The operator's
 * decision is inherited (it is a rule); the reach assessment is not.
 *
 * ⚠ **These rules are only safe to apply to SOURCE pools.** Inside any agent session
 * the self-spawn half ALWAYS names that agent (`CLAUDECODE` ⇒ `claude-code`, `CODEX`
 * ⇒ `codex`) — i.e. the conversation host itself. Applying them to HOST pools would
 * zero out dispatch entirely: the driver would exclude itself. It is harmless at
 * `buildSourcePools` only because a host can never BE a source — `claude-code` is
 * structurally absent from `DISPATCHABLE_TRANSPORTS`, so in a Claude Code
 * session the filter is a no-op. Honoring an operator exclusion of the host/primary
 * provider therefore is NOT a matter of passing these rules to the host-pool builder;
 * it needs a separate decision about what excluding your own driver should even mean.
 */
export function resolveDispatchExclusion(
  policy: ConfirmedDispatchPolicy | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DispatchExclusion {
  const included = new Set(policy?.include ?? []);
  // The local reach half: a self-spawn-blocked provider is ruled out at the
  // TRANSPORT axis (blockedness is a property of the process, not the vendor),
  // recomputed against THIS process's env rather than inherited.
  const blocked = RESOLVED_PROVIDER_NAMES.filter(
    (name) => !included.has(name) && isSelfSpawnBlocked(name, env),
  );
  // Both provenances are enforced identically — the split is about LIFETIME (which
  // survives the next submission), never about which patterns bite at dispatch.
  return buildExclusion(
    migrateExclusionPatterns([
      ...(policy?.exclude ?? []),
      ...(policy?.auto_exclude ?? []),
      ...blocked.map((name) => `transport:${name}` as DispatchExclusionPattern),
    ]),
  );
}

/**
 * The pure-policy matcher: the operator's patterns and nothing else. Split out
 * because the Gate-0 pool BUILDER must evaluate the operator's rules WITHOUT the
 * local self-spawn fold — it derives `self_spawn_blocked` from `discoverProviders`
 * on its own and would otherwise conflate the two into one indistinguishable
 * `excluded` verdict.
 */
function buildExclusion(
  patterns: readonly DispatchExclusionPattern[],
): DispatchExclusion {
  // Keep each rule beside the pattern it came from: the capacity guard reports the
  // operator's ORIGINAL text, not a re-rendering of the parsed rule (a round-trip
  // through `ExclusionRule` would show them a string they never wrote).
  const rules = patterns.map((pattern) => ({ pattern, rule: parseExclusionRule(pattern) }));
  const excludedBy = (backend: ExcludableBackend): DispatchExclusionPattern | null =>
    rules.find(({ rule }) => ruleMatches(rule, backend))?.pattern ?? null;
  // `excludes` is DERIVED, never a parallel implementation — the two verdicts cannot drift.
  return { excludes: (backend) => excludedBy(backend) !== null, excludedBy };
}

/**
 * One parsed exclusion rule. Axis-explicit: the kind is decided by the literal
 * axis prefix (`transport:`, `service:`, `host:`). An unrecognized or absent
 * prefix is a PARSE ERROR (`invalid`), not an inert rule — the "typo'd rule
 * persists happily and matches nothing, silently" defect becomes impossible.
 *
 * Model-granular forms use `/` as the model delimiter (not `:`) because model
 * ids can contain colons (e.g. `qwen2.5:7b`). `transport:` and `service:` tiers
 * each have a coarse form (every model) and a model-specific form.
 */
type ExclusionRule =
  | { kind: "transport"; transport: string }
  | { kind: "transport_model"; transport: string; model: string }
  | { kind: "service"; service: string }
  | { kind: "service_model"; service: string; model: string }
  | { kind: "host"; host: string }
  | { kind: "invalid"; raw: string };

/** The three recognized axis prefixes. */
const VALID_EXCLUSION_AXES = new Set(["transport", "service", "host"]);

function parseExclusionRule(pattern: DispatchExclusionPattern): ExclusionRule {
  const colon = pattern.indexOf(":");
  if (colon === -1) {
    // No axis prefix — invalid under the axis-explicit grammar.
    return { kind: "invalid", raw: pattern };
  }
  const axis = pattern.slice(0, colon);
  const rest = pattern.slice(colon + 1);
  if (!VALID_EXCLUSION_AXES.has(axis) || rest.length === 0) {
    return { kind: "invalid", raw: pattern };
  }
  switch (axis) {
    case "transport": {
      const slash = rest.indexOf("/");
      if (slash === -1) return { kind: "transport", transport: rest };
      if (slash === rest.length - 1) return { kind: "transport", transport: rest.slice(0, slash) };
      return { kind: "transport_model", transport: rest.slice(0, slash), model: rest.slice(slash + 1) };
    }
    case "service": {
      const slash = rest.indexOf("/");
      if (slash === -1) return { kind: "service", service: rest };
      if (slash === rest.length - 1) return { kind: "service", service: rest.slice(0, slash) };
      return { kind: "service_model", service: rest.slice(0, slash), model: rest.slice(slash + 1) };
    }
    case "host":
      return { kind: "host", host: rest.toLowerCase() };
    default:
      return { kind: "invalid", raw: pattern };
  }
}

/**
 * Migrate persisted bare-form exclusion patterns (pre-stage-4) to the
 * axis-explicit grammar. The old grammar was unambiguous within its own rules
 * (head token against the closed provider set), so the migration reproduces
 * exactly what the old parser would have inferred, then emits the explicit form.
 *
 * Applied at read time in {@link resolveDispatchExclusion}. A re-confirmation
 * (any Gate-0 delta) persists new-form patterns naturally because the pattern
 * generator now emits prefixed strings.
 */
function migrateExclusionPatterns(
  patterns: readonly DispatchExclusionPattern[],
): DispatchExclusionPattern[] {
  return patterns.map(migrateExclusionPattern);
}

function migrateExclusionPattern(pattern: DispatchExclusionPattern): DispatchExclusionPattern {
  // Already axis-explicit — no migration needed.
  if (VALID_EXCLUSION_AXES.has(pattern.slice(0, pattern.indexOf(":"))) && pattern.indexOf(":") > 0) {
    return pattern;
  }
  const colon = pattern.indexOf(":");
  if (colon === -1) {
    // Bare token: `codex` → `transport:codex`, `localhost` → `host:localhost`
    return isResolvedProviderName(pattern)
      ? `transport:${pattern}`
      : `host:${pattern}`;
  }
  const head = pattern.slice(0, colon);
  const tail = pattern.slice(colon + 1);
  if (isResolvedProviderName(head)) {
    // `openai-compatible:model-a` → `transport:openai-compatible/model-a`
    // `codex:` (empty tail) → `transport:codex`
    return tail.length > 0
      ? `transport:${head}/${tail}`
      : `transport:${head}`;
  }
  // `integrate.api.nvidia.com` / `localhost:8000` → `host:<pattern>`
  return `host:${pattern}`;
}

function isResolvedProviderName(value: string): boolean {
  return RESOLVED_PROVIDER_NAMES.includes(value as ResolvedProviderName);
}

function ruleMatches(rule: ExclusionRule, backend: ExcludableBackend): boolean {
  switch (rule.kind) {
    case "transport":
      return backend.transport === rule.transport;
    case "transport_model":
      // A model-granular rule matches ONLY that model. A backend of the same
      // transport carrying no model (a CLI whose model arrives at the dispatch
      // handshake) is NOT matched: the operator ruled out one model, not the
      // backend — the coarse `transport` tier is how they rule out the backend.
      return backend.transport === rule.transport && backend.model === rule.model;
    case "service":
      return (backend.service ?? backend.transport) === rule.service;
    case "service_model":
      return (
        (backend.service ?? backend.transport) === rule.service &&
        backend.model === rule.model
      );
    case "host":
      return endpointHosts(backend.endpoint).includes(rule.host);
    case "invalid":
      return false;
  }
}

/**
 * The forms of a source endpoint an operator pattern may name: `hostname` (port-
 * agnostic — `integrate.api.nvidia.com` rules out that host on any port) and
 * `host:port` (port-specific — `localhost:8000` rules out one of several local
 * endpoints). Both are offered so the pattern's own specificity decides.
 *
 * An endpoint that is not a URL (a CLI launcher command) degrades to the raw
 * lowercased string, which then only ever matches an identical literal pattern —
 * never a false positive against a real host.
 *
 * ⚠ The authority check is load-bearing, not defensive: `new URL()` accepts ANY
 * scheme-shaped string, so it does NOT throw on `localhost:8000` (protocol
 * `localhost:`) or on a Windows command path like `C:\tools\codex.cmd` (protocol
 * `c:`) — both parse to an EMPTY hostname. Relying on the `catch` alone would
 * therefore silently yield no hosts for exactly those endpoints, making an
 * operator's literal-identical rule match nothing.
 */
function endpointHosts(endpoint: string | undefined): string[] {
  if (!endpoint) return [];
  const raw = endpoint.toLowerCase();
  if (endpoint.includes("//")) {
    try {
      const url = new URL(endpoint);
      if (url.hostname.length > 0) {
        return [url.hostname.toLowerCase(), url.host.toLowerCase()];
      }
    } catch {
      // Not a URL after all — fall through to the raw literal.
    }
  }
  return [raw];
}

/**
 * Read the operator's confirmed route policy from the shared Gate-0 confirmation.
 *
 * Deliberately reads the artifact DIRECTLY rather than going through
 * {@link readSharedProviderConfirmation}, so that **a corrupt sibling field cannot
 * discard the decision**: `parseSharedProviderConfirmation` returns `null` wholesale
 * on any malformed required field or a `schema_version` mismatch. Routing policy
 * through it would make an unrelated corruption (or a future version bump) silently
 * lift the operator's exclusions — failing OPEN on the one field that must fail
 * closed. Parsing `policy` on its own keeps that blast radius out.
 *
 * (Before G3 this bypass carried a second rationale — dodging the roster-freshness
 * gate. That gate is gone: no read of this artifact is reach-gated any more, so the
 * remaining reason is blast radius alone.)
 *
 * **Honest limit — this is not absolutely fail-closed.** An absent or unparseable
 * artifact yields `null` (no operator policy). That residue is irreducible here: with
 * no readable decision on disk there is nothing to fail closed ON. Self-spawn-blocked
 * providers are still excluded locally by {@link resolveDispatchExclusion}, which
 * needs no artifact.
 */
export async function readConfirmedDispatchPolicy(
  root: string | undefined,
): Promise<ConfirmedDispatchPolicy | null> {
  if (!root) return null;
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(sharedProviderConfirmationPath(root));
  } catch {
    // Absent (ENOENT) / unreadable / invalid JSON — never-block, same contract as
    // every other read of this artifact.
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return parseConfirmedDispatchPolicy((raw as Record<string, unknown>).policy) ?? null;
}

// ---------------------------------------------------------------------------
// Write (audit writes it)
// ---------------------------------------------------------------------------

/**
 * Atomically write the shared confirmation to
 * `<root>/.audit-tools/provider-confirmation.json`. The durable write goes
 * through the shared atomic writer (temp + atomic rename) and the whole
 * operation is guarded by `withFileLock` so a concurrent writer can never
 * interleave — and a lockless reader (see `readSharedProviderConfirmation`)
 * never observes a torn file (CE-003).
 */
export async function writeSharedProviderConfirmation(
  root: string,
  confirmation: SharedProviderConfirmation,
  logger?: RunLogger,
): Promise<void> {
  const path = sharedProviderConfirmationPath(root);
  const lockPath = `${path}.lock`;
  // Ensure the `.audit-tools` dir exists BEFORE acquiring the lock — the lock is
  // a sibling file, so its atomic `wx` create would otherwise ENOENT on a fresh
  // root (mirrors StateStore.saveState mkdir-then-lock).
  await mkdir(auditToolsDir(root), { recursive: true });
  await withFileLock(
    lockPath,
    async () => {
      await writeJsonFile(path, confirmation);
    },
    undefined,
    logger,
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * The persisted pool entry's gate: `name` ONLY.
 *
 * B+D: this gate previously hard-required `capability_tier` AND `excluded` — the
 * exact reach fields B removes from the persisted shape. That coupling is why B and
 * D are ONE commit: a post-B artifact failing a pre-B gate parses to `null`, which
 * degrades SILENTLY to empty cost positions and λ=0. Requiring only `name` also
 * makes the gate forward-tolerant of a confirmation written before B (its extra
 * reach fields are simply ignored on read, never re-persisted).
 */
function isPersistedPoolEntry(value: unknown): value is PersistedPoolEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return typeof (value as Record<string, unknown>).name === "string";
}

function isHostModelCostEntry(value: unknown): value is HostModelCostEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.model_id === "string" &&
    // Optional (pre-field confirmations parse), but when present it must be a real
    // provider name — `confirmedBackendKeys` builds a gate key from it, and the
    // validator guards every field its callers read.
    (obj.provider === undefined ||
      (typeof obj.provider === "string" && isResolvedProviderName(obj.provider))) &&
    (obj.blended_price_usd_per_mtok === null ||
      typeof obj.blended_price_usd_per_mtok === "number") &&
    typeof obj.cost_order === "number"
  );
}

function isSourcePoolCostEntry(value: unknown): value is SourcePoolCostEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.source_id === "string" &&
    typeof obj.transport === "string" &&
    // Optional, but guarded: `confirmedBackendKeys` builds a gate key from it.
    (obj.service === undefined ||
      typeof obj.service === "string") &&
    (obj.model_id === undefined || typeof obj.model_id === "string") &&
    (obj.blended_price_usd_per_mtok === null ||
      typeof obj.blended_price_usd_per_mtok === "number") &&
    typeof obj.cost_order === "number"
  );
}

/**
 * Validate a parsed value as a SharedProviderConfirmation. Returns the typed
 * value or `null` when any required field is missing or malformed — a corrupt
 * artifact must degrade to the never-block path, never throw.
 */
function parseSharedProviderConfirmation(
  value: unknown,
): SharedProviderConfirmation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== SHARED_PROVIDER_CONFIRMATION_VERSION) return null;
  if (obj.session_level !== true) return null;
  if (typeof obj.confirmed_at !== "string") return null;
  if (
    !Array.isArray(obj.provider_pool) ||
    !obj.provider_pool.every(isPersistedPoolEntry)
  ) {
    return null;
  }
  // host_model_cost_order is optional + additive; a malformed value degrades to
  // absent (the field never blocks parsing — INV-DC1-6 never-block spirit).
  const hostModels =
    Array.isArray(obj.host_model_cost_order) &&
    obj.host_model_cost_order.every(isHostModelCostEntry)
      ? (obj.host_model_cost_order as HostModelCostEntry[])
      : undefined;
  // source_pool_cost_order is optional + additive; a malformed value degrades to absent.
  const sourcePools =
    Array.isArray(obj.source_pool_cost_order) &&
    obj.source_pool_cost_order.every(isSourcePoolCostEntry)
      ? (obj.source_pool_cost_order as SourcePoolCostEntry[])
      : undefined;
  // dispatch_bias is optional + additive; a malformed/out-of-range value degrades to
  // the cost-first default (clamp → undefined only when non-finite), never blocking.
  const dispatchBias = clampDispatchBias(obj.dispatch_bias);
  // policy is optional + additive; a malformed value degrades to absent. Note the
  // asymmetry with the fields above: degrading policy to absent fails OPEN (the
  // operator's exclusions stop applying), so each list is validated independently —
  // a malformed `include` must not silently discard a well-formed `exclude`.
  const policy = parseConfirmedDispatchPolicy(obj.policy);
  return {
    schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
    session_level: true,
    confirmed_at: obj.confirmed_at,
    provider_pool: obj.provider_pool as PersistedPoolEntry[],
    ...(hostModels && hostModels.length > 0
      ? { host_model_cost_order: hostModels }
      : {}),
    ...(sourcePools && sourcePools.length > 0
      ? { source_pool_cost_order: sourcePools }
      : {}),
    ...(dispatchBias != null ? { dispatch_bias: dispatchBias } : {}),
    ...(policy ? { policy } : {}),
  };
}

/**
 * Parse the optional policy half. Each list is validated on its own so one
 * malformed list cannot discard the other — degrading a well-formed `exclude` to
 * absent would fail OPEN and route to a backend the operator ruled out.
 */
function parseConfirmedDispatchPolicy(
  value: unknown,
): ConfirmedDispatchPolicy | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  // `exclude` is the OPEN exclusion grammar (a pattern's head need not be a provider
  // name — the endpoint tier's never is), so it is kept verbatim; an unmatchable
  // pattern is inert, which is the safe direction for a filter. `include` is the
  // CLOSED provider-name set and stays membership-checked, so an unknown name cannot
  // type-assert its way into overriding a self-spawn block.
  const exclude = parseExclusionPatterns(obj.exclude);
  const autoExclude = parseExclusionPatterns(obj.auto_exclude);
  const include = parseProviderNameList(obj.include);
  // Same open-grammar treatment as `exclude`: a capability key is a model id, not a
  // member of any closed set, so it is kept verbatim and an unmatchable key is inert.
  const capabilityOrder = Array.isArray(obj.capability_order)
    ? obj.capability_order.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : undefined;
  if (!exclude?.length && !autoExclude?.length && !include?.length && !capabilityOrder?.length) {
    return undefined;
  }
  return {
    ...(exclude?.length ? { exclude } : {}),
    ...(autoExclude?.length ? { auto_exclude: autoExclude } : {}),
    ...(include?.length ? { include } : {}),
    ...(capabilityOrder?.length ? { capability_order: capabilityOrder } : {}),
  };
}

// ---------------------------------------------------------------------------
// Read (remediate gains this)
// ---------------------------------------------------------------------------

/**
 * Read + parse the shared confirmation for `root`. TWO-valued:
 *
 *   - returns `null` when the artifact is ABSENT or MALFORMED — the caller then
 *     resolves its provider independently, exactly as today (INV-DC1-6
 *     never-block). Absence is the standalone-remediate case and is not an error.
 *   - returns the parsed confirmation otherwise — the operator's persisted route
 *     DECISION, honored as-is.
 *
 * **Reach-free by construction (G3).** This read does NOT check whether the
 * reachable backend set still matches whatever the writing auditor saw. It cannot
 * meaningfully: a *different* auditor legitimately has different reach, so that
 * comparison was noise cross-auditor — and answering it by discarding the
 * operator's decision fails OPEN on a policy question. A backend becoming newly
 * reachable is a real event, handled by the reconciliation gate
 * ({@link computeNewlyReachableBackends}), which compares the DECISION against
 * *this* auditor's reach and is keyed on `autonomous_mode`.
 *
 * Never throws: a read/parse failure is treated as absent/malformed → `null`.
 * The read is lockless (no lock needed: the writer's atomic rename guarantees a
 * complete file either way — CE-003) and so cannot deadlock against a writer.
 */
export async function readSharedProviderConfirmation(
  root: string,
): Promise<SharedProviderConfirmation | null> {
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(sharedProviderConfirmationPath(root));
  } catch (error) {
    // Both degrade to the never-block path, but only ABSENCE is legitimately silent.
    //
    // A file that EXISTS and cannot be read (truncated, invalid JSON, permissions) used
    // to return `null` with no warning, and that composed with two other
    // individually-justified silences into TOTAL silence: no pool gets a rank ⇒
    // `anyBanded === false`, which by design suppresses the capability fail-open
    // reporter; and `resolveUnevidencedCapabilityPools` returns `[]` on a null
    // confirmation ⇒ the obligation reports SATISFIED. Net effect on a corrupt file: the
    // capability floor is globally inert, every `deep` packet routes anywhere, and not
    // one path says a word — the exact case the loud path was built for.
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      warnConfirmationUnreadable(error, root);
    }
    return null;
  }
  // Malformed (wrong shape / version drift) → never-block, but never SILENT (D).
  const parsed = parseSharedProviderConfirmation(raw);
  if (parsed === null) warnConfirmationRejected(raw, root);
  return parsed;
}

/**
 * D — loud rejection. `null` from the parser is indistinguishable at the call sites
 * from "no confirmation exists", and every consumer treats that as "no operator
 * decision": empty cost positions, λ=0, no exclusions. So a `schema_version` bump —
 * or any shape drift — would SILENTLY discard the operator's whole route decision
 * and quietly re-route the run. Absence is legitimately silent; a file that EXISTS
 * and was rejected is not.
 *
 * A warning, not a throw: INV-DC1-6 (never-block) is the standing invariant here —
 * the same loud-degrade shape as `readQuotaStateOrDegrade` and the blind-dispatch
 * warning. Reached only on the rejection path, so it cannot become hot.
 */
/**
 * The sibling of {@link warnConfirmationRejected} for a file that exists but cannot be
 * READ (truncated write, invalid JSON, permissions) — the case that used to degrade
 * silently. Same never-block contract, same loud-degrade shape.
 *
 * The message names the CAPABILITY consequence explicitly because that is the one a
 * corrupt file silences most dangerously: with no ranks, nothing bands, the fail-open
 * reporter self-suppresses (it fires only when something else banded), and the
 * capability obligation simultaneously reports satisfied. Nothing else would tell the
 * operator their capability floor stopped existing.
 */
function warnConfirmationUnreadable(error: unknown, root: string): void {
  const why = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `WARNING: the provider confirmation at ${sharedProviderConfirmationPath(root)} exists ` +
      `but could NOT be read (${why}). It is being treated as absent: the operator's ` +
      `confirmed cost order, dispatch bias, and CAPABILITY RANKS are all unavailable, so ` +
      `the admission capability floor is inert for this run and packets may route to pools ` +
      `above their capability. Repair or delete the file and re-confirm at Gate-0.\n`,
  );
}

function warnConfirmationRejected(raw: unknown, root: string): void {
  const version =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).schema_version
      : undefined;
  const why =
    version !== undefined && version !== SHARED_PROVIDER_CONFIRMATION_VERSION
      ? `schema_version "${String(version)}" != expected "${SHARED_PROVIDER_CONFIRMATION_VERSION}"`
      : "malformed shape";
  // Scoped to what the rejection ACTUALLY discards. Exclusions deliberately survive:
  // `readConfirmedDispatchPolicy` bypasses this parser (and its version check) and reads
  // `policy` straight off the raw JSON, so an exclusion keeps failing CLOSED through a
  // schema drift — the correct direction, and the reason this message must NOT claim the
  // pool is unfiltered. Saying otherwise sends the operator hunting a routing change that
  // did not happen.
  process.stderr.write(
    `WARNING: ignoring the provider confirmation at ${sharedProviderConfirmationPath(root)} ` +
      `(${why}). The operator's confirmed COST ORDER and DISPATCH BIAS are NOT being applied ` +
      `to this run — dispatch falls back to price-then-tier at the default bias. ` +
      `(Exclusions are read separately and still apply.) Re-run the provider-confirmation ` +
      `gate to rewrite it.
`,
  );
}

/**
 * Read the operator-confirmed cost ordering (rung 1 of costRank; see
 * spec/cost-first-routing.md) from the shared Gate-0 confirmation as a model-keyed
 * `Map<model_id, cost_order>` for the dispatch build sites. Single-sourced so audit
 * and remediate honor it identically. Best-effort and never throws: an absent
 * `root` or a missing/malformed confirmation yields an empty map — dispatch then
 * falls to real price then tier.
 *
 * **Not gated on reach (G3 step 1).** The cost order is the operator's POLICY —
 * "the operator may reorder" — so a shift in what happens to be reachable must not
 * silently discard it. The former roster-freshness gate did exactly that, on the
 * false premise that these positions are reach-derived; they are not, and it was
 * the live defect this fixes.
 */
export async function readConfirmedCostPositions(
  root: string | undefined,
): Promise<Map<string, number>> {
  if (!root) return new Map();
  const confirmation = await readSharedProviderConfirmation(root);
  if (!confirmation) return new Map();
  // Provider-pool positions (configured models) PLUS any host-native tiers the
  // operator confirmed at Gate-0 (follow-up c). Both are model-keyed; a host tier
  // and a configured pool thread to dispatch identically. Host entries are already
  // in the single unified cost order, so a plain merge preserves the total order.
  const positions = resolveConfirmedCostPositions(confirmation.provider_pool);
  for (const entry of confirmation.host_model_cost_order ?? []) {
    if (
      entry.model_id &&
      Number.isFinite(entry.cost_order) &&
      entry.cost_order >= 0
    ) {
      positions.set(entry.model_id, entry.cost_order);
    }
  }
  // Source pools (explicit sources[] + proxy expansion) route by their confirmed
  // position keyed on the source's model id — the SAME model-keyed lookup a proxy
  // dispatch pool resolves against (pool.model = the namespaced `provider/model`). An entry
  // without a model_id is display-only and contributes no dispatch position.
  for (const entry of confirmation.source_pool_cost_order ?? []) {
    if (
      entry.model_id &&
      Number.isFinite(entry.cost_order) &&
      entry.cost_order >= 0 &&
      // FIRST-WINS, and this guard is load-bearing. This map is keyed by BARE model
      // id (costRank looks positions up with no service in hand), so two backends on
      // different services sharing a model string necessarily collide here. The
      // source fold used to prevent that by DROPPING such a source outright — which
      // silently cost the confirmed set that source's identity and livelocked its
      // Gate-0 confirmation. The fold is now identity-keyed and keeps the source, so
      // the collision surfaces here instead and is resolved in favor of the
      // provider/host entry, preserving the original "a source must not overwrite a
      // configured pool's position" intent without discarding the source.
      !positions.has(entry.model_id)
    ) {
      positions.set(entry.model_id, entry.cost_order);
    }
  }
  return positions;
}

/**
 * Read the confirmed per-model CAPABILITY ranks (LOWER = more capable) from the shared
 * Gate-0 confirmation as a model-keyed `Map<model_id, capability_rank>` for the pool
 * CONSTRUCTION sites (`buildHostModelPool` / `buildSourcePool` in shared/quota/apiPool).
 *
 * The capability-evidence obligation's read half: where an external rank source covers a
 * model, that evidence wins and this map is never consulted; where none does, this
 * carries the LLM-proposed or operator-authored RELATIVE ordering (or the explicit
 * "unrankable, accept at band X" escape) that cleared the gate.
 *
 * Deliberately mirrors {@link readConfirmedCostPositions} field-for-field — same three
 * sources, same model keyspace, same merge order — so a pool that has a confirmed cost
 * position and a confirmed capability rank resolves BOTH against the identical key. A
 * parallel keyspace here would reintroduce the model-less-pool unjoinability trap.
 *
 * Best-effort and never throws: absent `root`, missing/malformed confirmation, or an
 * absent field all yield an empty map — the pool then falls back to its registry rank,
 * and an entirely unranked pool bands to `null` exactly as before.
 *
 * **Not gated on reach**, for the same reason the cost positions are not: capability
 * evidence is a durable statement about a MODEL, not about what this auditor can
 * currently reach.
 */
/** One capability-rank-bearing entry on the confirmation, in the model keyspace. */
interface CapabilitySubject {
  modelId: string | undefined;
  rank: number | undefined;
  /** An excluded entry never dispatches, so it needs no evidence and is never asked about. */
  excluded: boolean;
}

/**
 * THE enumeration of every persisted entry that can carry a `capability_rank`, across
 * all three confirmation arrays.
 *
 * Single-sourced deliberately, and this is the fix for the round-3 critical defect: the
 * rank JOIN read three arrays while the evidence OBLIGATION enumerated only two, so
 * `provider_pool` was a rank SOURCE but never a delta SUBJECT — the conversation-first
 * default (host pool, no volunteered roster) therefore banded `null` forever and the
 * gate never once asked about it. Two independent walks over "the same" set is exactly
 * the drift this project keeps paying for; with one walk, a new rank-bearing array is
 * added HERE and both consumers follow automatically. Do not re-inline either walk.
 */
function* capabilitySubjects(
  confirmation: SharedProviderConfirmation,
): Generator<CapabilitySubject> {
  for (const entry of confirmation.provider_pool ?? []) {
    yield { modelId: entry.model_id, rank: entry.capability_rank, excluded: entry.excluded === true };
  }
  for (const entry of confirmation.host_model_cost_order ?? []) {
    yield { modelId: entry.model_id, rank: entry.capability_rank, excluded: false };
  }
  // `SourcePoolCostEntry.capability_rank` has existed and been WRITTEN since the Gate-0
  // source fold (providerConfirmation.ts) with no reader at all. This is that reader.
  for (const entry of confirmation.source_pool_cost_order ?? []) {
    yield { modelId: entry.model_id, rank: entry.capability_rank, excluded: false };
  }
}

/**
 * Is this a usable capability rank? A rank is a position in a relative ordering: finite
 * and non-negative. Shared by the join and the delta so "evidenced" means the same thing
 * to both — a predicate they disagreed on would re-create the drift above in miniature.
 */
function isUsableRank(rank: number | undefined): rank is number {
  return rank !== undefined && Number.isFinite(rank) && rank >= 0;
}

export async function readConfirmedCapabilityRanks(
  root: string | undefined,
): Promise<Map<string, number>> {
  if (!root) return new Map();
  const confirmation = await readSharedProviderConfirmation(root);
  if (!confirmation) return new Map();
  const ranks = new Map<string, number>();
  for (const subject of capabilitySubjects(confirmation)) {
    // An entry without a model_id is display-only and contributes no dispatch rank (it
    // is unjoinable by the model-keyed lookup — the infinite-re-prompt trap).
    if (!subject.modelId || !isUsableRank(subject.rank)) continue;
    ranks.set(subject.modelId, subject.rank);
  }
  return ranks;
}

/**
 * The capability-evidence delta: dispatchable models with NO resolvable capability
 * rank. Computed once per invocation (it reads the confirmation + gathers sources)
 * and threaded by reference on the gate, exactly like the reach delta.
 *
 * "Evidenced" is deliberately defined as **the dispatch join resolves** — the same
 * lookup the pool constructors take ({@link readConfirmedCapabilityRanks} keyed on the
 * pool's model), never a parallel predicate. Two consequences, both load-bearing:
 *   - a pool with NO model is skipped entirely. It is unjoinable, so pinning it could
 *     never clear the delta and it would re-prompt forever.
 *   - external evidence (`source.capability_rank`) counts, so a fully-ranked roster
 *     never fires the gate at all.
 *
 * Returns [] when no confirmation exists yet — the first-time `missing` case already
 * pauses for the operator, and reporting a delta against a pool they have never seen
 * would fold a second question into a prompt that has not asked the first one yet.
 *
 * Lives HERE, beside {@link readConfirmedCapabilityRanks}, rather than in the audit CLI
 * command it is called from: its failure mode is a LIVELOCK (wrongly admitting an
 * unrankable pool re-prompts `provider_confirmation` forever), and a delta computation
 * with that failure mode must be reachable by a test.
 */
export async function resolveUnevidencedCapabilityPools(
  root: string,
  effectiveConfig: SessionConfig,
): Promise<string[]> {
  const confirmation = await readSharedProviderConfirmation(root);
  if (!confirmation) return [];
  const primaryProviderName = resolveFreshSessionProviderName(
    undefined,
    effectiveConfig,
    { env: process.env },
  );
  const sources = await gatherDispatchableSources(
    effectiveConfig,
    primaryProviderName,
  );
  const confirmedRanks = await readConfirmedCapabilityRanks(root);
  const unevidenced = new Set<string>();
  for (const source of sources) {
    // Unjoinable ⇒ unpinnable ⇒ never admitted to the delta (see above).
    if (!source.model) continue;
    if (source.capability_rank != null) continue;
    if (confirmedRanks.has(source.model)) continue;
    unevidenced.add(source.model);
  }
  // Every PERSISTED rank-bearing entry, walked through the SAME enumeration the join
  // uses ({@link capabilitySubjects}) so the two can never disagree about what the
  // subjects are. Host models are ranked exactly like any other model — the host is not
  // a special case, it was simply never looked up — and `provider_pool` is included
  // here, which it previously was not (the round-3 critical defect: the default
  // conversation-first pool was unrankable AND unpinnable, so the fail-open it caused
  // had no road to a fix).
  for (const subject of capabilitySubjects(confirmation)) {
    // Unjoinable ⇒ unpinnable ⇒ never admitted to the delta, same rule as sources.
    if (!subject.modelId) continue;
    // An excluded pool never dispatches, so it needs no capability evidence — asking
    // about it would be a question whose answer changes nothing.
    if (subject.excluded) continue;
    if (isUsableRank(subject.rank)) continue;
    if (confirmedRanks.has(subject.modelId)) continue;
    unevidenced.add(subject.modelId);
  }
  // Stable, content-derived order (never gather/iteration order) — this string list
  // reaches the obligation's reason text and the prompt, and an incidentally-ordered
  // array churns downstream content hashes.
  return [...unevidenced].sort();
}

/**
 * Read the operator-confirmed cost↔speed dispatch bias (λ ∈ [0,1]) from the shared
 * Gate-0 confirmation for the dispatch build sites (spec/dispatch-cost-speed-dial.md).
 * Single-sourced so audit and remediate apply the identical operating point.
 * Best-effort and never throws: an absent `root`, a missing/malformed confirmation,
 * or an absent field all yield the cost-first default `0`.
 *
 * **Not gated on reach (G3 step 1)** — λ is the operator's durable operating point
 * on the cost-vs-throughput frontier, i.e. POLICY. See
 * {@link readConfirmedCostPositions}.
 */
export async function readConfirmedDispatchBias(
  root: string | undefined,
): Promise<number> {
  if (!root) return 0;
  const confirmation = await readSharedProviderConfirmation(root);
  if (!confirmation) return 0;
  return clampDispatchBias(confirmation.dispatch_bias) ?? 0;
}

// ---------------------------------------------------------------------------
// Interactive Gate-0 operator input (spec/cost-first-routing.md — Gate-0)
// ---------------------------------------------------------------------------

/** File name of the host-written Gate-0 input under the audit artifacts dir. */
export const PROVIDER_CONFIRMATION_INPUT_FILENAME =
  "provider-confirmation.input.json";

/**
 * Validate a parsed value as a ProviderConfirmationInput. Degrade-safe: returns
 * `null` for absent/malformed so a missing or corrupt input is never an error
 * (the executor then falls back to the tool's suggested ordering). Only the
 * version is required; every other field is optional and validated to its
 * expected shape (a malformed field is dropped, not fatal).
 */
export function parseProviderConfirmationInput(
  value: unknown,
): ProviderConfirmationInput | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.schema_version !== PROVIDER_CONFIRMATION_INPUT_VERSION) return null;
  const stringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : undefined;
  const costOrder = stringArray(obj.cost_order);
  // The capability-evidence answer. MUST be reconstructed here explicitly: this parser
  // is field-by-field, so an unlisted field is silently dropped — and dropping THIS one
  // is not a degrade, it is a livelock. The operator answers the prompt, the answer
  // never reaches `annotateConfirmedPool`, no `capability_rank` is written, the delta
  // recomputes identical, and `provider_confirmation` (PRIORITY[0]) re-prompts the same
  // question forever. Any future field on ProviderConfirmationInput needs a line here.
  const capabilityOrder = stringArray(obj.capability_order);
  // No cast: `exclude` is the OPEN exclusion grammar, so asserting the operator's
  // raw strings into the closed provider-name union would be a lie — and the exact
  // type-assert-your-way-in move the policy parser refuses for `include`.
  const exclude = stringArray(obj.exclude);
  const include = stringArray(obj.include) as
    | ResolvedProviderName[]
    | undefined;
  const dispatchBias = clampDispatchBias(obj.dispatch_bias);
  // An EXPLICIT empty array is preserved, not dropped to absent. `[]` is the
  // operator deliberately emptying their host roster; omission is them saying
  // nothing about it. `carryForwardConfirmationInput` reseeds only the second case,
  // so collapsing the two here would resurrect a roster the operator deleted — and
  // there would be no way left to express the deletion at all.
  const hostModels = Array.isArray(obj.host_models)
    ? obj.host_models
        .filter(
          (m): m is { model_id: string } =>
            m !== null &&
            typeof m === "object" &&
            typeof (m as { model_id?: unknown }).model_id === "string",
        )
        .map((m) => ({ model_id: m.model_id }))
    : undefined;
  return {
    schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
    ...(costOrder ? { cost_order: costOrder } : {}),
    ...(capabilityOrder ? { capability_order: capabilityOrder } : {}),
    ...(exclude ? { exclude } : {}),
    ...(include ? { include } : {}),
    ...(hostModels ? { host_models: hostModels } : {}),
    ...(dispatchBias != null ? { dispatch_bias: dispatchBias } : {}),
  };
}

/**
 * Seed an incoming Gate-0 submission from the PRIOR confirmation, field by field.
 *
 * **The defect class this closes.** `buildProviderConfirmationRender` rebuilds the
 * whole confirmation from the submission ALONE — every operator decision it persists
 * (`cost_order`, `capability_rank`, the host roster, λ, and the `policy` exclusions) is
 * reconstructed from `input` and from nothing else. So *any* field a submission omits
 * is not "left alone", it is DESTROYED. That is one defect with six faces, and fixing
 * it per-field is what let three of them survive a review round: the prompt's capability
 * example is `{ "capability_order": [...] }`, so an operator answering exactly what was
 * asked omits all five other fields and silently wipes them.
 *
 * Two rules, both load-bearing:
 *
 * 1. **`undefined` means "said nothing"; an explicit empty array means "delete".** A
 *    submission that never mentions host models is not a decision to remove them; an
 *    explicit `"host_models": []` is. `parseProviderConfirmationInput` therefore
 *    PRESERVES an empty array rather than dropping it to absent — without that the two
 *    cases are indistinguishable here and the carry-forward resurrects a roster the
 *    operator deleted.
 * 2. **It applies with `input === null` too.** The autonomous/headless path promotes
 *    with no submission at all, and the capability delta is a brand-new trigger for
 *    that path — so short-circuiting on `input &&` would let an unattended re-promotion
 *    wipe the operator's entire persisted decision and then report convergence.
 *
 * Returns `null` only when there is nothing on either side. A prior confirmation with
 * no incoming submission still yields a synthesized input carrying it forward.
 */
/**
 * The gate-authored exclusions that SURVIVE this promotion.
 *
 * Round-3 defect (high, fail-OPEN): `auto_exclude` was rebuilt on every promotion from
 * `gate.newlyReachable` alone. But `confirmedBackendKeys` counts an excluded entry as
 * CONFIRMED, so once the gate fail-closed-excludes backend X and folds it into the pool,
 * the reach delta is empty forever — and the very next promotion rebuilt `auto_exclude`
 * from that empty delta and dropped X, making a backend the operator never confirmed
 * dispatchable. The docstring's "a submission supersedes it" was true; the code
 * superseded it on EVERY promotion, including the no-submission one.
 *
 * The rule is therefore narrower than "any submission clears it". A submission
 * supersedes an auto-exclusion only when it actually ADDRESSES that backend:
 *   - the operator re-stated the pattern in `exclude` — it is now operator-authored and
 *     lives there, so retaining an `auto_exclude` copy would double-record it; or
 *   - the operator named that provider in `include` — an explicit opt-back-IN.
 * Anything else is SILENCE, and silence is not confirmation ("the operator confirms
 * model choices"). A capability-only answer must not lift an exclusion the operator was
 * never even shown — the reach section does not render once the backend is a confirmed
 * key, so they cannot see what they would be lifting.
 *
 * Fail-CLOSED by construction: the uncertain case retains the exclusion.
 */
export function retainAutoExclusions(
  priorAuto: readonly DispatchExclusionPattern[],
  input: ProviderConfirmationInput | null,
): DispatchExclusionPattern[] {
  if (priorAuto.length === 0) return [];
  const restated = new Set(input?.exclude ?? []);
  const optedIn = input?.include ?? [];
  const addressed = (pattern: DispatchExclusionPattern): boolean => {
    if (restated.has(pattern)) return true;
    // `provider` and `provider:model` tiers both belong to the named provider.
    return optedIn.some(
      (provider) => pattern === provider || pattern.startsWith(`${provider}:`),
    );
  };
  return priorAuto.filter((pattern) => !addressed(pattern));
}

export function carryForwardConfirmationInput(
  input: ProviderConfirmationInput | null,
  prior: SharedProviderConfirmation | null,
): ProviderConfirmationInput | null {
  if (!prior) return input;
  const base: ProviderConfirmationInput = input ?? {
    schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
  };
  const priorHostModels = (prior.host_model_cost_order ?? []).map((entry) => ({
    model_id: entry.model_id,
  }));
  const priorCostOrder = priorConfirmedCostOrder(prior);
  // The operator's RAW answer, read back verbatim — never reconstructed from the
  // resulting `capability_rank`s. Reconstruction could not tell an operator-authored
  // rank from EXTERNAL evidence, so it laundered external numbers into the operator's
  // ordering and made the laundered model read as evidenced forever.
  const priorCapabilityOrder = prior.policy?.capability_order ?? [];
  // `exclude` ONLY — `auto_exclude` is deliberately NOT carried. It is the gate's
  // placeholder for an answer the operator never gave, and a submission supersedes it.
  const priorExclude = prior.policy?.exclude ?? [];
  const priorInclude = prior.policy?.include ?? [];
  return {
    ...base,
    // `=== undefined` at every field, never a truthiness/length test: that is the
    // said-nothing-vs-delete distinction, and a `!length` test collapses them.
    ...(base.cost_order === undefined && priorCostOrder.length > 0
      ? { cost_order: priorCostOrder }
      : {}),
    // The capability answer is the ONE field that does not follow the plain
    // said-nothing/carry rule, because its PROMPT is delta-scoped: it renders only the
    // unevidenced models, so a submission is a partial answer BY CONSTRUCTION and
    // taking it as the whole ordering erases every rank the operator gave before —
    // the `PRIORITY[0]` livelock. It is therefore MERGED by anchored insertion rather
    // than replacing or being replaced (see {@link mergeCapabilityOrder}).
    //
    // The MERGED order is what gets persisted, not the raw submission:
    // `buildConfirmedDispatchPolicy` stores whatever `input.capability_order` holds, and
    // `policy.capability_order` is the only thing the NEXT promotion reads back. Keeping
    // the raw answer there instead would mean the prior answers exist nowhere on disk and
    // the merge would have nothing to merge against on the third promotion — the livelock
    // one round-trip later. This does NOT undo "store the operator's answer verbatim":
    // that rule exists to keep EXTERNAL evidence out of the operator's ordering, and both
    // operands here are operator answers. Nothing derived from a `capability_rank` (which
    // cannot distinguish operator from external provenance) enters this list.
    ...(base.capability_order === undefined
      ? priorCapabilityOrder.length > 0
        ? { capability_order: priorCapabilityOrder }
        : {}
      : { capability_order: mergeCapabilityOrder(priorCapabilityOrder, base.capability_order) }),
    ...(base.host_models === undefined && priorHostModels.length > 0
      ? { host_models: priorHostModels }
      : {}),
    ...(base.exclude === undefined && priorExclude.length > 0
      ? { exclude: [...priorExclude] }
      : {}),
    ...(base.include === undefined && priorInclude.length > 0
      ? { include: [...priorInclude] }
      : {}),
    ...(base.dispatch_bias === undefined && prior.dispatch_bias !== undefined
      ? { dispatch_bias: prior.dispatch_bias }
      : {}),
  };
}

/** How many already-ranked models the capability prompt shows as fixed reference points. */
export const DEFAULT_CAPABILITY_ANCHOR_COUNT = 5;

/**
 * Pick a BOUNDED, spread sample of an already-confirmed capability ordering to show
 * beside the unevidenced models as fixed reference points.
 *
 * The roster may be HUNDREDS of models, so the prompt must be O(new + constant) — it
 * can never render the whole ordering. First, last, and evenly-spaced interior picks
 * give the operator a usable coordinate space (top / middle / bottom of the confirmed
 * ranking) at constant cost, which is exactly what {@link mergeCapabilityOrder}
 * interpolates against.
 *
 * @param priorOrder - The confirmed ordering, most-capable-first.
 * @param exclude    - Models already being asked about (the unevidenced delta); an
 *   anchor must be a model whose rank is settled, never one under question.
 * @param max        - Ceiling on the sample size.
 */
export function selectCapabilityAnchors(
  priorOrder: readonly string[],
  exclude: readonly string[] = [],
  max: number = DEFAULT_CAPABILITY_ANCHOR_COUNT,
): string[] {
  const excluded = new Set(exclude);
  const unique = [...new Set(priorOrder)].filter((id) => !excluded.has(id));
  if (max <= 0) return [];
  if (unique.length <= max || max === 1) return unique.slice(0, max);
  // Evenly spaced, endpoints included. `Set` absorbs a repeated index when the
  // ordering is barely longer than `max`, so the result is never padded with dupes.
  const picks = new Set<number>();
  for (let i = 0; i < max; i++) {
    picks.add(Math.round((i * (unique.length - 1)) / (max - 1)));
  }
  return [...picks].sort((a, b) => a - b).map((i) => unique[i] as string);
}

/**
 * The anchor ids whose relative order the submission changed but the merge will NOT
 * honor — i.e. an operator reorder that is about to be silently discarded.
 *
 * {@link mergeCapabilityOrder} treats every submitted id already present in
 * `priorOrder` as a FIXED reference point, so a submission that swaps two of them
 * returns the prior order unchanged. Without this, that is invisible: the promotion
 * succeeds, the artifact is byte-identical, and nothing anywhere says the operator's
 * decision was dropped. `unrankedOnPromotion` cannot catch it either — a reordered id
 * IS present in `capability_order`, so it reports nothing.
 *
 * An accepted-then-discarded operator decision is the same defect class as laundering a
 * tool guess into operator policy: not corruption, but SILENCE. The standing rule is
 * that the operator must never have to notice — so the caller reports this loudly.
 *
 * Returns `[]` when the reorder will actually be honored: a TOTAL submission (every
 * prior id restated) is applied verbatim, and a submission with fewer than two anchors
 * cannot express a reorder at all.
 *
 * NOTE this reports the LIMITATION, it does not lift it. Making a repositioning
 * expressible without restating the whole roster needs the anchor-provenance split
 * tracked in `docs/backlog.md`; this only ensures the drop is never silent.
 */
export function detectDiscardedCapabilityReorder(
  priorOrder: readonly string[],
  submitted: readonly string[],
): string[] {
  const prior = [...new Set(priorOrder)];
  const answer = [...new Set(submitted)];
  if (prior.length === 0 || answer.length === 0) return [];
  const priorPos = new Map(prior.map((id, index) => [id, index]));
  // A total submission is honored verbatim — nothing is discarded. Mirrors the same
  // condition in `mergeCapabilityOrder`; the two must agree or this reports phantoms.
  if (prior.every((id) => answer.includes(id))) return [];
  const anchors = answer.filter((id) => priorPos.has(id));
  if (anchors.length < 2) return [];
  // Discarded iff the anchors' order in the SUBMISSION differs from their order in the
  // PRIOR ordering — compare against the anchors sorted by prior position.
  const asConfirmed = [...anchors].sort(
    (a, b) => (priorPos.get(a) as number) - (priorPos.get(b) as number),
  );
  // Report only the anchors that actually MOVED, not every anchor in the submission.
  // `["a","c","b"]` against `["a","b","c","d"]` moves `c` and `b`; naming `a` too would
  // tell the operator their unchanged entry was dropped, which is false — and a warning
  // that over-reports is one the operator learns to discount.
  return anchors.filter((id, i) => id !== asConfirmed[i]);
}

/**
 * Merge an operator's capability answer into the previously confirmed ordering by
 * **ANCHORED INSERTION**.
 *
 * **The livelock this closes.** The capability prompt is DELTA-SCOPED — it renders only
 * the models with no evidence — while `annotateConfirmedPool` built its positions from
 * the submission ALONE, i.e. total replacement. So each answer erased the last: rank A,
 * the delta asks C, rank C, A loses its rank, the delta asks A, forever. `PRIORITY[0]`
 * never converges. Reproduced across three promotions.
 *
 * The fix cannot be "render the whole ordering" (the roster may be hundreds of models —
 * the prompt must stay O(new + constant)) and it cannot be an absolute score or tier
 * (only a RELATIVE ordering is representable, by standing decision). Anchored insertion
 * is what remains: show a bounded, spread sample of the confirmed ordering
 * ({@link selectCapabilityAnchors}) as fixed reference points, and interpolate the new
 * models into the coordinate space those points define.
 *
 * Semantics, exactly:
 *
 * - **Anchors** = submitted entries that already appear in `priorOrder`. They are
 *   REFERENCE POINTS: their prior positions define the coordinate space, and **a
 *   reordering of anchors relative to each other is deliberately NOT honored** on a
 *   partial submission. The operator saw at most a handful of them out of a possibly
 *   enormous ordering, so a swap between two anchors carries no information about the
 *   models BETWEEN them — honoring it would silently reshuffle models the operator
 *   never saw.
 * - **Exception — a TOTAL submission is a total replacement.** When the submission
 *   mentions every model in `priorOrder` there are no unmentioned models, so the
 *   coordinate space is fully respecified and the answer is honored verbatim. This is
 *   the only case where "reorder what you already confirmed" is a well-defined request,
 *   and it is the pre-existing behavior for a complete re-ranking.
 * - **New models** (not in `priorOrder`) interpolate to a fractional position between
 *   the prior positions of the nearest preceding and following anchors IN THE SUBMITTED
 *   LIST. Before the first anchor ⇒ just below it (more capable); after the last ⇒ just
 *   above it. Consecutive new models keep their submitted relative order.
 * - **Every model in `priorOrder` the submission does not mention keeps its prior
 *   position.** THIS IS THE LIVELOCK FIX.
 * - **No anchors at all** (a partial submission naming only unknown models): there is no
 *   coordinate to interpolate against, so the new models are appended AFTER the whole
 *   prior ordering — the conservative direction, since a higher rank is less capable and
 *   therefore trusted with less.
 * - **Duplicates**: first occurrence wins, matching `annotateConfirmedPool`'s rule that a
 *   positional list is the operator's ordering and a later repeat must not re-rank it.
 * - **Result** is every model sorted by resolved position, ties broken by model id.
 *   Deterministic by construction: an incidentally-ordered array here would churn the
 *   confirmation's content hash on every promotion and cascade phantom staleness.
 *
 * Degenerate cases: an empty `priorOrder` (the first-ever answer) returns the submission;
 * an empty submission returns the prior ordering unchanged (an omitted answer is
 * "said nothing" — there is no way to express "delete the whole ranking", and the
 * un-delete direction is the one that cannot livelock).
 *
 * Pure — no I/O, no clock, no config. Exported so the merge that decides whether the
 * gate converges is directly testable.
 */
export function mergeCapabilityOrder(
  priorOrder: readonly string[],
  submitted: readonly string[],
): string[] {
  const prior = [...new Set(priorOrder)];
  const answer = [...new Set(submitted)];
  if (prior.length === 0) return answer;
  if (answer.length === 0) return prior;
  const priorPos = new Map<string, number>(prior.map((id, index) => [id, index]));
  // TOTAL submission ⇒ total replacement (see the docstring's exception).
  if (prior.every((id) => priorPos.has(id) && answer.includes(id))) return answer;

  /** Resolved position per model — seeded with every prior model, so an unmentioned one keeps its rank. */
  const positions = new Map<string, number>(priorPos);
  const anchorCount = answer.filter((id) => priorPos.has(id)).length;
  if (anchorCount === 0) {
    answer.forEach((id, index) => positions.set(id, prior.length + index));
  } else {
    let i = 0;
    while (i < answer.length) {
      if (priorPos.has(answer[i] as string)) {
        i++;
        continue;
      }
      // A maximal run of NEW models, [i, j). `answer[i - 1]` is necessarily an anchor
      // when `i > 0` — otherwise the run would have started earlier.
      let j = i;
      while (j < answer.length && !priorPos.has(answer[j] as string)) j++;
      const before = i > 0 ? priorPos.get(answer[i - 1] as string) : undefined;
      const after = j < answer.length ? priorPos.get(answer[j] as string) : undefined;
      let lo: number;
      let hi: number;
      if (before === undefined) {
        hi = after as number;
        lo = hi - 1;
      } else if (after === undefined) {
        lo = before;
        hi = lo + 1;
      } else {
        lo = before;
        // A reordered anchor pair yields an inverted or empty span. Anchor reordering
        // is not honored, so degrade to "insert just after the preceding anchor"
        // rather than emitting descending positions.
        hi = after > lo ? after : lo + 1;
      }
      const run = j - i;
      for (let t = 0; t < run; t++) {
        positions.set(answer[i + t] as string, lo + ((hi - lo) * (t + 1)) / (run + 1));
      }
      i = j;
    }
  }
  return [...positions.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([id]) => id);
}

/**
 * Reconstruct the operator's confirmed cost ordering as the `cost_order` KEY list a
 * fresh submission would carry — i.e. the inverse of `resolveFinalCostOrder`'s
 * index⇒position mapping.
 *
 * Keyspace is the CANDIDATE key (`annotateConfirmedPool`'s `CostCandidate.key`):
 * provider NAME for a provider pool, `model_id` for a host tier, `source_id` for a
 * source pool. Deliberately NOT the MODEL keyspace the capability ordering
 * ({@link mergeCapabilityOrder}) uses — the two genuinely key differently on the write
 * side (a provider entry is capability-ranked by its `model_id`, never by its provider
 * name), and unifying
 * them here would silently drop every provider pool's position.
 */
function priorConfirmedCostOrder(prior: SharedProviderConfirmation): string[] {
  const ranked: Array<{ key: string; order: number }> = [];
  for (const entry of prior.provider_pool ?? []) {
    if (typeof entry.cost_order === "number") {
      ranked.push({ key: entry.name, order: entry.cost_order });
    }
  }
  for (const entry of prior.host_model_cost_order ?? []) {
    ranked.push({ key: entry.model_id, order: entry.cost_order });
  }
  for (const entry of prior.source_pool_cost_order ?? []) {
    ranked.push({ key: entry.source_id, order: entry.cost_order });
  }
  return sortRankedKeys(ranked);
}

/**
 * Rank-ascending key list, de-duplicated first-occurrence-wins. The key tiebreak keeps
 * the result deterministic when two pools share a position (a host tier defaulting to
 * `cost_order: 0`, say) — an incidentally-ordered list here would churn the artifact's
 * content hash on every promotion and cascade phantom staleness downstream.
 */
function sortRankedKeys(ranked: Array<{ key: string; order: number }>): string[] {
  const seen = new Set<string>();
  return ranked
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key))
    .filter((entry) => (seen.has(entry.key) ? false : (seen.add(entry.key), true)))
    .map((entry) => entry.key);
}

/**
 * Read the operator's Gate-0 input from `<artifactsDir>/provider-confirmation.input.json`.
 * Returns `null` when the file is absent, unreadable, or malformed — the "operator
 * has not acted yet" signal the gate uses to decide emit-vs-consume. Never throws.
 */
export async function readProviderConfirmationInput(
  artifactsDir: string,
): Promise<ProviderConfirmationInput | null> {
  const path = join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME);
  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(path);
  } catch {
    return null;
  }
  return parseProviderConfirmationInput(raw);
}

/**
 * Invalidate a CONSUMED Gate-0 input by deleting it — the second half of
 * consume-and-invalidate, paired here with {@link readProviderConfirmationInput} so
 * the two cannot drift apart.
 *
 * The input's presence is the "operator has acted" signal the gate reads to decide
 * emit-vs-consume. Once promoted into the canonical artifacts it is SPENT: leaving it
 * on disk means a later reconciliation delta silently re-consumes a submission that
 * answered an older question, auto-satisfying the gate instead of asking the
 * operator. Deleting it is what makes the gate able to fire a second time at all.
 *
 * Best-effort and never throws: an already-absent file is the desired end state, and
 * a failed unlink must not break the in-flight obligation (the promotion itself
 * already succeeded).
 */
export async function unlinkProviderConfirmationInput(
  artifactsDir: string,
): Promise<void> {
  try {
    await unlink(join(artifactsDir, PROVIDER_CONFIRMATION_INPUT_FILENAME));
  } catch {
    // Absent / locked / read-only — nothing to invalidate, or nothing we can do.
  }
}
