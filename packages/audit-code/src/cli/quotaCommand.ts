import { DEFAULT_EMPIRICAL_HALF_LIFE_HOURS } from "@audit-tools/shared";
import type { SessionConfig } from "@audit-tools/shared";
import { buildQuotaSource } from "@audit-tools/shared/quota/compositeQuotaSource";
import { resolveFreshSessionProviderName } from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import {
  scheduleWave,
  buildProviderModelKey,
  readQuotaState,
  resolveLimits,
  resolveHostActiveSubagentLimit,
  computeMaxSafeConcurrency,
  getQuotaStatePath,
  lookupDiscoveredLimits,
} from "../quota/index.js";
import {
  getArtifactsDir,
  getExplicitProvider,
  getFlag,
  getHostMaxActiveSubagents,
  getHostModel,
} from "./args.js";

export async function cmdQuota(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const sessionConfig = await loadSessionConfig(artifactsDir).catch(() => ({} as SessionConfig));
  const explicitProvider = getExplicitProvider(argv);
  const hostModel = getHostModel(argv);
  const providerName = resolveFreshSessionProviderName(explicitProvider, sessionConfig);
  const providerModelKey = buildProviderModelKey(providerName, hostModel);

  const { limits, source, confidence } = resolveLimits({ providerName, sessionConfig, hostModel });

  const quotaState = await readQuotaState().catch((): { version: 2; entries: Record<string, never> } => ({ version: 2, entries: {} }));
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

  const waveSchedule = scheduleWave({
    providerName,
    sessionConfig,
    hostModel,
    requestedConcurrency: sessionConfig.parallel_workers ?? 1,
    quotaStateEntry,
    hostConcurrencyLimit,
    quotaSourceSnapshot,
    discoveredLimits: queryDiscoveredLimits,
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
        wave_schedule: waveSchedule,
        quota_state_path: getQuotaStatePath(),
      },
      null,
      2,
    ),
  );
}
