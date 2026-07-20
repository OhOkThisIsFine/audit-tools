// Re-exported from audit-tools/shared
export {
  resolveLimits,
  classifyProvider,
  readQuotaState,
  readQuotaStateOrDegrade,
  writeQuotaState,
  recordWaveOutcome,
  getQuotaStatePath,
  computeBackoffCooldownMs,
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
  summarizeDispatchCapacityPools,
} from "audit-tools/shared";

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
  WaveSchedule,
  BackoffState,
  ObservedWaveOutcome,
  RateLimitDetectionResult,
  SlidingWindowResult,
  QuotaSource,
  QuotaUsageSnapshot,
  ErrorParser,
  WaveBindingCap,
  DispatchCapacityPoolSummary,
} from "audit-tools/shared";

// Wave scheduler now lives in audit-tools/shared (single source of truth for
// both orchestrators). Auditor passes its discovered-limits via the structural
// DiscoveredRateLimitsInput the shared scheduler accepts.
export { scheduleWave, quotaPoolKey, resolveHostModel } from "audit-tools/shared";
export type { ScheduleWaveOptions } from "audit-tools/shared";

// Capacity model: the JIT, multi-pool-capable layer both orchestrators size
// dispatch with. Single host pool today; heterogeneous provider pools slot in
// without changing call sites.
export { computeDispatchCapacity } from "audit-tools/shared";
export type {
  CapacityPool,
  PoolDispatchAllocation,
  DispatchCapacity,
} from "audit-tools/shared";

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

// H5: the dispatch-quota contract is the SHARED one (dispatchQuotaContract.ts) —
// these are thin aliases, never a second shape. The old audit-only
// DISPATCH_QUOTA_V1ALPHA3 zod contract is deleted; both draws emit and validate
// dispatch-quota/v1.
export {
  DISPATCH_QUOTA_CONTRACT_VERSION,
  DispatchQuotaContractSchema as DispatchQuotaSchema,
} from "audit-tools/shared";
export type { DispatchQuotaContract as DispatchQuota } from "audit-tools/shared";
