export { resolveLimits, lookupKnownModel, classifyProvider } from "./limits.js";
export type { LimitResolutionResult, ResolveLimitsOptions, ProviderType } from "./limits.js";

export {
  detectHostActiveSubagentLimit,
  resolveHostActiveSubagentLimit,
} from "./hostLimits.js";

export {
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
} from "./state.js";

export { scheduleWave, buildProviderModelKey } from "./scheduler.js";
export type { ScheduleWaveOptions } from "./scheduler.js";

export { detectRateLimitError, computeCooldownUntil } from "./errorParsing.js";
export { acquireLock, releaseLock, withFileLock, FileLockTimeoutError } from "./fileLock.js";
export { runSlidingWindow } from "./slidingWindow.js";
export type { SlidingWindowResult } from "./slidingWindow.js";
export type { RateLimitDetectionResult } from "./errorParsing.js";

export { probeProvider } from "./probe.js";
export type { ProbeResult } from "./probe.js";

export type { QuotaSource, QuotaUsageSnapshot } from "./quotaSource.js";
export type { ErrorParser } from "./errorParsers/index.js";
export { GenericErrorParser, ClaudeCodeErrorParser, getErrorParserForProvider } from "./errorParsers/index.js";
export { LearnedQuotaSource } from "./learnedQuotaSource.js";
export { CompositeQuotaSource } from "./compositeQuotaSource.js";

export type {
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
} from "./types.js";
