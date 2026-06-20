import type { CapacityPool } from "./capacity.js";
import type { SessionConfig } from "../types/sessionConfig.js";
import type { QuotaStateEntry } from "./types.js";
import type { QuotaSource, QuotaProbeResult } from "./quotaSource.js";
import { probeQuotaSource } from "./quotaSource.js";
import { buildProviderModelKey } from "./scheduler.js";
import { hasConfiguredOpenAiCompatible } from "../providers/providerFactory.js";

/**
 * Surface a configured `openai-compatible` endpoint (NIM / vLLM / LM Studio / …) as
 * a confirmed CapacityPool — the always-available API pool both orchestrators spill
 * INTO under A-8's hybrid topology. Single-sourced so the pool's shape is identical
 * across the audit and remediate drivers (the spill topology can't drift between the
 * two): an independent API pool with no host concurrency budget
 * (`hostConcurrencyLimit: null` — it doesn't draw on the host subagent budget) and no
 * proactive capability handshake (`discoveredLimits: null`; concurrency is governed
 * by learned 429/RPM state). It carries its real-time quota probe (degraded → the raw
 * `quotaSignalDegraded` marker, never pre-folded). Returns null when no endpoint is
 * configured, or when openai-compatible IS the primary provider (no duplicate key).
 */
export async function buildConfiguredApiPool(params: {
  sessionConfig: SessionConfig;
  /** The run's primary provider — skip when it already IS openai-compatible. */
  primaryProviderName: string;
  quotaSource: QuotaSource;
  quotaEntries: Record<string, QuotaStateEntry>;
}): Promise<CapacityPool | null> {
  const { sessionConfig, primaryProviderName, quotaSource, quotaEntries } = params;
  if (primaryProviderName === "openai-compatible") return null;
  if (!hasConfiguredOpenAiCompatible(sessionConfig.openai_compatible)) return null;

  const apiModel = sessionConfig.openai_compatible?.model ?? null;
  const apiPoolKey = buildProviderModelKey("openai-compatible", apiModel);
  const apiProbe = await probeQuotaSource(quotaSource, apiPoolKey).catch(
    (): QuotaProbeResult => ({ snapshot: null, status: "degraded" }),
  );
  return {
    id: apiPoolKey,
    providerName: "openai-compatible",
    hostModel: apiModel,
    hostConcurrencyLimit: null,
    quotaStateEntry: quotaEntries[apiPoolKey] ?? null,
    discoveredLimits: null,
    quotaSourceSnapshot: apiProbe.snapshot,
    ...(apiProbe.status === "degraded" ? { quotaSignalDegraded: true } : {}),
  };
}
