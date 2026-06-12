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
export type { IntentCheckpoint } from "./types/intentCheckpoint.js";
export type { InterpretedIntent } from "./intent/freeFormIntentInterpreter.js";
export { interpretFreeFormIntent } from "./intent/freeFormIntentInterpreter.js";

// Intent interpretation
export type {
  IntentClauseKind,
  IntentClause,
  ClauseInterpretResult,
} from "./intent/clauseInterpreter.js";
export {
  decomposeIntent,
  assessClauseEncodability,
  interpretIntent,
} from "./intent/clauseInterpreter.js";
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
  DispatchRoutingTiers,
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

// OpenCode permission deployment helpers (global scope vs. agent scope)
export {
  OPENCODE_MANAGED_BROAD_VALUE,
  withoutOpenCodeWildcard,
  mergeOpenCodeAgentPermissionRule,
  mergeOpenCodeGlobalPermissionRule,
  migrateOpenCodeGlobalExternalDirectory,
} from "./opencodePermissions.js";

// Agent meta-audit reflections (opt-in worker feedback channel, both orchestrators)
export type {
  ReflectionClarity,
  ReflectionSeverity,
  AgentReflection,
  ReflectionAggregate,
} from "./agentReflections.js";
export {
  AGENT_FEEDBACK_FILENAME,
  parseReflectionsNdjson,
  aggregateReflections,
  renderProcessFeedbackSection,
} from "./agentReflections.js";

// Tokens
export {
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_OUTPUT_TOKENS,
  BLOCK_SAFETY_MARGIN,
  BYTES_PER_TOKEN,
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
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
  renderPromptCommand,
  toPromptPathToken,
  quotePromptCommandArg,
  coerceJsonObjectArg,
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
  isTransientFsError,
  withFsRetry,
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
export { CodexProvider } from "./providers/codexProvider.js";

// Provider auto-resolution + factory (single source of truth for both orchestrators)
export type {
  AutoProviderContext,
  FreshSessionProviderDeps,
} from "./providers/providerFactory.js";
export {
  resolveFreshSessionProviderName,
  createFreshSessionProvider,
} from "./providers/providerFactory.js";

// Provider confirmation (Gate-0 pool discovery + selection)
export type {
  CapabilityTier,
  DiscoveredProvider,
  ConfirmedProviderPool,
} from "./providers/providerConfirmation.js";
export {
  discoverProviders,
  queryProviderQuota,
  buildProviderConfirmationDisplay,
  applyProviderConfirmationSelections,
} from "./providers/providerConfirmation.js";

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
  WaveBindingCap,
  WaveSchedule,
  BackoffState,
  ObservedWaveOutcome,
} from "./quota/types.js";
export type { QuotaSource, QuotaUsageSnapshot } from "./quota/quotaSource.js";
export {
  resolveLimits,
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
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
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
  parseHostModelRoster,
  DEFAULT_SAFETY_MARGIN,
  DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
  DEFAULT_FIRST_CONTACT_CONCURRENCY,
  QUOTA_REMAINING_PCT_CRITICAL,
  QUOTA_REMAINING_PCT_LOW,
} from "./quota/scheduler.js";
export type {
  ScheduleWaveOptions,
  DiscoveredRateLimitsInput,
  HostModelRosterEntry,
} from "./quota/scheduler.js";
export {
  computeDispatchCapacity,
  summarizeDispatchCapacityPools,
  detectLivelock,
  buildEmptyPoolTerminal,
} from "./quota/capacity.js";
export type {
  CapacityPool,
  PoolDispatchAllocation,
  DispatchCapacityPoolSummary,
  DispatchCapacity,
  ComputeDispatchCapacityInput,
  PartialCompletionReason,
  PartialCompletionTerminal,
} from "./quota/capacity.js";
export type { CacheablePromptParts } from "./prompts.js";
export {
  buildCacheablePrompt,
  DO_NOT_TOKEN_WRAP_NOTE,
  DISPATCH_PROMPT_HANDOFF_NOTE,
} from "./prompts.js";

// Contract-pipeline artifact types (shared across both orchestrators)
export type {
  GoalSpec,
  ContextBundle,
  ContextBundleEntry,
  DesignSpec,
  DesignSpecInvariant,
  ConceptualDesignCritique,
  DesignCritiqueItem,
  ObligationLedger,
  ObligationEntry,
  ContractAssessmentReport,
  ContractAssessmentFinding,
  Counterexample,
  CounterexampleReport,
  CounterexampleClassification,
  JudgedCounterexample,
  JudgeRepairTarget,
  JudgeRepairDirective,
  JudgeReport,
  ImplementationDAG,
  ImplementationDAGNode,
  ImplementationDAGEdge,
  VerificationReport,
  VerificationTraceEntry,
  FindingVerificationTrace,
  TestSpec,
  TestValidatorPlan,
} from "./types/contractPipeline.js";
export {
  CONTRACT_PIPELINE_GOAL_SPEC_VERSION,
  CONTRACT_PIPELINE_CONTEXT_BUNDLE_VERSION,
  CONTRACT_PIPELINE_DESIGN_SPEC_VERSION,
  CONTRACT_PIPELINE_CONCEPTUAL_DESIGN_CRITIQUE_VERSION,
  CONTRACT_PIPELINE_OBLIGATION_LEDGER_VERSION,
  CONTRACT_PIPELINE_CONTRACT_ASSESSMENT_REPORT_VERSION,
  CONTRACT_PIPELINE_COUNTEREXAMPLE_VERSION,
  CONTRACT_PIPELINE_JUDGE_REPORT_VERSION,
  CONTRACT_PIPELINE_IMPLEMENTATION_DAG_VERSION,
  CONTRACT_PIPELINE_VERIFICATION_REPORT_VERSION,
  CONTRACT_PIPELINE_TEST_VALIDATOR_PLAN_VERSION,
} from "./types/contractPipeline.js";
export { LearnedQuotaSource } from "./quota/learnedQuotaSource.js";

// Parsing utilities
export type { QuoteChar, StringAwareScannerOptions } from "./parsing/stringAwareScanner.js";
export { scanStringAware } from "./parsing/stringAwareScanner.js";
export { CompositeQuotaSource } from "./quota/compositeQuotaSource.js";
export type { ErrorParser } from "./quota/errorParsers/index.js";
export {
  GenericErrorParser,
  ClaudeCodeErrorParser,
  getErrorParserForProvider,
} from "./quota/errorParsers/index.js";

// Rolling engine — provider-pool-change semantics (drop + re-route)
export type {
  ProviderPoolEventKind,
  ProviderPoolEvent,
  RollingEnginePoolEntry,
  RollingEnginePool,
  EnginePacketToken,
  RollingEnginePoolState,
} from "./quota/rollingEngine.js";
export {
  dropProvider,
  reroutePackets,
} from "./quota/rollingEngine.js";

// Rolling engine paused-state + livelock guard (N-S09)
export type {
  RollingEngineLifecycleState,
  SettledExclusionSet,
  AdvancePausedStateOptions,
} from "./rolling/pausedState.js";
export {
  LIVELOCK_PAUSE_LIMIT,
  filterNewProviders,
  checkLivelockGuard,
  advancePausedState,
} from "./rolling/pausedState.js";

// Rolling dispatch engine (packet-type-agnostic, quota-only throttle)
export type {
  RollingDispatchPacket,
  RollingDispatchResult,
  ProviderSlot,
  InFlightEntry,
  RollingDispatchState,
  RollingDispatchConfig,
  RollingDispatchOptions,
  RollingDispatcher,
} from "./dispatch/rollingDispatch.js";
export {
  InFlightTokenTracker,
  scorePacketComplexity,
  selectProvider,
  createRollingDispatcher,
} from "./dispatch/rollingDispatch.js";

// Versioned seam contracts (N-X06) — pinned interface types + version constants
export type {
  RollingDispatchEnginePacket,
  RollingDispatchEngineResult,
  RollingDispatchEngineContract,
} from "./types/rollingDispatch.js";
export { ROLLING_DISPATCH_ENGINE_VERSION } from "./types/rollingDispatch.js";

export type {
  ConfirmedPoolEntry,
  ProviderConfirmationResult,
} from "./types/providerConfirmation.js";
export { PROVIDER_CONFIRMATION_RESULT_VERSION } from "./types/providerConfirmation.js";

export type {
  EncodedClause,
  FreeFormIntentInterpretation,
} from "./types/intentInterpretation.js";
export { FREE_FORM_INTENT_INTERPRETATION_VERSION } from "./types/intentInterpretation.js";
