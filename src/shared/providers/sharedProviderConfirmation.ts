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
import { resolveConfirmedCostPositions } from "../dispatch/costRank.js";
import type {
  ConfirmedPoolEntry,
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
 * READING process (see {@link resolveExcludedProviders}).
 *
 * Because policy is reach-independent, it stays valid when the discovered reach
 * changes. No read of this artifact gates on a reach check, for exactly that
 * reason: an exclusion must fail CLOSED (keep excluding) when reach shifts, never
 * fail open — and neither may the cost order or λ be discarded by a reach event
 * they do not depend on (G3 step 1).
 */
export interface ConfirmedDispatchPolicy {
  /** Provider names the operator excluded from the dispatchable pool. */
  exclude?: ResolvedProviderName[];
  /** Self-spawn-blocked provider names the operator explicitly opted back IN. */
  include?: ResolvedProviderName[];
}

export interface SharedProviderConfirmation {
  /** Must equal SHARED_PROVIDER_CONFIRMATION_VERSION. */
  schema_version: typeof SHARED_PROVIDER_CONFIRMATION_VERSION;
  /**
   * The operator's explicit, reach-free route decision. Read at dispatch by
   * {@link resolveExcludedProviders} and applied as a set-difference filter over
   * freshly-discovered reach — never additively. Absent ⇒ no operator exclusions
   * (self-spawn-blocked providers are still excluded, recomputed locally).
   */
  policy?: ConfirmedDispatchPolicy;
  /** Always true: the pool applies to the whole audit→remediate session. */
  session_level: true;
  /** ISO-8601 timestamp of when the pool was confirmed. */
  confirmed_at: string;
  /** Confirmed provider pool, with exclusion flags. */
  provider_pool: ConfirmedPoolEntry[];
  /**
   * Host self-reported model tiers with their operator-confirmed cost positions
   * (follow-up c). Merged into the model-keyed dispatch positions map by
   * `readConfirmedCostPositions` so host-native tiers route by their confirmed
   * order. Absent/empty on the headless path (no host roster is reported).
   */
  host_model_cost_order?: HostModelCostEntry[];
  /**
   * Dispatchable SOURCE pools (explicit `sources[]` + repair-proxy expansion) with their
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

function sortNames(names: readonly ResolvedProviderName[]): ResolvedProviderName[] {
  // Deduplicate + sort so a persisted list is order-insensitive and stable.
  return [...new Set(names)].sort();
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
 * @param exclude       - Provider names to pre-exclude (from a prior gate).
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
export function buildSharedProviderConfirmation(
  sessionConfig: SessionConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  exclude: ResolvedProviderName[] = [],
  include: ResolvedProviderName[] = [],
  detectCommand?: (command: string) => boolean,
  input?: ProviderConfirmationInput,
  sources: DispatchableSource[] = [],
): SharedProviderConfirmation {
  const discovered = discoverProviders(sessionConfig, env, detectCommand);
  const excludeSet = new Set<ResolvedProviderName>(exclude);
  const includeSet = new Set<ResolvedProviderName>(include);

  const pool: ConfirmedPoolEntry[] = [];

  // Always include worker-command as a fallback — it's always available and is
  // never surfaced by PATH discovery (it blocks auto-dispatch by design).
  if (!discovered.some((p) => p.name === "worker-command")) {
    pool.push({
      name: "worker-command",
      capability_tier: "unknown" satisfies CapabilityTier,
      excluded: excludeSet.has("worker-command"),
      reason: "always-available fallback; no PATH detection required",
    });
  }

  for (const provider of discovered) {
    // Self-spawn-blocked providers are excluded from the dispatchable pool by
    // default; the operator can opt one back in via `include`. An operator-named
    // `exclude` always wins. The machine-readable flag rides along so downstream
    // consumers never have to parse `reason`.
    const blocked = provider.selfSpawnBlocked === true;
    const operatorIncluded = includeSet.has(provider.name);
    const excluded =
      excludeSet.has(provider.name) || (blocked && !operatorIncluded);
    pool.push({
      name: provider.name,
      capability_tier: provider.capabilityTier,
      excluded,
      ...(blocked ? { self_spawn_blocked: true } : {}),
      reason: provider.reason,
    });
  }

  // Cost-first routing: annotate with representative model price + cost_order,
  // read at dispatch as rung 1 of costRank (spec/cost-first-routing.md). When an
  // operator input is present its ordering wins and its host roster is priced.
  const annotated = annotateConfirmedPool(pool, sessionConfig, input, sources);
  return {
    schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
    session_level: true,
    confirmed_at: new Date().toISOString(),
    provider_pool: annotated.provider_pool,
    ...(annotated.host_model_cost_order.length > 0
      ? { host_model_cost_order: annotated.host_model_cost_order }
      : {}),
    ...(annotated.source_pool_cost_order.length > 0
      ? { source_pool_cost_order: annotated.source_pool_cost_order }
      : {}),
    ...(clampDispatchBias(input?.dispatch_bias) != null
      ? { dispatch_bias: clampDispatchBias(input?.dispatch_bias) }
      : {}),
    ...(buildConfirmedDispatchPolicy(exclude, include) ?? {}),
  };
}

/**
 * Lift the operator's explicit route decision out of their Gate-0 input into the
 * persisted policy half. Returns `undefined` when the operator named neither list
 * (so the field stays absent rather than persisting an empty shell).
 */
function buildConfirmedDispatchPolicy(
  exclude: readonly ResolvedProviderName[],
  include: readonly ResolvedProviderName[],
): { policy: ConfirmedDispatchPolicy } | undefined {
  if (exclude.length === 0 && include.length === 0) return undefined;
  return {
    policy: {
      ...(exclude.length > 0 ? { exclude: sortNames(exclude) } : {}),
      ...(include.length > 0 ? { include: sortNames(include) } : {}),
    },
  };
}

/**
 * The dispatchable-pool exclusion set for THIS process: the operator's explicit
 * exclusions, plus every provider that is self-spawn-blocked *in this process's
 * env* and was not explicitly opted back in.
 *
 * Reach is recomputed here rather than read from the artifact's derived `excluded`
 * flag — that flag encodes the WRITING auditor's env, and an auditor for whom a
 * provider is perfectly spawnable must not inherit another's block. The operator's
 * decision is inherited (it is a rule); the reach assessment is not.
 *
 * ⚠ **This set is only safe to apply to SOURCE pools.** Inside any agent session it
 * ALWAYS contains that agent (`CLAUDECODE` ⇒ `claude-code`, `CODEX` ⇒ `codex`) — i.e.
 * the conversation host itself. Applying it to HOST pools would zero out dispatch
 * entirely: the driver would exclude itself. It is harmless at `buildSourcePools`
 * only because a host can never BE a source — `claude-code` is structurally absent
 * from `DISPATCHABLE_SOURCE_PROVIDERS`, so in a Claude Code session the filter is a
 * no-op. Honoring an operator exclusion of the host/primary provider therefore is NOT
 * a matter of passing this set to the host-pool builder; it needs a separate decision
 * about what excluding your own driver should even mean.
 */
/**
 * Keep only real provider names, dropping anything unknown. Returns `undefined` for a
 * non-array or an array with no recognizable name, so an unknown entry degrades that
 * entry — never the whole list.
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
 * The gate's comparison key for one backend: **the model where it is knowable,
 * else the coarse provider name.**
 *
 * This is the operator-facing exclusion grammar's own provision (`provider:model`,
 * with `provider` as the coarser pattern — spec/unified-dispatch-worker-model.md).
 * Model granularity is the POINT, not a refinement: the operator confirms *model*
 * choices, so a second model under an already-confirmed `openai-compatible` is a
 * new choice even though it introduces no new provider.
 *
 * But a bare-`model_id` key would be worse than useless: `representativeModelId`
 * knows a model only for `openai-compatible` and `codex` — for claude-code / agy /
 * opencode / worker-command a CLI backend's model arrives only at the dispatch
 * handshake. Such a backend would contribute NO key, so installing `agy` on PATH
 * would leave the delta empty and the gate would silently dispatch it — re-opening
 * the exact PATH-appearance case the gate exists to catch, blind rather than loud.
 *
 * ⚠ This is a THIRD keyspace, deliberately distinct from the quota-ledger pool
 * identity (`provider[#account]/model`, `buildProviderModelKey`) — an account is
 * irrelevant to a rule about a backend. Do not unify them.
 */
function backendGateKey(
  modelId: string | undefined,
  providerName: string,
): string {
  return modelId ?? providerName;
}

/**
 * The keys of the operator's persisted DECISION — the CONFIRMED half of the gate.
 *
 * All three pools contribute, and each is load-bearing: `annotateConfirmedPool`
 * folds a source away when its model is already claimed by a provider entry, so a
 * source can be represented ONLY by `provider_pool[].model_id`; and a host tier
 * appears only in `host_model_cost_order`. Reading fewer than all three would
 * manufacture a phantom delta for an already-confirmed backend.
 */
export function confirmedBackendKeys(
  confirmation: SharedProviderConfirmation,
): Set<string> {
  const keys = new Set<string>();
  for (const entry of confirmation.provider_pool) {
    keys.add(backendGateKey(entry.model_id, entry.name));
  }
  for (const entry of confirmation.source_pool_cost_order ?? []) {
    keys.add(backendGateKey(entry.model_id, entry.provider));
  }
  for (const entry of confirmation.host_model_cost_order ?? []) {
    keys.add(entry.model_id);
  }
  return keys;
}

/** One backend in the gate's delta: reachable now, absent from the decision. */
export interface NewlyReachableBackend {
  /** The gate key — `model_id ?? provider name`. Stable, operator-facing. */
  key: string;
  /**
   * The backend's provider name. Carried alongside `key` because the two are
   * consumed at DIFFERENT granularities: the gate compares `key` (model-level — the
   * point of the gate), while A′'s `policy.exclude` is still
   * `ResolvedProviderName[]` and can only express a provider-level exclusion.
   * A″ widens `exclude` to the `provider:model` grammar, after which the autonomous
   * write keys off `key` and this field collapses into it.
   */
  provider: ResolvedProviderName;
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
  const reachNow = new Map<string, ResolvedProviderName>();
  for (const provider of discoverProviders(sessionConfig, env, detectCommand)) {
    const key = backendGateKey(
      representativeModelId(provider.name, sessionConfig),
      provider.name,
    );
    reachNow.set(key, provider.name);
  }
  for (const source of sources) {
    reachNow.set(backendGateKey(source.model, source.provider), source.provider);
  }
  return [...reachNow.entries()]
    .filter(([key]) => !confirmed.has(key))
    .map(([key, provider]) => ({ key, provider }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function resolveExcludedProviders(
  policy: ConfirmedDispatchPolicy | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Set<ResolvedProviderName> {
  const included = new Set(policy?.include ?? []);
  const excluded = new Set<ResolvedProviderName>(policy?.exclude ?? []);
  for (const name of RESOLVED_PROVIDER_NAMES) {
    if (included.has(name)) continue;
    if (isSelfSpawnBlocked(name, env)) excluded.add(name);
  }
  return excluded;
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
 * providers are still excluded locally by {@link resolveExcludedProviders}, which
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

function isConfirmedPoolEntry(value: unknown): value is ConfirmedPoolEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === "string" &&
    typeof obj.capability_tier === "string" &&
    typeof obj.excluded === "boolean"
  );
}

function isHostModelCostEntry(value: unknown): value is HostModelCostEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.model_id === "string" &&
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
    typeof obj.provider === "string" &&
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
    !obj.provider_pool.every(isConfirmedPoolEntry)
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
    provider_pool: obj.provider_pool as ConfirmedPoolEntry[],
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
  // Membership-checked, not just `typeof === "string"`: this field now decides
  // routing, so an unknown name must not type-assert its way into the filter.
  const exclude = parseProviderNameList(obj.exclude);
  const include = parseProviderNameList(obj.include);
  if (!exclude?.length && !include?.length) return undefined;
  return {
    ...(exclude?.length ? { exclude } : {}),
    ...(include?.length ? { include } : {}),
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
  } catch {
    // Absent (ENOENT) OR unreadable / invalid-JSON both degrade to the
    // never-block path — a missing or corrupt artifact is never an error here.
    return null;
  }
  // Malformed (wrong shape / version drift) → never-block.
  return parseSharedProviderConfirmation(raw);
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
  // Source pools (explicit sources[] + repair-proxy expansion) route by their confirmed
  // position keyed on the source's model id — the SAME model-keyed lookup a repair-proxy
  // dispatch pool resolves against (pool.model = the namespaced `provider/model`). An entry
  // without a model_id is display-only and contributes no dispatch position.
  for (const entry of confirmation.source_pool_cost_order ?? []) {
    if (
      entry.model_id &&
      Number.isFinite(entry.cost_order) &&
      entry.cost_order >= 0
    ) {
      positions.set(entry.model_id, entry.cost_order);
    }
  }
  return positions;
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
  const exclude = stringArray(obj.exclude) as
    | ResolvedProviderName[]
    | undefined;
  const include = stringArray(obj.include) as
    | ResolvedProviderName[]
    | undefined;
  const dispatchBias = clampDispatchBias(obj.dispatch_bias);
  const hostModels = Array.isArray(obj.host_models)
    ? obj.host_models
        .filter(
          (m): m is { model_id: string; tier?: unknown } =>
            m !== null &&
            typeof m === "object" &&
            typeof (m as { model_id?: unknown }).model_id === "string",
        )
        .map((m) => ({
          model_id: m.model_id,
          ...(typeof m.tier === "string"
            ? { tier: m.tier as CapabilityTier }
            : {}),
        }))
    : undefined;
  return {
    schema_version: PROVIDER_CONFIRMATION_INPUT_VERSION,
    ...(costOrder ? { cost_order: costOrder } : {}),
    ...(exclude ? { exclude } : {}),
    ...(include ? { include } : {}),
    ...(hostModels && hostModels.length > 0 ? { host_models: hostModels } : {}),
    ...(dispatchBias != null ? { dispatch_bias: dispatchBias } : {}),
  };
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
