import type {
  ResolvedLimits as _ResolvedLimits,
  LimitConfidence as _LimitConfidence,
  LimitSource as _LimitSource,
  HostConcurrencyLimit as _HostConcurrencyLimit,
  QuotaUsageSnapshot as _QuotaUsageSnapshot,
  BackoffState as _BackoffState,
} from "@audit-tools/shared";

// Re-exported from @audit-tools/shared
export {
  resolveLimits,
  lookupKnownModel,
  classifyProvider,
  readQuotaState,
  writeQuotaState,
  computeMaxSafeConcurrency,
  recordWaveOutcome,
  getQuotaStatePath,
  decayWeight,
  applyDecayToEntry,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
  computeRampUpConcurrency,
  setQuotaStateDir,
  detectRateLimitError,
  computeCooldownUntil,
  acquireLock,
  releaseLock,
  withFileLock,
  FileLockTimeoutError,
  runSlidingWindow,
  LearnedQuotaSource,
  CompositeQuotaSource,
  GenericErrorParser,
  ClaudeCodeErrorParser,
  getErrorParserForProvider,
} from "@audit-tools/shared";

export type {
  LimitResolutionResult,
  ResolveLimitsOptions,
  ProviderType,
  ResolvedLimits,
  LimitSource,
  LimitConfidence,
  HostConcurrencyLimit,
  HostConcurrencyLimitSource,
  QuotaState,
  QuotaStateEntry,
  ConcurrencyBucket,
  WaveSchedule,
  BackoffState,
  ObservedWaveOutcome,
  RateLimitDetectionResult,
  SlidingWindowResult,
  QuotaSource,
  QuotaUsageSnapshot,
  ErrorParser,
} from "@audit-tools/shared";

// Wave scheduler now lives in @audit-tools/shared (single source of truth for
// both orchestrators). Auditor passes its discovered-limits via the structural
// DiscoveredRateLimitsInput the shared scheduler accepts.
export { scheduleWave, buildProviderModelKey, resolveHostModel } from "@audit-tools/shared";
export type { ScheduleWaveOptions } from "@audit-tools/shared";

// Auditor-specific: discovered limits, header extraction
export {
  detectHostActiveSubagentLimit,
  resolveHostActiveSubagentLimit,
} from "./hostLimits.js";

export {
  lookupDiscoveredLimits,
  updateDiscoveredLimits,
  mergeDiscoveredLimits,
  readDiscoveredLimitsCache,
  writeDiscoveredLimitsCache,
} from "./discoveredLimits.js";
export type { DiscoveredRateLimits, DiscoveredLimitsCache, DiscoveredLimitsCacheEntry } from "./discoveredLimits.js";

export { extractRateLimitHeaders } from "./headerExtraction.js";
export type { ExtractedRateLimits } from "./headerExtraction.js";

export type { HeaderExtractor } from "./headerExtractors/index.js";
export { GenericHeaderExtractor, ClaudeCodeHeaderExtractor, getHeaderExtractorForProvider } from "./headerExtractors/index.js";

// Auditor-only type (not in shared)
export interface DispatchQuota {
  contract_version: "audit-code-dispatch-quota/v1alpha1" | "audit-code-dispatch-quota/v1alpha2";
  run_id: string;
  model: string | null;
  resolved_limits: _ResolvedLimits;
  confidence: _LimitConfidence;
  source: _LimitSource;
  host_concurrency_limit: _HostConcurrencyLimit | null;
  wave_size: number;
  estimated_wave_tokens: number;
  cooldown_until: string | null;
  quota_source_snapshot?: _QuotaUsageSnapshot | null;
  backoff_state?: _BackoffState | null;
}
