import { buildQuotaSource } from "audit-tools/shared/quota/compositeQuotaSource";
import {
  quotaPoolKey,
  readQuotaStateOrDegrade,
  resolveLimits,
  resolveHostActiveSubagentLimit,
  getQuotaStatePath,
  lookupDiscoveredLimits,
} from "../quota/index.js";
import { buildDispatchPool } from "./dispatch/quotaPool.js";
import { resolveDispatchDriverIdentity } from "./prepareDispatchCommand.js";

export async function cmdQuota(argv: string[]): Promise<void> {
  // This command is a read-only PREVIEW of what `prepare-dispatch` builds, so it
  // resolves the driver through that entry point's resolver: same fail-closed load of
  // `session-config.json`, same provider, same host-model precedence. Resolving it here
  // instead is how the preview came to report a quota key the real pool never used.
  const { descriptor, sessionConfig, providerName, hostModel } =
    await resolveDispatchDriverIdentity(argv);
  const self = descriptor?.self ?? {};
  const providerModelKey = quotaPoolKey(providerName, hostModel);

  const { limits, source, confidence } = resolveLimits({ providerName, sessionConfig, hostModel });

  const quotaState = await readQuotaStateOrDegrade("quota command");
  const quotaStateEntry = quotaState.entries[providerModelKey] ?? null;
  const hostConcurrencyLimit = resolveHostActiveSubagentLimit({
    explicitLimit: self.max_active_subagents ?? null,
    sessionConfig,
  });

  const quotaSource = buildQuotaSource();
  const quotaSourceSnapshot = await quotaSource.queryCurrentUsage(providerModelKey).catch(() => null);
  const queryDiscoveredLimits = await lookupDiscoveredLimits(providerModelKey).catch(() => null);

  // Capacity preview reuses the same pool-resolution path real dispatch sizes
  // its partition with — parsing the capability-handshake flags so the preview
  // reflects the host's reported roster/window, not just cached/learned limits.
  // `queryLimits: undefined` (read-only — no live provider to probe) and this
  // command never calls finalizeDispatchQuota, so nothing is written to disk.
  const dispatchPool = await buildDispatchPool({
    sessionConfig,
    capabilityRanks: null,
    providerName,
    hostModel,
    queryLimits: undefined,
    hostActiveSubagentLimit: self.max_active_subagents ?? null,
    hostContextTokens: self.context_tokens ?? null,
    hostOutputTokens: self.output_tokens ?? null,
    hostModelRoster: self.roster ?? null,
    hostModelId: self.model_id ?? null,
  });

  console.log(
    JSON.stringify(
      {
        provider: providerName,
        model: hostModel,
        provider_model_key: providerModelKey,
        resolved_limits: limits,
        confidence,
        source,
        host_concurrency_limit: hostConcurrencyLimit,
        // Reactive backoff state — what the last 429 taught us. There is no
        // learned concurrency cap to report: concurrency is declared or absent.
        reactive_state: quotaStateEntry
          ? {
              cooldown_until: quotaStateEntry.cooldown_until,
              last_429_at: quotaStateEntry.last_429_at,
              consecutive_429_count: quotaStateEntry.consecutive_429_count ?? 0,
            }
          : null,
        quota_source_snapshot: quotaSourceSnapshot,
        discovered_limits: queryDiscoveredLimits,
        capacity_preview: {
          pools: dispatchPool.pools,
          context_budget_tokens: dispatchPool.contextBudgetTokens,
          tier_budgets: dispatchPool.tierBudgets,
        },
        quota_state_path: getQuotaStatePath(),
      },
      null,
      2,
    ),
  );
}
