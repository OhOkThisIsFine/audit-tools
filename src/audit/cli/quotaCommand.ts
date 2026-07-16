import type { SessionConfig } from "audit-tools/shared";
import { buildQuotaSource } from "audit-tools/shared/quota/compositeQuotaSource";
import { resolveFreshSessionProviderName } from "../providers/index.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import {
  buildProviderModelKey,
  readQuotaStateOrDegrade,
  resolveLimits,
  resolveHostActiveSubagentLimit,
  getQuotaStatePath,
  lookupDiscoveredLimits,
} from "../quota/index.js";
import { buildDispatchPool } from "./dispatch/quotaPool.js";
import {
  getArtifactsDir,
  getAuditorDescriptor,
  getExplicitProvider,
  getHostModel,
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
  // G1: driver handshake scalars come off the single `--auditor <json>` descriptor.
  const self = getAuditorDescriptor(argv)?.self ?? {};
  const providerName = resolveFreshSessionProviderName(
    explicitProvider ?? (sessionConfig.provider === undefined ? "auto" : undefined),
    sessionConfig,
  );
  const providerModelKey = buildProviderModelKey(providerName, hostModel);

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
