/**
 * audit-code Gate-0 provider confirmation consumer.
 *
 * Wraps the audit-tools/shared provider-discovery helpers and produces a
 * ProviderConfirmationResult conforming to the pinned seam contract (N-X06).
 */

import type { SessionConfig } from "audit-tools/shared";
import {
  discoverProviders,
  annotateConfirmedPoolCost,
  PROVIDER_CONFIRMATION_RESULT_VERSION,
} from "audit-tools/shared";
import type { ProviderConfirmationResult, ConfirmedPoolEntry } from "audit-tools/shared";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover and confirm the provider pool for a new audit run.
 *
 * Uses auto-resolution only — no interactive gate at this layer. The
 * conversation-first flow handles the interactive Gate-0 prompt; this function
 * supplies the deterministic pool it needs as input.
 *
 * @param sessionConfig - Current session config; may be an empty `{}`.
 * @param env           - Process environment snapshot; defaults to `process.env`.
 * @param exclude       - Provider names to pre-exclude (e.g. user-supplied from a prior gate).
 */
export function confirmProviders(
  sessionConfig: SessionConfig,
  env: NodeJS.ProcessEnv = process.env,
  exclude: string[] = [],
): ProviderConfirmationResult {
  const discovered = discoverProviders(sessionConfig, env);
  const excludeSet = new Set<string>(exclude);

  const pool: ConfirmedPoolEntry[] = [];

  // Always include local-subprocess as a fallback — it's always available.
  const hasLocalSubprocess = discovered.some((p) => p.name === "local-subprocess");
  if (!hasLocalSubprocess) {
    pool.push({
      name: "local-subprocess",
      capability_tier: "unknown",
      excluded: excludeSet.has("local-subprocess"),
      reason: "always-available fallback; no PATH detection required",
    });
  }

  for (const provider of discovered) {
    pool.push({
      name: provider.name,
      capability_tier: provider.capabilityTier,
      excluded: excludeSet.has(provider.name),
      reason: provider.reason,
    });
  }

  // COR-108468ae: the dead-code second guard below was removed — local-subprocess
  // is unconditionally added before the loop when not discovered, so this check
  // was always a no-op (the first block already guarantees presence).

  return {
    schema_version: PROVIDER_CONFIRMATION_RESULT_VERSION,
    confirmed_at: new Date().toISOString(),
    // Cost-first routing: annotate each entry with its representative model price
    // + a suggested cost_order (spec/cost-first-routing.md). Read at dispatch as
    // rung 1 of costRank. Uses the real sessionConfig so a configured API/CLI model
    // is priceable here; host-native tiers are priced deterministically at dispatch.
    provider_pool: annotateConfirmedPoolCost(pool, sessionConfig),
    session_level: true,
  };
}
