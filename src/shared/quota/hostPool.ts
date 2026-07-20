import type { CapacityPool } from "./capacity.js";
import type { ResolvedProviderName, SessionConfig } from "../types/sessionConfig.js";
import type { HostConcurrencyLimit, QuotaStateEntry } from "./types.js";
import type { QuotaSource } from "./quotaSource.js";
import type { DiscoveredRateLimitsInput, HostModelRosterEntry } from "./scheduler.js";
import { quotaPoolKey } from "../providers/identity.js";
import { buildQuotaSource } from "./compositeQuotaSource.js";
import {
  HostSessionQuotaSource,
  type HostSessionEscalation,
} from "./hostSessionQuotaSource.js";
import { resolveHostActiveSubagentLimit } from "./hostLimits.js";
import { resolveHostModel } from "./limits.js";
import { readQuotaStateOrDegrade } from "./state.js";
import { buildHostModelPools } from "./apiPool.js";
import { compareTier } from "../dispatch/tierRank.js";

/**
 * The host-pool ASSEMBLY core — the single `(session, auditor identity) → host CapacityPool[]`
 * entry both draws call, so the two cannot drift on how they resolve the provider/model
 * identity, the quota key, the host concurrency limit, the capability window, the learned
 * quota entries, or the quota source.
 *
 * Before this module, audit (`buildDispatchPool`) and remediate (`buildHostPoolPreamble`)
 * each hand-assembled the identical eight steps in the identical order — including a
 * byte-identical quota-key derivation — while the ENGINE they both feed (`buildHostModelPools`,
 * `computeDispatchCapacity`, `computeDispatchAdmission`, `driveRolling`) was already single-
 * sourced. Driving was unified; assembly was forked. Remediate's own copy carried the argument
 * for this lift ("Both consumers were maintaining a byte-identical copy of this block; a change
 * to (say) the quota-key segment had to be made in both places") — applied within remediate and
 * stopped at the audit boundary.
 *
 * Per-mode variance is expressed as HOOKS, never a fork ([[dissolve-auditor-remediator-distinction]],
 * "one core, two draws"). It follows the `hostLimits.ts` pattern exactly — shared core, per-mode
 * constant:
 * - `providerName` — resolved by the caller's policy (audit: `resolveFreshSessionProviderName`;
 *   remediate: `resolveHostProviderName` + the defect-1 demote) and passed in.
 * - `envPrefix` — the per-mode env namespace (`AUDIT_CODE` / `REMEDIATE_CODE`), exactly as
 *   `hostLimits.ts` parameterizes it.
 * - `enrichDiscoveredLimits` — audit merges its queried + learned-cache limits over the
 *   capability window (`src/audit/quota/discoveredLimits.ts` is audit-local by design);
 *   remediate uses the capability entry alone and omits the hook.
 *
 * The caller layers its own draw on the returned pools: audit adds tier budgets, remediate
 * appends `buildSourcePools`. That layering is genuinely per-mode and stays with the caller.
 */

/** The resolved identity handed to {@link EnrichDiscoveredLimits} for each pool. */
export interface EnrichContext {
  /** This pool's quota key (per-rank `model_id` when a roster rank supplied one). */
  poolKey: string;
  /**
   * The preamble-resolved scalar host model NAME (null when genuinely unknown). Passed
   * so a caller whose enrichment queries a provider for limits can key that query on the
   * resolved model — the resolution happens HERE, so a caller that re-derived it would
   * reintroduce exactly the drift this core exists to remove.
   */
  hostModel: string | null;
  /** The roster rank this pool was built for; null for the scalar/absent handshake. */
  entry: HostModelRosterEntry | null;
}

/**
 * The per-tool enrichment of a pool's discovered limits, layered OVER the capability
 * window. Called once per pool. Audit merges its queried + learned-cache limits (the
 * capability handshake stays FIRST so it outranks them for context/output); remediate
 * omits the hook and uses the capability entry alone.
 */
export type EnrichDiscoveredLimits = (
  base: DiscoveredRateLimitsInput | null,
  context: EnrichContext,
) => Promise<DiscoveredRateLimitsInput | null> | DiscoveredRateLimitsInput | null;

export interface HostPoolPreambleInput {
  sessionConfig: SessionConfig;
  /**
   * The resolved host provider. Caller-resolved because the policy genuinely differs
   * (audit auto-detects a fresh-session provider; remediate may demote an in-process
   * primary to a source and key the host pool to the CONVERSATION host instead).
   */
  providerName: ResolvedProviderName;
  /** Explicit model override (a CLI flag); highest precedence. */
  explicitHostModel?: string | null;
  /**
   * The host's opaque model identity (descriptor `self.model_id`) — a quota-key segment
   * ONLY, never a window authority. Used when no real model NAME resolves.
   */
  hostModelId?: string | null;
  /** Per-mode env namespace for the model hint (`AUDIT_CODE` → `AUDIT_CODE_HOST_MODEL`). */
  envPrefix: string;
  /** Context passed to `readQuotaStateOrDegrade` for its degrade diagnostic. */
  quotaStateLabel: string;
  hostActiveSubagentLimit?: number | null;
  /** Context window the host reports for its dispatch model (handshake). */
  hostContextTokens?: number | null;
  /** Output cap the host reports for its dispatch model (handshake). */
  hostOutputTokens?: number | null;
  /** Ordered model roster; one pool per rank. Sorted most-capable-first here. */
  roster?: HostModelRosterEntry[] | null;
  env?: NodeJS.ProcessEnv;
  /**
   * A retained host-session source to thread through BOTH pool sizing and the
   * dispatcher's escalation hooks. Omit and one is constructed internally.
   */
  hostSession?: HostSessionQuotaSource;
  /** Routes a bounded account-wall escalation to the caller's friction chokepoint. */
  onEscalation?: (escalation: HostSessionEscalation) => void;
  enrichDiscoveredLimits?: EnrichDiscoveredLimits;
}

export interface HostPoolPreamble {
  providerName: ResolvedProviderName;
  hostModel: string | null;
  quotaModelKeySegment: string | null;
  quotaProviderKey: string;
  hostConcurrencyLimit: HostConcurrencyLimit | null;
  quotaEntries: Record<string, QuotaStateEntry>;
  quotaSource: QuotaSource;
  /** The retained host-session source this assembly owns (or the caller's, threaded through). */
  hostSession: HostSessionQuotaSource;
  /** One pool per roster rank (most capable first), or a single scalar/absent-handshake pool. */
  pools: CapacityPool[];
}

/**
 * Most-capable rank first, so the largest pending items land on the rank with the largest
 * window. Ordering comes from the single shared tier-rank authority (`compareTier`, negated
 * for descending) — no local {small,standard,deep} copy.
 *
 * Sorting HERE (rather than in one caller only) closes a real pre-lift drift: remediate sorted
 * its roster in the preamble, audit did not and sorted its POOLS later in `finalizeDispatchQuota`.
 * Audit's later sort stays correct and idempotent, and its budget layer is order-independent
 * (a per-rank map; the single-pool path has one element), so unifying on sorted-here is safe.
 */
function sortRosterMostCapableFirst(
  roster: HostModelRosterEntry[],
): HostModelRosterEntry[] {
  return [...roster].sort((a, b) => compareTier(b.rank, a.rank));
}

export async function buildHostPoolPreamble(
  input: HostPoolPreambleInput,
): Promise<HostPoolPreamble> {
  const { sessionConfig, providerName } = input;

  const hostModel = resolveHostModel({
    providerName,
    sessionConfig,
    explicitModel: input.explicitHostModel,
    ...(input.env ? { env: input.env } : {}),
    envVar: `${input.envPrefix}_HOST_MODEL`,
  });
  // Quota-key identity: the resolved model NAME when one exists, else the host's opaque
  // model id (a key segment ONLY — never a window authority), else null → `provider/*`.
  // Per-roster-rank `model_id` overrides this per pool below.
  const quotaModelKeySegment = hostModel ?? input.hostModelId ?? null;
  const quotaProviderKey = quotaPoolKey(providerName, quotaModelKeySegment);

  const roster = input.roster?.length ? sortRosterMostCapableFirst(input.roster) : null;

  const hostConcurrencyLimit = resolveHostActiveSubagentLimit({
    envPrefix: input.envPrefix,
    explicitLimit: input.hostActiveSubagentLimit,
    sessionConfig,
    ...(input.env ? { env: input.env } : {}),
  });

  const quotaEntries = (await readQuotaStateOrDegrade(input.quotaStateLabel)).entries;

  // PREPEND the host-session fixed-window source keyed on the host pool's own
  // (provider, model) key, so the operator's account-level session wall is a first-class
  // PRE-WALL source: graduated remaining_pct → LOW/CRITICAL throttle before a hard 429,
  // paused → cooldown. It gates on the exact key, passing through for every other pool,
  // so it never masks the proactive/learned sources.
  const hostSession =
    input.hostSession ??
    new HostSessionQuotaSource({
      providerModelKey: quotaProviderKey,
      ...(input.onEscalation ? { onEscalation: input.onEscalation } : {}),
    });
  const quotaSource = buildQuotaSource({ hostSession });

  // The capability handshake: the host reported its dispatch model's real context/output
  // window this session. Carried into the pool's discoveredLimits so the shared
  // discovered_capability rung sizes the budget to the real window instead of the
  // conservative floor. RPM/TPM stay null and fill from the queried/learned sources.
  const hostCapabilityLimits: DiscoveredRateLimitsInput | null =
    input.hostContextTokens != null || input.hostOutputTokens != null
      ? {
          context_tokens: input.hostContextTokens ?? null,
          output_tokens: input.hostOutputTokens ?? null,
        }
      : null;

  const pools = await buildHostModelPools({
    providerName,
    hostModel,
    hostConcurrencyLimit,
    quotaSource,
    quotaEntries,
    roster,
    resolve: async (entry) => {
      const poolKey = entry?.model_id
        ? quotaPoolKey(providerName, entry.model_id)
        : quotaProviderKey;
      // A roster rank reports its OWN window; the scalar/absent handshake falls back to
      // the single capability pair.
      const capability: DiscoveredRateLimitsInput | null = entry
        ? { context_tokens: entry.context_tokens, output_tokens: entry.output_tokens }
        : hostCapabilityLimits;
      const discoveredLimits = input.enrichDiscoveredLimits
        ? await input.enrichDiscoveredLimits(capability, {
            poolKey,
            hostModel,
            entry: entry ?? null,
          })
        : capability;
      return { poolKey, discoveredLimits };
    },
  });

  return {
    providerName,
    hostModel,
    quotaModelKeySegment,
    quotaProviderKey,
    hostConcurrencyLimit,
    quotaEntries,
    quotaSource,
    hostSession,
    pools,
  };
}
