/**
 * DC-2 — shared, session-scoped provider confirmation (Gate-0).
 *
 * The design wants ONE provider confirmation spanning an audit→remediate run:
 * the first tool to run writes the confirmed provider pool to a SHARED artifact
 * at `<root>/.audit-tools/provider-confirmation.json` (NOT the per-tool audit
 * artifacts dir); the second tool reads and honors it unless the roster has
 * since changed. "Session" = the shared `.audit-tools` dir for that repo+run, so
 * no new identity scheme is needed.
 *
 * Two invariants are in tension and are reconciled here by the CE-012 third
 * state:
 *   - INV-DC1-6 (never-block): remediate run standalone with no prior audit must
 *     resolve its provider independently, exactly as today — absence of the
 *     artifact is NOT an error.
 *   - INV-DC2-3 (roster-stale-re-confirm): a confirmation whose discovered roster
 *     no longer matches the current one must NOT be silently honored (it could
 *     pin a provider that has since disappeared) — it must re-confirm.
 * A single `null` return cannot carry both meanings (CE-012). So the accessor
 * returns a THREE-valued result: `null` for absent/malformed (never-block),
 * `{ status: 'confirmed' }` for a fresh honor, and the DISTINCT
 * `{ status: 'reconfirm' }` for roster-stale — so honoring INV-DC2-3 no longer
 * contradicts INV-DC1-6.
 *
 * CE-003 (lockless read races the writer rename): writes go through the shared
 * atomic writer (temp + atomic rename) under `withFileLock`, so a lockless
 * reader always observes either the complete old file or the complete new file —
 * never a torn intermediate.
 *
 * PB-1 (opencode opt-in): the roster is derived from `discoverProviders`, which
 * already withholds a bare-PATH opencode unless it is explicitly configured, so
 * the shared confirmation inherits that opt-in for free.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import { auditToolsDir } from "../io/auditToolsPaths.js";
import { readJsonFile, writeJsonFile } from "../io/json.js";
import { withFileLock } from "../quota/fileLock.js";
import type { RunLogger } from "../observability/runLog.js";
import {
  discoverProviders,
  annotateConfirmedPool,
  type CapabilityTier,
} from "./providerConfirmation.js";
import { resolveConfirmedCostPositions } from "../dispatch/costRank.js";
import type {
  ConfirmedPoolEntry,
  HostModelCostEntry,
  ProviderConfirmationInput,
} from "../types/providerConfirmation.js";
import { PROVIDER_CONFIRMATION_INPUT_VERSION } from "../types/providerConfirmation.js";

// ---------------------------------------------------------------------------
// Version + on-disk location
// ---------------------------------------------------------------------------

/**
 * Schema version for the shared confirmation artifact. Bumped independently of
 * the per-tool seam contract (PROVIDER_CONFIRMATION_RESULT_VERSION) — this is
 * the cross-tool session artifact, a distinct shape that also carries the
 * roster snapshot used for staleness.
 */
export const SHARED_PROVIDER_CONFIRMATION_VERSION = "1.0.0" as const;

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
 * The shared session-level provider confirmation. Single-sourced so both
 * orchestrators read/write exactly the same shape.
 *
 * `roster` is the sorted snapshot of the provider names discovered at write
 * time. Staleness is "the current discovered roster differs from this snapshot"
 * — a provider appearing or disappearing forces a re-confirm.
 */
export interface SharedProviderConfirmation {
  /** Must equal SHARED_PROVIDER_CONFIRMATION_VERSION. */
  schema_version: typeof SHARED_PROVIDER_CONFIRMATION_VERSION;
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
   * Sorted snapshot of the provider NAMES discovered when this was written.
   * Compared against the current discovered roster to detect staleness.
   */
  roster: ResolvedProviderName[];
}

/**
 * Outcome of reading the shared confirmation. THREE-valued (CE-012):
 *   - `null`                       absent or malformed → never-block (INV-DC1-6)
 *   - `{ status: 'confirmed' }`    present + roster matches → honor it
 *   - `{ status: 'reconfirm' }`    present + roster changed → re-confirm (INV-DC2-3)
 */
export type SharedProviderConfirmationRead =
  | { status: "confirmed"; confirmation: SharedProviderConfirmation }
  | {
      status: "reconfirm";
      confirmation: SharedProviderConfirmation;
      reason: string;
    }
  | null;

// ---------------------------------------------------------------------------
// Roster derivation
// ---------------------------------------------------------------------------

/**
 * The current discovered provider roster: the sorted set of provider names
 * `discoverProviders` surfaces for this session config + environment. PB-1's
 * opencode opt-in is inherited from `discoverProviders` (a bare-PATH opencode is
 * not surfaced unless explicitly configured), so it never spuriously perturbs
 * the roster.
 */
export function currentProviderRoster(
  sessionConfig: SessionConfig,
  env: NodeJS.ProcessEnv = process.env,
  detectCommand?: (command: string) => boolean,
): ResolvedProviderName[] {
  const names = discoverProviders(sessionConfig, env, detectCommand).map(
    (p) => p.name,
  );
  return sortRoster(names);
}

function sortRoster(names: ResolvedProviderName[]): ResolvedProviderName[] {
  // Deduplicate + sort so the snapshot is order-insensitive and comparison is a
  // plain stringified equality.
  return [...new Set(names)].sort();
}

function rostersEqual(
  a: readonly ResolvedProviderName[],
  b: readonly ResolvedProviderName[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build a fresh shared confirmation from auto-discovery. Guarantees the
 * always-available `local-subprocess` fallback is present in the pool (it blocks
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
 * exclusion (the host still always retains the local-subprocess fallback).
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
): SharedProviderConfirmation {
  const discovered = discoverProviders(sessionConfig, env, detectCommand);
  const excludeSet = new Set<ResolvedProviderName>(exclude);
  const includeSet = new Set<ResolvedProviderName>(include);

  const pool: ConfirmedPoolEntry[] = [];

  // Always include local-subprocess as a fallback — it's always available and is
  // never surfaced by PATH discovery (it blocks auto-dispatch by design).
  if (!discovered.some((p) => p.name === "local-subprocess")) {
    pool.push({
      name: "local-subprocess",
      capability_tier: "unknown" satisfies CapabilityTier,
      excluded: excludeSet.has("local-subprocess"),
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
  const annotated = annotateConfirmedPool(pool, sessionConfig, input);
  return {
    schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
    session_level: true,
    confirmed_at: new Date().toISOString(),
    provider_pool: annotated.provider_pool,
    ...(annotated.host_model_cost_order.length > 0
      ? { host_model_cost_order: annotated.host_model_cost_order }
      : {}),
    roster: sortRoster(discovered.map((p) => p.name)),
  };
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

function isResolvedProviderNameArray(
  value: unknown,
): value is ResolvedProviderName[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

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
  if (!isResolvedProviderNameArray(obj.roster)) return null;
  // host_model_cost_order is optional + additive; a malformed value degrades to
  // absent (the field never blocks parsing — INV-DC1-6 never-block spirit).
  const hostModels =
    Array.isArray(obj.host_model_cost_order) &&
    obj.host_model_cost_order.every(isHostModelCostEntry)
      ? (obj.host_model_cost_order as HostModelCostEntry[])
      : undefined;
  return {
    schema_version: SHARED_PROVIDER_CONFIRMATION_VERSION,
    session_level: true,
    confirmed_at: obj.confirmed_at,
    provider_pool: obj.provider_pool as ConfirmedPoolEntry[],
    ...(hostModels && hostModels.length > 0
      ? { host_model_cost_order: hostModels }
      : {}),
    roster: obj.roster,
  };
}

// ---------------------------------------------------------------------------
// Read (remediate gains this)
// ---------------------------------------------------------------------------

/**
 * Read + interpret the shared confirmation for `root`. THREE-valued (CE-012):
 *
 *   - returns `null` when the artifact is ABSENT or MALFORMED — the caller then
 *     resolves its provider independently, exactly as today (INV-DC1-6
 *     never-block). Absence is the standalone-remediate case and is not an error.
 *   - returns `{ status: 'confirmed', confirmation }` when the artifact is valid
 *     AND the stamped roster still matches the currently-discovered roster — the
 *     caller honors the recorded pool.
 *   - returns `{ status: 'reconfirm', confirmation, reason }` when the artifact
 *     is valid but the roster has CHANGED since it was written (a provider
 *     appeared or disappeared) — a DISTINCT signal so the caller re-confirms
 *     rather than pinning a stale pool (INV-DC2-3). This is the CE-012 third
 *     state that keeps INV-DC2-3 from collapsing into the never-block `null`.
 *
 * Never throws: a read/parse failure is treated as absent/malformed → `null`.
 * The read is lockless (no lock needed: the writer's atomic rename guarantees a
 * complete file either way — CE-003) and so cannot deadlock against a writer.
 */
export async function readSharedProviderConfirmation(
  root: string,
  sessionConfig: SessionConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SharedProviderConfirmationRead> {
  const path = sharedProviderConfirmationPath(root);

  let raw: unknown;
  try {
    raw = await readJsonFile<unknown>(path);
  } catch {
    // Absent (ENOENT) OR unreadable / invalid-JSON both degrade to the
    // never-block path — a missing or corrupt artifact is never an error here.
    return null;
  }

  const confirmation = parseSharedProviderConfirmation(raw);
  if (confirmation === null) {
    // Malformed (wrong shape / version drift) → never-block.
    return null;
  }

  const current = currentProviderRoster(sessionConfig, env);
  if (!rostersEqual(confirmation.roster, current)) {
    return {
      status: "reconfirm",
      confirmation,
      reason:
        `discovered provider roster changed since confirmation ` +
        `(was [${confirmation.roster.join(", ")}], now [${current.join(", ")}])`,
    };
  }

  return { status: "confirmed", confirmation };
}

/**
 * Read the operator-confirmed cost ordering (rung 1 of costRank; see
 * spec/cost-first-routing.md) from the shared Gate-0 confirmation as a model-keyed
 * `Map<model_id, cost_order>` for the dispatch build sites. Single-sourced so audit
 * and remediate honor it identically. Best-effort and never throws: an absent
 * `root`, a missing/malformed confirmation, or a roster that has since changed
 * (`reconfirm`) all yield an empty map — dispatch then falls to real price then
 * tier. Only a `confirmed` (roster-fresh) confirmation contributes positions.
 */
export async function readConfirmedCostPositions(
  root: string | undefined,
  sessionConfig: SessionConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, number>> {
  if (!root) return new Map();
  const read = await readSharedProviderConfirmation(root, sessionConfig, env);
  if (!read || read.status !== "confirmed") return new Map();
  // Provider-pool positions (configured models) PLUS any host-native tiers the
  // operator confirmed at Gate-0 (follow-up c). Both are model-keyed; a host tier
  // and a configured pool thread to dispatch identically. Host entries are already
  // in the single unified cost order, so a plain merge preserves the total order.
  const positions = resolveConfirmedCostPositions(read.confirmation.provider_pool);
  for (const entry of read.confirmation.host_model_cost_order ?? []) {
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
