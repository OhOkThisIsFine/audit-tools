// Types
export type {
  FileDispositionStatus,
  FileDispositionItem,
  FileDisposition,
} from "./types/disposition.js";
export type { RiskItem, RiskRegister } from "./types/risk.js";
export type {
  FlowConfidenceLevel,
  CriticalFlow,
  CriticalFlowManifest,
} from "./types/flows.js";
export { FLOW_CONFIDENCE_LEVELS } from "./types/flows.js";
export type {
  SurfaceKind,
  SurfaceRecord,
  SurfaceManifest,
} from "./types/surfaces.js";
export { SURFACE_KINDS } from "./types/surfaces.js";
export type {
  RunLedgerStatus,
  RunLedgerEntry,
  RunLedger,
} from "./types/runLedger.js";
export { RUN_LEDGER_STATUSES } from "./types/runLedger.js";
export type {
  GraphEdge,
  RouteEdge,
  GraphBundle,
} from "./types/graph.js";
export type { AccessDeclaration } from "./types/accessDeclaration.js";
export type {
  StepStatus,
  DispatchModelTier,
  DispatchModelHint,
} from "./types/stepContract.js";
export type {
  ProviderName,
  ResolvedProviderName,
  SessionUiMode,
  SubprocessTemplateConfig,
  ClaudeCodeConfig,
  OpenCodeConfig,
  VSCodeTaskConfig,
  BlockQuotaConfig,
  QuotaModelLimits,
  QuotaConfig,
  OpenTokenConfig,
  SessionConfig,
} from "./types/sessionConfig.js";
export {
  PROVIDER_NAMES,
  SESSION_UI_MODES,
  PROVIDER_SECTION_KEYS,
} from "./types/sessionConfig.js";

// Contracts
export { AUDITOR_REPORT_MARKER } from "./contracts.js";

// IO
export {
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
  appendNdjsonFile,
  readNdjsonFile,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  writeNdjsonFile,
  readOptionalTextFile,
  writeTextFile,
} from "./io/json.js";

// Validation
export type { ValidationSeverity, ValidationIssue } from "./validation/basic.js";
export {
  describeValue,
  isRecord,
  createValidationIssue,
  pushValidationIssue,
  prefixValidationIssues,
  formatValidationIssues,
  requireKeys,
} from "./validation/basic.js";

// Provider types
export type {
  WorkerProgress,
  LaunchFreshSessionInput,
  LaunchFreshSessionResult,
  ProviderRateLimits,
  FreshSessionProvider,
} from "./providers/types.js";

// Provider constants
export { LOCAL_SUBPROCESS_PROVIDER_NAME } from "./providers/constants.js";

// Quota
export type {
  LimitSource,
  LimitConfidence,
  HostConcurrencyLimitSource,
  HostConcurrencyLimit,
  ResolvedLimits,
  ConcurrencyBucket,
  QuotaStateEntry,
  QuotaState,
  WaveSchedule,
  BackoffState,
  ObservedWaveOutcome,
} from "./quota/types.js";
export type { QuotaSource, QuotaUsageSnapshot } from "./quota/quotaSource.js";
export {
  resolveLimits,
  lookupKnownModel,
  classifyProvider,
} from "./quota/limits.js";
export type {
  ProviderType,
  LimitResolutionResult,
  ResolveLimitsOptions,
} from "./quota/limits.js";
export {
  setQuotaStateDir,
  getQuotaStatePath,
  readQuotaState,
  writeQuotaState,
  computeMaxSafeConcurrency,
  recordWaveOutcome,
  decayWeight,
  applyDecayToEntry,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
  computeRampUpConcurrency,
} from "./quota/state.js";
export {
  detectRateLimitError,
  computeCooldownUntil,
} from "./quota/errorParsing.js";
export {
  detectHostActiveSubagentLimit,
  resolveHostActiveSubagentLimit,
} from "./quota/hostLimits.js";
export type { RateLimitDetectionResult } from "./quota/errorParsing.js";
export {
  acquireLock,
  releaseLock,
  withFileLock,
  FileLockTimeoutError,
} from "./quota/fileLock.js";
export { runSlidingWindow } from "./quota/slidingWindow.js";
export type { SlidingWindowResult } from "./quota/slidingWindow.js";
export { LearnedQuotaSource } from "./quota/learnedQuotaSource.js";
export { CompositeQuotaSource } from "./quota/compositeQuotaSource.js";
export type { ErrorParser } from "./quota/errorParsers/index.js";
export {
  GenericErrorParser,
  ClaudeCodeErrorParser,
  getErrorParserForProvider,
} from "./quota/errorParsers/index.js";
