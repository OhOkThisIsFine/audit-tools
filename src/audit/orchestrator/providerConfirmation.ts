/**
 * audit-code Gate-0 provider confirmation consumer.
 *
 * Wraps the audit-tools/shared provider-discovery helpers and produces a
 * ProviderConfirmationResult conforming to the pinned seam contract (N-X06).
 */

import type { SessionConfig } from "audit-tools/shared";
import {
  discoverProviders,
  annotateConfirmedPool,
  PROVIDER_CONFIRMATION_RESULT_VERSION,
} from "audit-tools/shared";
import type {
  ProviderConfirmationResult,
  ConfirmedPoolEntry,
  ProviderConfirmationInput,
} from "audit-tools/shared";

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
 * @param input         - Operator's Gate-0 submission (interactive path): its
 *   `cost_order` overrides the suggested ordering on the per-tool pool so the
 *   seam artifact reflects the operator's ordering. Dispatch reads the SHARED
 *   confirmation, so this only keeps the per-tool file consistent. Omit headless.
 */
export function confirmProviders(
  sessionConfig: SessionConfig,
  env: NodeJS.ProcessEnv = process.env,
  exclude: string[] = [],
  input?: ProviderConfirmationInput,
): ProviderConfirmationResult {
  const discovered = discoverProviders(sessionConfig, env);
  const excludeSet = new Set<string>(exclude);

  const pool: ConfirmedPoolEntry[] = [];

  // Always include worker-command as a fallback — it's always available.
  const hasWorkerCommand = discovered.some((p) => p.name === "worker-command");
  if (!hasWorkerCommand) {
    pool.push({
      name: "worker-command",
      capability_tier: "unknown",
      excluded: excludeSet.has("worker-command"),
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

  // COR-108468ae: the dead-code second guard below was removed — worker-command
  // is unconditionally added before the loop when not discovered, so this check
  // was always a no-op (the first block already guarantees presence).

  return {
    schema_version: PROVIDER_CONFIRMATION_RESULT_VERSION,
    confirmed_at: new Date().toISOString(),
    // Cost-first routing: annotate each entry with its representative model price
    // + cost_order (spec/cost-first-routing.md). Read at dispatch as rung 1 of
    // costRank. Uses the real sessionConfig so a configured API/CLI model is
    // priceable here; an operator `input.cost_order` overrides the suggestion.
    provider_pool: annotateConfirmedPool(pool, sessionConfig, input).provider_pool,
    session_level: true,
  };
}
