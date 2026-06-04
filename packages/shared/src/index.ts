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
  FindingSeverity,
  FindingConfidence,
  FindingLocation,
  Finding,
  WorkBlock,
  FindingTheme,
  SynthesisNarrative,
  AuditFindingsSummary,
  AuditFindingsReport,
} from "./types/finding.js";
export type {
  RemediationOutcomeStatus,
  RemediationOutcome,
  RemediationOutcomesReport,
} from "./types/remediationOutcome.js";
// Canonical lens vocabulary + the runtime validation Sets derived from it.
export type { Lens } from "./types/lens.js";
export {
  LENSES,
  VALID_LENSES,
  isLens,
  SEVERITIES,
  VALID_SEVERITIES,
  CONFIDENCES,
  VALID_CONFIDENCES,
} from "./types/lens.js";
export type { RepoConventions } from "./tooling/repoConventions.js";
export {
  detectRepoConventions,
  formatRepoConventions,
} from "./tooling/repoConventions.js";
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
  CodexConfig,
  OpenCodeConfig,
  VSCodeTaskConfig,
  AntigravityConfig,
  BlockQuotaConfig,
  QuotaModelLimits,
  QuotaConfig,
  OpenTokenConfig,
  ObservabilityConfig,
  SynthesisConfig,
  GraphConfig,
  DispatchConfig,
  DesignReviewConfig,
  AnalyzerSetting,
  SessionConfig,
} from "./types/sessionConfig.js";
export {
  PROVIDER_NAMES,
  SESSION_UI_MODES,
  PROVIDER_SECTION_KEYS,
  ANALYZER_SETTINGS,
} from "./types/sessionConfig.js";

// Contracts
export { AUDITOR_REPORT_MARKER } from "./contracts.js";

// Tokens
export type { ModelTokenLimits } from "./tokens.js";
export {
  KNOWN_MODEL_LIMITS,
  lookupModelLimits,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  BLOCK_SAFETY_MARGIN,
  BYTES_PER_TOKEN,
  ESTIMATED_TOKENS_PER_LINE,
  estimateTokensFromBytes,
  resolveContextBudget,
} from "./tokens.js";

// Tooling: command execution
export type { RunTrackedOptions, RunTrackedResult } from "./tooling/exec.js";
export {
  runTracked,
  resolveExecArgv,
  quoteForCmd,
  shellQuote,
  platformCommand,
  quoteForOpenTokenCmd,
  wrapForOpenToken,
} from "./tooling/exec.js";

// Tooling: project command discovery
export type { ProjectCommands } from "./tooling/testCommand.js";
export { discoverProjectCommands } from "./tooling/testCommand.js";

// Tooling: optional analyzer dependency resolution
export type {
  AnalyzerDepVia,
  ResolvedAnalyzerDep,
  ResolveAnalyzerDepOptions,
  InstallToCacheOptions,
  InstallToCacheResult,
} from "./tooling/analyzerDeps.js";
export {
  analyzerCacheRoot,
  parseAnalyzerSpec,
  resolveAnalyzerDep,
  installToCache,
} from "./tooling/analyzerDeps.js";

// Git helpers
export {
  isGitRepo,
  gitRefExists,
  changedFiles,
  fileCommits,
  stagedAndUntracked,
} from "./git.js";

// Observability
export type { RunLogEvent, RunLoggerOptions } from "./observability/runLog.js";
export { RunLogger } from "./observability/runLog.js";

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
export {
  LOCAL_SUBPROCESS_PROVIDER_NAME,
  CODEX_PROVIDER_NAME,
  ANTIGRAVITY_PROVIDER_NAME,
} from "./providers/constants.js";

// Provider command runner (single source of truth for both orchestrators)
export { spawnLoggedCommand } from "./providers/spawnLoggedCommand.js";
export type { SpawnLoggedCommandOptions } from "./providers/spawnLoggedCommand.js";

// Provider launch helpers (shared so both orchestrators stay in lockstep)
export type {
  WorkerTaskTimeout,
  WorkerTaskWithCommand,
} from "./providers/workerTaskLaunch.js";
export {
  resolveWorkerTaskTimeoutMs,
  applyWorkerTaskLaunchSettings,
} from "./providers/workerTaskLaunch.js";
export { resolveOpenCodeSpawnCommand } from "./providers/opencodeLaunch.js";

// Shared provider classes (claude-code / opencode stay per-package because their
// prompt-delivery and skip-permissions semantics legitimately differ)
export { SubprocessTemplateProvider } from "./providers/subprocessTemplateProvider.js";
export {
  LocalSubprocessProvider,
  MISSING_WORKER_COMMAND_MESSAGE,
} from "./providers/localSubprocessProvider.js";
export { VSCodeTaskProvider } from "./providers/vscodeTaskProvider.js";
export { CodexProvider } from "./providers/codexProvider.js";
export { AntigravityProvider } from "./providers/antigravityProvider.js";

// Provider auto-resolution + factory (single source of truth for both orchestrators)
export type {
  AutoProviderContext,
  FreshSessionProviderDeps,
} from "./providers/providerFactory.js";
export {
  resolveFreshSessionProviderName,
  createFreshSessionProvider,
} from "./providers/providerFactory.js";

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
  resolveHostModel,
  agentHostFallbackConcurrency,
  DEFAULT_AGENT_HOST_CONCURRENCY,
} from "./quota/limits.js";
export type {
  ProviderType,
  LimitResolutionResult,
  ResolveLimitsOptions,
  ResolveHostModelOptions,
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
  CODEX_DESKTOP_ACTIVE_SUBAGENT_LIMIT,
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
export {
  scheduleWave,
  buildProviderModelKey,
  DEFAULT_SAFETY_MARGIN,
  DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
  DEFAULT_FIRST_CONTACT_CONCURRENCY,
  QUOTA_REMAINING_PCT_CRITICAL,
  QUOTA_REMAINING_PCT_LOW,
} from "./quota/scheduler.js";
export type {
  ScheduleWaveOptions,
  DiscoveredRateLimitsInput,
} from "./quota/scheduler.js";
export { LearnedQuotaSource } from "./quota/learnedQuotaSource.js";
export { CompositeQuotaSource } from "./quota/compositeQuotaSource.js";
export type { ErrorParser } from "./quota/errorParsers/index.js";
export {
  GenericErrorParser,
  ClaudeCodeErrorParser,
  getErrorParserForProvider,
} from "./quota/errorParsers/index.js";
