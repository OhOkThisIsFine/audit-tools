import { DEFAULT_EMPIRICAL_HALF_LIFE_HOURS } from "audit-tools/shared";
import type { SessionConfig } from "audit-tools/shared";
import { buildQuotaSource } from "audit-tools/shared/quota/compositeQuotaSource";
import { resolveFreshSessionProviderName } from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import {
  buildProviderModelKey,
  readQuotaStateOrDegrade,
  resolveLimits,
  resolveHostActiveSubagentLimit,
  computeMaxSafeConcurrency,
  getQuotaStatePath,
  lookupDiscoveredLimits,
} from "../quota/index.js";
import { buildDispatchPool } from "./dispatch/quotaPool.js";
import {
  getArtifactsDir,
  getExplicitProvider,
  getHostMaxActiveSubagents,
  getHostModel,
  getHostContextTokens,
  getHostOutputTokens,
  getHostModelRoster,
  getHostModelId,
} from "./args.js";

export async function cmdQuota(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  let sessionConfig: SessionConfig;
  try {
    sessionConfig = await loadSessionConfig(artifactsDir);
  } catch (e) {
    process.stderr.write(
      `[quota] session-config.json is invalid — using defaults. Error: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    sessionConfig = {} as SessionConfig;
  }
  const explicitProvider = getExplicitProvider(argv);
  const hostModel = getHostModel(argv);
  const providerName = resolveFreshSessionProviderName(
    explicitProvider ?? (sessionConfig.provider === undefined ? "auto" : undefined),
    sessionConfig,
  );
  const providerModelKey = buildProviderModelKey(providerName, hostModel);

  const { limits, source, confidence } = resolveLimits({ providerName, sessionConfig, hostModel });

  const quotaState = await readQuotaStateOrDegrade("quota command");
  const quotaStateEntry = quotaState.entries[providerModelKey] ?? null;
  const halfLifeHours =
    sessionConfig.quota?.empirical_half_life_hours ??
    DEFAULT_EMPIRICAL_HALF_LIFE_HOURS;
  const hostConcurrencyLimit = resolveHostActiveSubagentLimit({
    explicitLimit: getHostMaxActiveSubagents(argv),
    sessionConfig,
  });

  const quotaSource = buildQuotaSource({ halfLifeHours });
  const quotaSourceSnapshot = await quotaSource.queryCurrentUsage(providerModelKey).catch(() => null);
  const queryDiscoveredLimits = await lookupDiscoveredLimits(providerModelKey).catch(() => null);

  // Capacity preview reuses the same pool-resolution path real dispatch sizes
  // its partition with — parsing the capability-handshake flags so the preview
  // reflects the host's reported roster/window, not just cached/learned limits.
  // `queryLimits: undefined` (read-only — no live provider to probe) and this
  // command never calls finalizeDispatchQuota, so nothing is written to disk.
  const dispatchPool = await buildDispatchPool({
    sessionConfig,
    providerName,
    hostModel,
    queryLimits: undefined,
    hostActiveSubagentLimit: getHostMaxActiveSubagents(argv),
    hostContextTokens: getHostContextTokens(argv),
    hostOutputTokens: getHostOutputTokens(argv),
    hostModelRoster: getHostModelRoster(argv),
    hostModelId: getHostModelId(argv),
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
        learned_caps: quotaStateEntry
          ? {
              max_safe_concurrency: computeMaxSafeConcurrency(quotaStateEntry, halfLifeHours),
              cooldown_until: quotaStateEntry.cooldown_until,
              last_429_at: quotaStateEntry.last_429_at,
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
