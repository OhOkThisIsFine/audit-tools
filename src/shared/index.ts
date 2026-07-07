// Types
export type {
  FileDispositionStatus,
  FileDispositionItem,
  FileDisposition,
} from "./types/disposition.js";
export {
  FileDispositionStatusSchema,
  FileDispositionItemSchema,
  FileDispositionSchema,
} from "./types/disposition.js";
export type { RiskItem, RiskRegister } from "./types/risk.js";
export { RiskItemSchema, RiskRegisterSchema } from "./types/risk.js";
export type {
  FlowConfidenceLevel,
  CriticalFlow,
  CriticalFlowManifest,
} from "./types/flows.js";
export {
  FLOW_CONFIDENCE_LEVELS,
  FlowConfidenceLevelSchema,
  CriticalFlowSchema,
  CriticalFlowManifestSchema,
} from "./types/flows.js";
export type {
  SurfaceKind,
  SurfaceRecord,
  SurfaceManifest,
} from "./types/surfaces.js";
export {
  SURFACE_KINDS,
  SurfaceKindSchema,
  SurfaceRecordSchema,
  SurfaceManifestSchema,
} from "./types/surfaces.js";
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
  NodeMetric,
  NodeMetrics,
} from "./types/graph.js";
export {
  GraphEdgeSchema,
  RouteEdgeSchema,
  GraphBundleSchema,
  NodeMetricSchema,
  NodeMetricsSchema,
} from "./types/graph.js";
export type { AccessDeclaration } from "./types/accessDeclaration.js";
export { AccessDeclarationSchema } from "./types/accessDeclaration.js";
export type {
  FindingSeverity,
  FindingConfidence,
  FindingLocation,
  FindingGrounding,
  AnchorExpectation,
  ExecutableAnchor,
  Finding,
  FindingIdentity,
  WorkBlock,
  FindingTheme,
  SynthesisNarrative,
  AuditFindingsSummary,
  AuditFindingsReport,
} from "./types/finding.js";
export { findingIdentity } from "./types/finding.js";
// Zod schemas (A6 single source) — type inferred above, JSON schema generated.
export {
  FindingSeveritySchema,
  FindingConfidenceSchema,
  FindingLocationSchema,
  FindingGroundingSchema,
  AnchorExpectationSchema,
  ExecutableAnchorSchema,
  FindingSchema,
  WorkBlockSchema,
  FindingThemeSchema,
  SynthesisNarrativeSchema,
  AuditFindingsSummarySchema,
  AuditFindingsReportSchema,
} from "./types/finding.js";
export type { IntentCheckpoint } from "./types/intentCheckpoint.js";
export { IntentCheckpointSchema } from "./types/intentCheckpoint.js";
// Conceptual design-review charter spine (Phase A) — data model + hard gates.
export type {
  CharterKind,
  CharterConfidence,
  CharterProvenance,
  Charter,
  GoalNode,
  GoalEdge,
  GoalGraph,
  Ceiling,
  CharterDelta,
  ClarificationValue,
  CharterClarificationAnswer,
  CharterClarificationRequest,
} from "./types/charter.js";
export {
  CharterKindSchema,
  CharterConfidenceSchema,
  CharterProvenanceSchema,
  CharterSchema,
  GoalNodeSchema,
  GoalEdgeSchema,
  GoalGraphSchema,
  CeilingSchema,
  CharterDeltaSchema,
  ClarificationValueSchema,
  CharterClarificationAnswerSchema,
  CharterClarificationRequestSchema,
} from "./types/charter.js";
export {
  applyTrueCharterGate,
  charterReviewDisposition,
  gateCharterDelta,
  riskGateClarification,
} from "./validation/charterGate.js";
// Conceptual design-review overlay-and-delta operator (Phase B) — the
// deterministic clustering + consensus primitives, reused at the structure layer
// now and the charter layer in Phase C.
export type { WeightedGraph, Partition } from "./decompose/modularity.js";
export {
  DEFAULT_RESOLUTIONS,
  louvain,
  resolutionSweep,
} from "./decompose/modularity.js";
export type {
  DecompositionSource,
  DecomposedNode,
  DecomposeResult,
  DecomposeOptions,
} from "./decompose/consensus.js";
export { decompose, clustersFromPartitions } from "./decompose/consensus.js";
// Conceptual design-review charter layer (Phase C) — assemble a gated charter
// register from a host LLM submission (deterministic enforcement half).
export type {
  CharterSubmission,
  CharterSubsystem,
  AssembledCharters,
} from "./decompose/charterExtraction.js";
export {
  CharterSubmissionSchema,
  assembleCharterRegister,
} from "./decompose/charterExtraction.js";
// Conceptual design-review charter-clarification loop (Phase D) — the pure
// triangulation-loop assembler (partition → risk-gate → split-by-attention);
// consumes the audit-side D1/D2 primitives via injected deps.
export type {
  ClarificationDeltaInput,
  ClarificationAttention,
  ClarificationLoopDeps,
  AssembledClarifications,
  ClarificationAnswersSubmission,
} from "./decompose/charterClarification.js";
export {
  assembleClarificationRegister,
  ClarificationAnswersSubmissionSchema,
} from "./decompose/charterClarification.js";
// Conceptual design-review systemic challenge loop (Phase E) — the second-order
// adversary submission schema (loop-until-dry improvement findings, true-lens).
export type { SystemicChallengeSubmission } from "./decompose/systemicChallenge.js";
export { SystemicChallengeSubmissionSchema } from "./decompose/systemicChallenge.js";
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
  clauseIdentity,
} from "./intent/clauseInterpreter.js";
export type {
  RemediationOutcomeStatus,
  RemediationOutcome,
  RemediationOutcomesReport,
} from "./types/remediationOutcome.js";
export {
  RemediationOutcomeStatusSchema,
  RemediationOutcomeSchema,
  RemediationOutcomesReportSchema,
} from "./types/remediationOutcome.js";
// Canonical lens vocabulary + the runtime validation Sets derived from it.
export type { Lens } from "./types/lens.js";
export {
  LensSchema,
  LENSES,
  VALID_LENSES,
  isLens,
  SEVERITIES,
  VALID_SEVERITIES,
  CONFIDENCES,
  VALID_CONFIDENCES,
  severityRank,
  confidenceRank,
  severityCompare,
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
export {
  StepStatusSchema,
  DispatchModelTierSchema,
} from "./types/stepContract.js";
export type {
  ProviderName,
  ResolvedProviderName,
  SessionUiMode,
  SubprocessTemplateConfig,
  ClaudeCodeConfig,
  CodexConfig,
  OpenCodeConfig,
  OpenAiCompatibleConfig,
  DispatchableSource,
  DispatchableSourceProvider,
  VSCodeTaskConfig,
  AntigravityConfig,
  BlockQuotaConfig,
  QuotaModelLimits,
  QuotaConfig,
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
  AnalyzerSettingSchema,
  resolveHostDispatchCapability,
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
  unionOpenCodeBashCeiling,
  composeOpenCodeBashCeiling,
  verifyOpenCodeBashCeiling,
} from "./opencodePermissions.js";
export type { OpenCodeCeilingViolation } from "./opencodePermissions.js";

// Agent meta-audit reflections (opt-in worker feedback channel, both orchestrators)
export type {
  ReflectionClarity,
  ReflectionSeverity,
  AgentReflection,
  ReflectionAggregate,
} from "./agentReflections.js";
export type {
  FindingFileRef,
  FindingBadge,
  FindingDisplay,
  FindingDisplayOptions,
} from "./reporting/findingDisplay.js";
export {
  findingLead,
  formatFindingFileRef,
  findingGroundingLine,
  renderFindingBadgeBody,
  renderFindingBlockLines,
  renderFindingBlock,
} from "./reporting/findingDisplay.js";
export type { AuditDeliverablePair } from "./reporting/auditDeliverable.js";
export {
  buildAuditFindingsDeliverable,
  renderAuditDeliverableMarkdown,
  buildAuditDeliverablePair,
} from "./reporting/auditDeliverable.js";
export {
  AGENT_FEEDBACK_FILENAME,
  parseReflectionsNdjson,
  aggregateReflections,
  renderProcessFeedbackSection,
  ReflectionClaritySchema,
  ReflectionSeveritySchema,
  AgentReflectionSchema,
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

// Concurrency: bounded, order-preserving parallel map
export { mapWithConcurrency } from "./concurrency.js";

// Id primitives: shared collision-disambiguation convention
export { mintUniqueId } from "./ids.js";

// Finding identity: the single finding-identity-signature authority (drift-plan
// R2). The auditor re-keys findings off this signature, the remediator's dedup
// uses it as the exact-match collapse, and the coverage-ledger denominator key
// derives from it. `findingIdentity()` (the FindingIdentity subset extractor)
// stays distinct — it strips contract_* overlay fields, a different concern.
export type { FindingIdentityFields } from "./findingIdentitySignature.js";
export {
  normalizeAnchorPath,
  normalizeTitle,
  findingIdentitySignature,
  findingIdentityFields,
  findingIdentityKey,
} from "./findingIdentitySignature.js";

// Content hashing: shared SHA-256 primitive (single source; explicit length)
export type { HashContentOptions } from "./hash.js";
export { hashContent } from "./hash.js";

// Single canonical deterministic serializer (INV-CK-2) — the ONE stableStringify.
export { stableStringify } from "./stableStringify.js";

// Content-key seam (O2 ↔ F1): tool-owned task-content signature + discriminator,
// grouping identityKey, signature-stable idempotencyKey, signature-sensitive
// contentKey, per-record instance id. See src/shared/contentKey.ts.
export type {
  IdentityKeyInput,
  TaskContentSignatureInput,
  ResultEmitSource,
  ResultContentDiscriminatorInput,
  IdempotencyKeyInput,
  ContentKeyInput,
} from "./contentKey.js";
export {
  buildTaskContentSignature,
  buildResultContentDiscriminator,
  resultDiscriminatorForEmit,
  canonicalSplitDiscriminator,
  splitDiscriminatorFromTaskId,
  identityKey,
  idempotencyKey,
  contentKey,
  newInstanceId,
} from "./contentKey.js";

// Diff-based re-review (B2/B3): generic projection serialization, leaf-level
// projection diff, and the re-review prompt section. Each orchestrator owns its
// own projection table; this single-sources the diff algorithm + prompt shape.
export type {
  ProjectionDiffEntry,
  ReReviewSectionInput,
} from "./reReview/projectionDiff.js";
export {
  stableStringifyProjection,
  diffProjections,
  renderDiffReReviewSection,
} from "./reReview/projectionDiff.js";

// Tooling: command execution
export type { RunTrackedOptions, RunTrackedResult } from "./tooling/exec.js";
export {
  runTracked,
  spawnSyncHidden,
  spawnHidden,
  resolveExecArgv,
  quoteForCmd,
  shellQuote,
  renderPromptCommand,
  toPromptPathToken,
  quotePromptCommandArg,
  coerceJsonObjectArg,
  platformCommand,
  quoteForShellInterpreterCmd,
  stripClaudeCodeEnv,
} from "./tooling/exec.js";

// Tooling: allowlisted read-only command runner + default-deny arg allowlist
// (single source for the auditor's executable-anchor grounding pass; CRIT
// ARC-a06a3945 — validates arguments, not just the executable).
export type {
  AllowlistedExecOutcome,
  AllowlistedExecRunner,
} from "./tooling/allowlistedExec.js";
export {
  ALLOWLISTED_EXEC_TIMEOUT_MS,
  ANCHOR_ALLOWLIST,
  GIT_READONLY_SUBCOMMANDS,
  executableBaseName,
  isAllowedAnchorCommand,
  runAllowlistedReadOnlyCommand,
} from "./tooling/allowlistedExec.js";

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
  headCommit,
  stagedAndUntracked,
  mineGitHistory,
} from "./git.js";
export type {
  GitHistory,
  CoChangePair,
  ChurnEntry,
  AuthorshipEntry,
  MineGitHistoryOptions,
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
  readJsonStringScalar,
  readJsonStringScalarChunks,
  appendNdjsonFile,
  readNdjsonFile,
  readOptionalJsonFile,
  readOptionalNdjsonFile,
  writeNdjsonFile,
  readOptionalTextFile,
  writeTextFile,
} from "./io/json.js";

// IO: canonical `.audit-tools/` path layout (single source for both CLIs)
export {
  auditToolsDir,
  auditArtifactsDir,
  remediationArtifactsDir,
  stepsDir,
  artifactTreeLockPath,
  nodeClaimsPath,
  taskClaimsPath,
  incomingDir,
  outputDirFor,
  auditReportPath,
  auditFindingsPath,
  promotedAuditReportPath,
  promotedAuditFindingsPath,
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
  REMEDIATION_REPORT_FILENAME,
  REMEDIATION_OUTCOMES_FILENAME,
} from "./io/auditToolsPaths.js";

// IO: repo-root anchoring (untrust the process cwd; never nest .audit-tools)
export { resolveRepoRoot, climbOutOfAuditTools } from "./io/repoRoot.js";

// IO: tool-emitted end-of-run friction capture (single-sourced shape + persist
// helper for BOTH orchestrators — cannot drift, never couples to any one repo's
// backlog doc).
export type {
  FrictionItem,
  FrictionCaptureArtifact,
} from "./io/frictionCapture.js";
export {
  FRICTION_CAPTURE_SCHEMA_VERSION,
  FRICTION_CAPTURE_DIRNAME,
  frictionCaptureDir,
  frictionCapturePath,
  frictionCaptured,
  persistFrictionCapture,
  sanitizeRunId,
} from "./io/frictionCapture.js";

// The single mechanical-friction sink (FC-005): no-op-safe, best-effort,
// per-event de-duped append wrapping the frictionCapture.ts substrate. O3/O2
// mechanical seams call this with a stable distinct event id.
export type {
  FrictionEvent,
  CapturedFrictionItem,
} from "./friction/captureFrictionEvent.js";
export { captureFrictionEvent } from "./friction/captureFrictionEvent.js";

// CE-005 — the single shared backend-observed step-boundary chokepoint. EVERY
// backend-observed friction fact (the five named, the intent-gate fact, any quota
// escalation) routes through `captureStepBoundaryFriction` with a CE-006
// structured percent-encoded collision-free event id. Consumed by both
// orchestrators so the fact list is structural/extensible, not a per-orchestrator
// snapshot a new fact can silently bypass.
export type {
  StepBoundaryEventType,
  StepBoundaryFriction,
} from "./friction/stepBoundaryCapture.js";
export {
  captureStepBoundaryFriction,
  stepBoundaryEventId,
} from "./friction/stepBoundaryCapture.js";

// O1 end-of-run friction TRIAGE: single-sourced triage step shape, disposition
// vocabulary (keep|discard|annotate), blocking semantics, and the close-out
// decider for BOTH orchestrators. Drops false-green; satisfaction = mechanical
// events UNION surfaced agent-feedback reflections; friction appends ride O2's
// withFileLock.
export type {
  FrictionDisposition,
  FrictionDispositionRecord,
  TriageSubject,
  FrictionTriageDecision,
  FrictionOpenObservation,
  FrictionCategoryAttestation,
  FrictionCategory,
  TriagedFrictionArtifact,
} from "./friction/triage.js";
export {
  FRICTION_DISPOSITIONS,
  FRICTION_NAMED_DIMENSIONS,
  FRICTION_CATEGORIES,
  FRICTION_CATEGORY_LABELS,
  isFrictionCategory,
  isFrictionDisposition,
  reflectionKey,
  frictionLockPath,
  collectTriageSubjects,
  decideFrictionTriage,
  buildFrictionTriageBlock,
  appendFrictionUnderLock,
  recordFrictionDisposition,
} from "./friction/triage.js";

// O3 emit-validate-repair seam: the single-sourced cheapest-first monotonic
// repair pipeline (deterministic coercion -> bounded errors-only LLM patch ->
// re-dispatch), one canonical validator re-run after each stage. Everything-
// agnostic: contract id, validator, coercion, and patcher are all caller-supplied.
export type {
  RepairValidationError,
  RepairValidationResult,
  RepairCoercion,
  RepairCoercionResult,
  RepairPatcher,
  RepairContract,
  RepairStatus,
  RepairStage,
  RepairRedispatch,
  RepairOutcome,
  RunEmitValidateRepairOptions,
} from "./repair/index.js";
export { runEmitValidateRepair } from "./repair/index.js";

// F4 dispatch-broker seam (lands first): the single gated F3<->F4 / O3<->F4
// chokepoint. Every seam consumer dispatches ONLY through the broker — quota
// read, deterministic-local estimate, refuse-over-budget, and the raw-result
// await-completion handoff are single-sourced so the two halves can't drift.
export type {
  BrokeredDispatchSlot,
  BrokerAdmission,
  BrokeredDispatchDecision,
  BrokeredCompletion,
  BrokerDispatchInput,
  BrokeredRepairDispatch,
} from "./repair/index.js";
export {
  createBrokeredRepairDispatch,
  estimateSlotTokens,
  classifyCapableHost,
} from "./repair/index.js";

// IO: install/ensure-time .gitignore management for artifacts emitted into a
// consuming repo's tree — always-ignore build/install assets + friction sidecar;
// visibility-conditional ignore of deliverables + meta-audit reflections.
export type { RepoVisibility } from "./io/gitignoreArtifacts.js";
export {
  ALWAYS_IGNORE_PATTERNS,
  PUBLIC_TREE_IGNORE,
  DELIVERABLE_REINCLUDES,
  AGENT_FEEDBACK_REINCLUDE,
  PRIVATE_TREE_PATTERNS,
  GITIGNORE_BLOCK_BEGIN,
  GITIGNORE_BLOCK_END,
  REPO_VISIBILITY_ENV,
  REPO_VISIBILITY_FILE,
  parseVisibilityOverride,
  renderGitignoreBlock,
  mergeGitignoreBlock,
  detectRepoVisibility,
  ensureArtifactGitignore,
} from "./io/gitignoreArtifacts.js";

// IO: single-sourced step-contract object + writer (drift-plan R3). Owns the
// steps/ filenames, mkdir + prompt write + atomic current-step.json write, the
// toPromptPathToken normalization of ALL host-facing path fields, and the
// canonical-paths-win merge. Both orchestrators extend BaseStepContract and
// call writeStepContract; neither writes raw Windows paths.
export type {
  BaseStepContract,
  WriteStepContractInput,
} from "./io/stepContractWriter.js";
export {
  currentStepPath,
  currentPromptPath,
  writeStepContract,
} from "./io/stepContractWriter.js";

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
export {
  AUDIT_FINDINGS_CONTRACT_VERSION,
  validateAuditFindingsReport,
  isValidAuditFindingsReport,
} from "./validation/findingsReport.js";
export { validateSessionConfig } from "./validation/sessionConfig.js";

// Validation: finding grounding primitives (quote-and-verify + path normalizer;
// single source for both orchestrators — drift-plan E3 + P7). INV-GND-02: a
// finding with no grounding verdict is treated as ungrounded (verify-before-fix).
export type { SourceReader } from "./validation/findingGrounding.js";
export {
  normalizeForMatch,
  normalizeRepoPath,
  isBareBasename,
  resolveBasenameToTrackedPath,
  enumerateTrackedFilePaths,
  quoteMatches,
  verifyFindingGrounding,
  findingIsGrounded,
  findingNeedsVerificationBeforeFix,
} from "./validation/findingGrounding.js";

// Validation: design-finding grounding (S8 = S7 applied to the reviewer; cites a
// real component path rather than a verbatim span). Single source for both
// orchestrators so neither forks design-grounding nor cross-area imports it.
export {
  groundDesignFinding,
  groundDesignFindings,
} from "./validation/designFindingGrounding.js";

// Provider types
export type {
  WorkerProgress,
  LaunchFreshSessionInput,
  LaunchFreshSessionResult,
  ProviderRateLimits,
  FreshSessionProvider,
  OutputConstraintMode,
  OutputConstraintCapability,
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
export { resolveOpenCodeSpawnCommand, resolveWindowsShimSpawnCommand } from "./providers/opencodeLaunch.js";

// Shared structured provider launch/done diagnostics (single source so the
// claude-code / opencode providers emit byte-identical stderr records).
export {
  emitProviderLaunchDiagnostic,
  emitProviderDoneDiagnostic,
} from "./providers/providerDiagnostics.js";

// Provider-keyed strategy lookup primitive (unknown key → generic fallback).
// Single-sources the quota error-parser + audit header-extractor factories.
export { makeProviderKeyedFactory } from "./providers/providerKeyedFactory.js";

// Shared provider classes. claude-code / opencode are now single-sourced here:
// the principled default (prompt via stdin + launch/done diagnostics) is shared,
// and the only per-orchestrator delta is the claude-code skip-permissions
// default and the nested-session guard message (drift-plan E4). Each
// orchestrator's providers/index.ts injects these via the factory deps.
export { SubprocessTemplateProvider } from "./providers/subprocessTemplateProvider.js";
export {
  LocalSubprocessProvider,
  MISSING_WORKER_COMMAND_MESSAGE,
} from "./providers/localSubprocessProvider.js";
export { CodexProvider } from "./providers/codexProvider.js";
export {
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_NAME,
  parseJsonLoose,
} from "./providers/openAiCompatibleProvider.js";
export type { OpenAiCompatibleProviderDeps } from "./providers/openAiCompatibleProvider.js";
export type { ClaudeCodeProviderOptions } from "./providers/claudeCodeProvider.js";
export {
  ClaudeCodeProvider,
  CLAUDE_CODE_PROVIDER_NAME,
  buildActiveClaudeCodeSessionMessage,
} from "./providers/claudeCodeProvider.js";
export {
  OpenCodeProvider,
  OPENCODE_PROVIDER_NAME,
} from "./providers/opencodeProvider.js";

// Provider auto-resolution + factory (single source of truth for both orchestrators)
export type {
  AutoProviderContext,
  FreshSessionProviderDeps,
} from "./providers/providerFactory.js";
export {
  resolveFreshSessionProviderName,
  createFreshSessionProvider,
  hasConfiguredOpenAiCompatible,
  discoverOutputConstraintCapability,
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
  representativeModelId,
  annotateConfirmedPoolCost,
  annotateConfirmedPool,
} from "./providers/providerConfirmation.js";
export {
  commandExists,
  isSelfSpawnBlocked,
  resolveConversationHostProvider,
  resolveHostProviderName,
  setCommandExistsForTesting,
} from "./providers/providerPathGuard.js";

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
export {
  LimitSourceSchema,
  LimitConfidenceSchema,
  HostConcurrencyLimitSourceSchema,
  HostConcurrencyLimitSchema,
  ResolvedLimitsSchema,
  WaveBindingCapSchema,
  BackoffStateSchema,
} from "./quota/types.js";
export type {
  QuotaSource,
  QuotaUsageSnapshot,
  QuotaWindow,
  QuotaProbeResult,
  QuotaProbeStatus,
} from "./quota/quotaSource.js";
export { QuotaUsageSnapshotSchema, QuotaWindowSchema, probeQuotaSource } from "./quota/quotaSource.js";
export {
  resolveLimits,
  hostClassFor,
  resolveHostModel,
} from "./quota/limits.js";
export type {
  ProviderType,
  LimitResolutionResult,
  ResolveLimitsOptions,
  ResolveHostModelOptions,
} from "./quota/limits.js";
export { resolveModelStatics, resetModelStaticsCache } from "./quota/modelStatics.js";
export type { ModelStatics } from "./quota/modelStatics.js";
export {
  setQuotaStateDir,
  getQuotaStatePath,
  readQuotaState,
  writeQuotaState,
  computeMaxSafeConcurrency,
  recordWaveOutcome,
  clearBucketFailureEvidence,
  foldTokensPerPctObservation,
  recordTokensPerPctObservation,
  foldOutputRatioObservation,
  recordOutputRatioObservation,
  OUTPUT_RATIO_EWMA_ALPHA,
  decayWeight,
  applyDecayToEntry,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
  computeRampUpConcurrency,
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
  MAX_BUCKET_LEVEL,
} from "./quota/state.js";
export {
  detectRateLimitError,
  detectRateLimitFromChannel,
  computeCooldownUntil,
  DEFAULT_COOLDOWN_MS,
} from "./quota/errorParsing.js";
export type { WorkerOutputChannel } from "./quota/errorParsing.js";
export {
  HostSessionQuotaSource,
  HOST_SESSION_QUOTA_SOURCE_NAME,
  DEFAULT_MAX_CONSECUTIVE_RE_LIMITS,
} from "./quota/hostSessionQuotaSource.js";
export type {
  NowFn,
  HostSessionEscalation,
  HostSessionLimitEvent,
  HostSessionQuotaSourceOptions,
} from "./quota/hostSessionQuotaSource.js";
// Shared claude-code stderr JSON-line scan (single source for the claude-code
// error parser + audit header extractor).
export { collectClaudeCodeJsonLines } from "./quota/claudeCodeJsonLines.js";
export {
  detectHostActiveSubagentLimit,
  resolveHostActiveSubagentLimit,
} from "./quota/hostLimits.js";
export type { ReadCodexMaxThreads } from "./quota/hostLimits.js";
export {
  CODEX_DEFAULT_MAX_THREADS,
  readCodexConfiguredMaxThreads,
} from "./quota/codexHostConfig.js";
export type { RateLimitDetectionResult } from "./quota/errorParsing.js";
export {
  acquireLock,
  releaseLock,
  withFileLock,
  FileLockTimeoutError,
  STALE_LOCK_MS,
} from "./quota/fileLock.js";
export type { ClaimRecord, ClaimResult } from "./quota/claimRegistry.js";
export { ClaimRegistry } from "./quota/claimRegistry.js";
export type {
  ReservationLease,
  AdmitDecision,
  AdmitInput,
} from "./quota/reservationLedger.js";
export {
  ReservationLedger,
  getReservationLedgerPath,
  createReservationLedger,
} from "./quota/reservationLedger.js";
export type {
  OutputReservationInput,
  PacketCost,
} from "./quota/packetCost.js";
export {
  resolveOutputReservation,
  estimatePacketCost,
} from "./quota/packetCost.js";
export type {
  ClaimBackoffOptions,
  ClaimHeartbeatOptions,
} from "./quota/claimLease.js";
export {
  claimWithBackoff,
  withClaimHeartbeat,
  DEFAULT_CLAIM_BACKOFF_MS,
} from "./quota/claimLease.js";
export { runSlidingWindow } from "./quota/slidingWindow.js";
export type { SlidingWindowResult } from "./quota/slidingWindow.js";
export {
  scheduleWave,
  classifyProvider,
  selectDispatchDriver,
  DISPATCH_Y_DISPATCHER_MIN_ITEMS,
  buildProviderModelKey,
  parseHostModelRoster,
  DEFAULT_SAFETY_MARGIN,
  DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
  QUOTA_REMAINING_PCT_CRITICAL,
  QUOTA_REMAINING_PCT_LOW,
} from "./quota/scheduler.js";
export type {
  ScheduleWaveOptions,
  DiscoveredRateLimitsInput,
  HostModelRosterEntry,
  ProviderClassification,
  DriverMechanism,
  DispatchDriverStrategy,
  DispatchDriverSelection,
  SelectDispatchDriverInput,
} from "./quota/scheduler.js";
export { HostModelRosterEntrySchema } from "./quota/scheduler.js";
export { renderDispatchDriverInstruction } from "./quota/dispatchDriverPrompt.js";
export {
  computeDispatchCapacity,
  summarizeDispatchCapacityPools,
  detectLivelock,
  buildEmptyPoolTerminal,
  buildQuotaPausedTerminal,
  buildOperatorForcedTerminal,
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
export { DispatchCapacityPoolSummarySchema } from "./quota/capacity.js";
// Generic dispatchable-source pools — the single-sourced backend-pool shape both
// orchestrators spill into (any non-IDE source: API endpoint or CLI), each with its
// own endpoint/parameters/quota. Generalizes the former openai-compatible-only path.
export {
  buildSourcePools,
  buildSourcePool,
  sourceProviderConfig,
  dispatchableSourceId,
  collectDispatchableSources,
  primaryInProcessSource,
  isDemotableInProcessProvider,
  shouldDemotePrimaryInProcess,
  withSourceConfig,
  sourceByPoolId,
  buildHostModelPool,
  buildHostModelPools,
} from "./quota/apiPool.js";
export type { CacheablePromptParts } from "./prompts.js";
export {
  buildCacheablePrompt,
  DISPATCH_PROMPT_HANDOFF_NOTE,
} from "./prompts.js";

// Host-asset renderers — every IDE asset derives from the one canonical prompt body.
export type { HostAssetKind, RenderHostAssetOptions } from "./hostAssets.js";
export { renderHostAsset } from "./hostAssets.js";

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
  ObligationChangeClassification,
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

// Obligation ledger construction with cycle detection (INV-shared-core-07)
export type { BuildObligationLedgerOptions } from "./types/obligationLedger.js";
export {
  detectObligationCycle,
  buildObligationLedger,
} from "./types/obligationLedger.js";
export { LearnedQuotaSource } from "./quota/learnedQuotaSource.js";

// Parsing utilities
export type { QuoteChar, StringAwareScannerOptions } from "./parsing/stringAwareScanner.js";
export { scanStringAware } from "./parsing/stringAwareScanner.js";
export {
  CompositeQuotaSource,
  buildQuotaSource,
  buildAccountScopedQuotaSource,
} from "./quota/compositeQuotaSource.js";
export type { BuildQuotaSourceOptions } from "./quota/compositeQuotaSource.js";
export {
  classifyQuotaCoverage,
  sourceCoversProvider,
  renderUnestablishedQuotaNudge,
  REACTIVE_ONLY_PROVIDERS,
  QuotaCoverageStatusSchema,
} from "./quota/coverage.js";
export type { QuotaCoverageStatus } from "./quota/coverage.js";
export {
  shouldEmitQuotaNudge,
  quotaNudgeMarkerName,
  renderQuotaCoverageNudge,
} from "./quota/quotaCoverageNudge.js";
export { renderTokenBudgetView } from "./quota/tokenBudgetView.js";
export {
  ClaudeOAuthQuotaSource,
  parseProviderModelKey,
  mapUsageToSnapshot,
} from "./quota/claudeOAuthQuotaSource.js";
export type { ClaudeOAuthQuotaSourceOptions } from "./quota/claudeOAuthQuotaSource.js";
export { fetchClaudeUsage } from "./quota/claudeOAuthQuotaSource.js";
export {
  BaseHttpQuotaSource,
  fetchJsonOrNull,
  clampFraction,
  remainingFromUsedPercent,
} from "./quota/httpQuotaSource.js";
export type {
  HttpQuotaSourceOptions,
  UsageFetchContext,
  FetchLike,
} from "./quota/httpQuotaSource.js";
export { CodexQuotaSource, fetchCodexUsage, mapCodexUsage } from "./quota/codexQuotaSource.js";
export type { CodexQuotaSourceOptions } from "./quota/codexQuotaSource.js";
export { CopilotQuotaSource, fetchCopilotUsage, mapCopilotUsage } from "./quota/copilotQuotaSource.js";
export type { CopilotQuotaSourceOptions } from "./quota/copilotQuotaSource.js";
export {
  AntigravityQuotaSource,
  fetchAntigravityUsage,
  mapAntigravityUsage,
} from "./quota/antigravityQuotaSource.js";
export type { AntigravityQuotaSourceOptions } from "./quota/antigravityQuotaSource.js";
export { OpenCodeQuotaSource } from "./quota/openCodeQuotaSource.js";
export type { OpenCodeQuotaSourceOptions } from "./quota/openCodeQuotaSource.js";
export type { ErrorParser } from "./quota/errorParsers/index.js";
export {
  GenericErrorParser,
  ClaudeCodeErrorParser,
  getErrorParserForProvider,
} from "./quota/errorParsers/index.js";

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

// Single shared dispatch tier-rank authority (P1) — the ONE ordering of
// DispatchModelTier, consolidating the previously-duplicated rank maps.
export {
  DISPATCH_TIER_RANK,
  DISPATCH_TIER_ORDER,
  DISPATCH_TIER_RANK_FALLBACK,
  tierRank,
  compareTier,
  mostCapableTier,
} from "./dispatch/tierRank.js";

// Cost-first routing engine (real price → costRank; spec/cost-first-routing.md).
export {
  COST_BLEND_INPUT_WEIGHT,
  COST_BLEND_OUTPUT_WEIGHT,
  CONFIRMED_ORDER_BAND_BASE,
  PRICE_BAND_BASE,
  UNKNOWN_PRICE_BAND_BASE,
  blendedPrice,
  resolveModelPrice,
  deriveCostRank,
  suggestCostOrdering,
  lookupConfirmedPosition,
  resolveConfirmedCostPositions,
} from "./dispatch/costRank.js";
export type {
  CostRankInput,
  CostCandidate,
  OrderedCostCandidate,
} from "./dispatch/costRank.js";

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

// Host-path admission loop — the tool-side "grant the admitted set" primitive
// (per-grant batches, cost-first-capable routing) that REPLACES the removed
// `max_concurrent_agents` scalar. Both orchestrators embed DispatchAdmissionSchema
// in their dispatch-quota contract.
export {
  admitBatch,
  computeDispatchAdmission,
  AdmissionGrantSchema,
  AdmissionExplainSchema,
  DispatchAdmissionSchema,
} from "./dispatch/admissionLoop.js";
export type {
  AdmissionCandidate,
  AdmissionPool,
  AdmissionGrant,
  AdmissionExplain,
  DispatchAdmission,
  AdmitBatchResult,
  AdmitBatchInput,
} from "./dispatch/admissionLoop.js";

// File-ownership-disjoint admission scheduling (INV-SOO) + the single-sourced path
// identity it keys on — shared so BOTH orchestrators split a dependency level into
// disjoint sub-waves through ONE scheduler (audit is the read-only degenerate case:
// all read-only nodes collapse into one maximal parallel sub-wave).
export { canonicalizeFilePath } from "./dispatch/pathIdentity.js";
export {
  ownershipSubWaves,
  canonicalScopeKeys,
} from "./dispatch/ownershipScheduler.js";
export type { OwnershipSchedulerNode } from "./dispatch/ownershipScheduler.js";

// The unified in-process rolling driver — the ONE level/sub-wave loop both
// orchestrators drive above `createRollingDispatcher`; each keeps only its own
// terminal/result-routing adapter (audit livelock+DC-4, remediate quota_paused merge).
export { driveRolling, resolveLedgerBudgets } from "./dispatch/unifiedRolling.js";
export type {
  UnifiedRollingConfig,
  UnifiedRollingLevelResult,
  UnifiedRollingResult,
} from "./dispatch/unifiedRolling.js";

// Hybrid spill coordinator (A-8) — the ONE assignment layer both dispatch drivers
// drive identically: claim-before-assign (CE-001), co-owned SettledExclusionSet,
// proactive capacity split through the single S4 fold, and the sole pause-authorizing
// 'all pools exhausted' terminal.
export type {
  FrontierNode,
  NodeAssignment,
  CoordinatorTerminalStatus,
  HybridSpillCoordinatorOptions,
} from "./dispatch/coordinator.js";
export { HybridSpillCoordinator } from "./dispatch/coordinator.js";
// The ONE hybrid split layer both orchestrators drive (classification injected).
export { planHybridDispatch } from "./dispatch/hybridDispatch.js";
export type { HybridDispatchPartition, HybridDispatchInput } from "./dispatch/hybridDispatch.js";
// Cross-cycle settled-pool store (DC-4): a spilled-then-exhausted pool the coordinator
// excludes from future splits so stranded work falls back to the host pool.
export { readSettledPools, addSettledPool } from "./dispatch/settledPools.js";

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
  ProviderConfirmationInput,
} from "./types/providerConfirmation.js";
export {
  PROVIDER_CONFIRMATION_RESULT_VERSION,
  PROVIDER_CONFIRMATION_INPUT_VERSION,
} from "./types/providerConfirmation.js";

// DC-2 — shared session-level provider confirmation (cross-tool Gate-0 artifact)
export type { SharedProviderConfirmation, SharedProviderConfirmationRead } from "./providers/sharedProviderConfirmation.js";
export { SHARED_PROVIDER_CONFIRMATION_VERSION, SHARED_PROVIDER_CONFIRMATION_FILENAME, sharedProviderConfirmationPath, currentProviderRoster, buildSharedProviderConfirmation, writeSharedProviderConfirmation, readSharedProviderConfirmation, readConfirmedCostPositions, PROVIDER_CONFIRMATION_INPUT_FILENAME, readProviderConfirmationInput } from "./providers/sharedProviderConfirmation.js";

export type {
  EncodedClause,
  FreeFormIntentInterpretation,
} from "./types/intentInterpretation.js";
export { FREE_FORM_INTENT_INTERPRETATION_VERSION } from "./types/intentInterpretation.js";

// Shared obligation engine (A3) — the single source for the ordered-obligation
// vocabulary + selection scan both orchestrators run on. audit-code binds its
// PRIORITY to findFirstActionableObligation; remediate-code adopts it as it
// migrates off its imperative cascade. See spec/a3-a4-engine-unification-plan.md.
export type {
  ObligationState,
  Obligation,
  ObligationDef,
  ObligationOutcome,
  ObligationEngine,
  AdvanceResult,
} from "./engine/obligationEngine.js";
export {
  ObligationStateSchema,
  ObligationSchema,
  findFirstActionableObligation,
  findNextObligation,
  advance,
  DEFAULT_MAX_TRANSITIONS,
} from "./engine/obligationEngine.js";
