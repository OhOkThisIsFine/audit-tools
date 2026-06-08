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
  summarizeDispatchCapacityPools,
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
  WaveBindingCap,
  DispatchCapacityPoolSummary,
} from "@audit-tools/shared";

// Wave scheduler now lives in @audit-tools/shared (single source of truth for
// both orchestrators). This also gives the remediator the first-contact
// concurrency cap and host-reported-capacity handling it previously lacked.
export { scheduleWave, buildProviderModelKey } from "@audit-tools/shared";
export type { ScheduleWaveOptions } from "@audit-tools/shared";

// Capacity model: the JIT, multi-pool-capable layer both orchestrators size
// dispatch with. Single host pool today; provider pools slot in later.
export { computeDispatchCapacity } from "@audit-tools/shared";
export type {
  CapacityPool,
  PoolDispatchAllocation,
  DispatchCapacity,
} from "@audit-tools/shared";

// Remediator-specific: hostLimits
export {
  detectHostActiveSubagentLimit,
  resolveHostActiveSubagentLimit,
} from "./hostLimits.js";
