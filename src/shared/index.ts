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
  CriticalFlowFallbackResult,
} from "./types/flows.js";
export {
  FLOW_CONFIDENCE_LEVELS,
  FlowConfidenceLevelSchema,
  CriticalFlowSchema,
  CriticalFlowManifestSchema,
  CriticalFlowFallbackResultSchema,
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
  ExecutionRecordOutcome,
  ExecutorReportedStatement,
  ExecutionRecordV1Alpha1,
} from "./types/executionRecord.js";
export {
  EXECUTION_RECORD_CONTRACT_VERSION,
  ExecutionRecordOutcomeSchema,
  ExecutorReportedStatementSchema,
  ExecutionRecordV1Alpha1Schema,
} from "./types/executionRecord.js";
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
  AccessMemory,
  AccessMemoryPathRecord,
  AccessMemorySymbolRecord,
} from "./types/accessMemory.js";
export {
  ACCESS_MEMORY_VERSION,
  AccessMemorySchema,
  AccessMemoryPathRecordSchema,
  AccessMemorySymbolRecordSchema,
} from "./types/accessMemory.js";
export type { AccessTouchEvent } from "./accessMemory.js";
export { deriveAccessMemoryFromEvents } from "./accessMemory.js";
export { normalizeGraphPath, collectGraphEdges } from "./graph/graphPaths.js";
export { computeContinuityScores, continuityMassForPaths } from "./continuityScore.js";
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
  WorkBlockSeam,
  FindingTheme,
  SynthesisNarrative,
  AuditFindingsSummary,
  AuditFindingsReport,
} from "./types/finding.js";
export { findingIdentity } from "./types/finding.js";
export type { FindingLocationLineIssue } from "./types/finding.js";
// Zod schemas (A6 single source) — type inferred above, JSON schema generated.
export {
  FindingSeveritySchema,
  FindingConfidenceSchema,
  FindingLocationObjectSchema,
  FINDING_LINE_START_INTEGER_RULE,
  FINDING_LINE_END_INTEGER_RULE,
  FINDING_LINE_ORDER_RULE,
  refineFindingLocationLines,
  findingLocationLineIssues,
  FindingLocationSchema,
  FindingGroundingSchema,
  AnchorExpectationSchema,
  ExecutableAnchorSchema,
  FindingSchema,
  WorkBlockSchema,
  WorkBlockSeamSchema,
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
  TeleologyNode,
  TriangulatedTelos,
  ChannelDisagreement,
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
  TeleologyNodeSchema,
  TriangulatedTelosSchema,
  ChannelDisagreementSchema,
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
  modularityOf,
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
  CharterDeltaSubmission,
  CharterSubsystem,
  AssembledCharters,
  AssembledDeltas,
} from "./decompose/charterExtraction.js";
export {
  CharterSubmissionSchema,
  CharterDeltaSubmissionSchema,
  assembleCharters,
  assembleDeltas,
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
  MechanicalVerification,
} from "./types/remediationOutcome.js";
export {
  RemediationOutcomeStatusSchema,
  RemediationOutcomeSchema,
  RemediationOutcomesReportSchema,
  MechanicalVerificationSchema,
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
export type { StepStatus } from "./types/stepContract.js";
export { StepStatusSchema } from "./types/stepContract.js";
export {
  SESSION_INTENT_RELATIVE_PATH,
  SessionIntentV1Schema,
  loadSessionIntent,
} from "./sessionConfig.js";
export type {
  SessionIntentV1,
  SessionIntentLoadResult,
} from "./sessionConfig.js";
export {
  ANALYZER_POLICY_RELATIVE_PATH,
  AnalyzerConsentDecisionSchema,
  AnalyzerPolicySchema,
  getAnalyzerPolicyPath,
  loadAnalyzerPolicy,
  persistAnalyzerSettings,
  persistAnalyzerConsent,
} from "./analyzerPolicy.js";
export type {
  AnalyzerConsentDecision,
  AnalyzerPolicy,
  AnalyzerSetting,
} from "./analyzerPolicy.js";
export {
  ANALYZER_SETTINGS,
  AnalyzerSettingSchema,
} from "./analyzerPolicy.js";

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
  BYTES_PER_TOKEN,
  ESTIMATED_TOKENS_PER_LINE,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  ESTIMATED_ITEM_OVERHEAD_TOKENS,
  estimateTokensFromBytes,
} from "./tokens.js";

// Generic reducers: single-sourced "count items by key" (4 prior
// reimplementations across audit synthesis, the shared deliverable renderer,
// remediate's outcomes close-out, and remediate's findings digest).
export { countBy } from "./countBy.js";

// Generic greedy token/size-budget chunker (3 prior reimplementations across
// audit's review-packet chunker, audit's per-task-block file chunker, and
// remediate's per-overlap-group finding chunker). ChunkByBudgetOptions is
// deliberately NOT re-exported here: no call site needs to name the options
// type explicitly (each just passes an object literal), so barrel-exporting it
// would be an unconsumed export under the knip dead-code gate.
export { chunkByBudget } from "./chunkByBudget.js";

// One provider-neutral content-coherence membership core. Audit packets and
// findings work blocks are projections over this exact trace.
export type {
  ContentCoherenceEligibility,
  ContentCoherenceEvidence,
  ContentCoherenceItem,
  ContentCoherencePolicy,
  ContentCoherenceRelationshipKind,
  ContentCoherenceRelationship,
  ContentCoherenceInput,
  NormalizedContentCoherenceItem,
  ContentCoherenceTrace,
} from "./decompose/contentCoherence.js";
export {
  CONTENT_COHERENCE_SCORES,
  CONTENT_COHERENCE_THRESHOLD,
  FINDINGS_DRAW_COHERENCE_POLICY,
  TASK_DRAW_COHERENCE_POLICY,
  NormalizedContentCoherenceItemSchema,
  ContentCoherenceTraceSchema,
  buildContentCoherenceTrace,
} from "./decompose/contentCoherence.js";
// ONE seam derivation for every findings-draw producer — see the module header.
export {
  deriveWorkBlockSeams,
  workBlockSeamId,
  workBlockSeamRationale,
} from "./decompose/workBlockSeams.js";

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

// Finding similarity: the fuzzy (Jaccard title / file-overlap) tier consulted
// when the exact-match identity signature above does not already collapse two
// findings. Single source for the auditor's same-lens/cross-lens merge passes
// and the remediator's cross-lens dedup — both previously carried
// byte-identical private copies of these four helpers.
export {
  wordJaccard,
  filePathOverlap,
  primaryPath,
} from "./findingSimilarity.js";

// Content hashing: shared SHA-256 primitive (single source; explicit length)
export type { HashContentOptions } from "./hash.js";
export { hashContent } from "./hash.js";

// File integrity: the shared classify-and-bucket loop behind audit-code's
// checkFileIntegrity and remediate-code's checkAffectedFileIntegrity.
export type {
  FileIntegrityBuckets,
  FileIntegrityHashOutcome,
  FileIntegrityCheckOptions,
} from "./fileIntegrity.js";
export { checkFileIntegrityRecords } from "./fileIntegrity.js";

// Single canonical deterministic serializer (INV-CK-2) — the ONE stableStringify.
export { stableStringify } from "./stableStringify.js";

// Submission core: the ONE tool-owned path rule, failure vocabulary,
// expected-set contract, append-only drift/repair ledger, and the validated
// hand-recovery entry point both bins draw from. See src/shared/submission/.
export type {
  SubmissionIdParts,
  SubmissionRoots,
} from "./submission/submissionIdentity.js";
export {
  absoluteSubmissionPath,
  assertSubmissionRunId,
  mintSubmissionId,
  repoRelativePath,
  resolveContainedPath,
  submissionPathFor,
} from "./submission/submissionIdentity.js";
export type {
  SubmissionIssue,
  SubmissionIssueCode,
  SubmissionReadContext,
  SubmissionReadOutcome,
} from "./submission/submissionClassifier.js";
export {
  SUBMISSION_ISSUE_CODES,
  classifyRead,
  readSubmissionDocument,
} from "./submission/submissionClassifier.js";
export type {
  ExpectedSetDiff,
  ExpectedSubmission,
  ExpectedSubmissionLane,
  ExpectedSubmissionSet,
  SubmissionClassification,
} from "./submission/expectedSubmissions.js";
export {
  EXPECTED_SET_CONTRACT_VERSION,
  buildExpectedSubmissionSet,
  diffExpectedSet,
  mergeExpectedSets,
  withoutExpectedSubmissions,
} from "./submission/expectedSubmissions.js";
export type {
  SubmissionEventKind,
  SubmissionLedgerEvent,
} from "./submission/submissionLedger.js";
export {
  SUBMISSION_EVENT_KINDS,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  appendSubmissionEvent,
  readSubmissionLedger,
  submissionLedgerPath,
} from "./submission/submissionLedger.js";
export type {
  HandRecoveryOutcome,
  HandRecoveryRequest,
} from "./submission/handRecovery.js";
export { recoverSubmission } from "./submission/handRecovery.js";

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
  stripAuditToolsControlEnv,
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

// Tooling: THE declared single-invocation command shape. One rule, asked by
// every boundary that produces, consumes, or spawns a declared command — the
// producer's promotion normalizer, the host-handoff consumer, and the triage
// re-verification spawn.
export {
  commandLeavesDeclaredShape,
  partitionCommandsByDeclaredShape,
} from "./tooling/commandShape.js";

// Tooling: project-test admission gate (CP-NODE-4 obligation 3) — a SECOND,
// separately-owned admission mechanism anchored to discoverProjectCommands,
// distinct from the model-authored anchor allowlist above. Produced here;
// CP-NODE-7 is the consumer that routes runtimeCommand.ts's spawn through it.
export type { ProjectTestAdmissionOutcome } from "./tooling/projectTestAdmission.js";
export {
  PROJECT_TEST_TIMEOUT_MS,
  PROJECT_TEST_SIGKILL_GRACE_MS,
  PROJECT_TEST_MAX_CAPTURED_OUTPUT,
  isAdmittedProjectTestCommand,
  runAdmittedProjectTestCommand,
} from "./tooling/projectTestAdmission.js";

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
  isJsonParseError,
  JsonParseError,
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

// IO: schema-version read policy — the PAIR that names the two directions.
// Regenerable state (cache/carry/snapshot) discards a stale version and
// rebuilds; costly/authored state (confirmation/checkpoint) throws rather than
// silently losing work. A version stamped on write and never compared on read
// is an unchecked cast wearing a version field.
export {
  SchemaVersionMismatchError,
  discardOnSchemaVersionMismatch,
  throwOnSchemaVersionMismatch,
} from "./io/schemaVersion.js";

// IO: machine-global state dir (~/.audit-code / ~/.remediate-code) — the single
// path source every reader/writer of that state resolves through, honoring the
// AUDIT_CODE_STATE_DIR hermeticity override.
export {
  STATE_DIR_ENV_VAR,
  resolveStateDir,
  resolveAuditCodeStateDir,
} from "./io/stateDir.js";

// IO: generic locked JSON store — single-sources the read-under-lock →
// validate → atomic-write cycle plus the below-stale lock-timeout derivation
// shared by the audit session-config mutator and the remediate StateStore.
export type {
  LockedJsonStore,
  LockedJsonStoreOptions,
} from "./io/lockedJsonStore.js";
export {
  createLockedJsonStore,
  SKIP_WRITE,
  LOCKED_JSON_STORE_TIMEOUT_MS,
} from "./io/lockedJsonStore.js";
export type { Clock, LockOptions } from "./io/fileLock.js";
export {
  acquireLock,
  releaseLock,
  withFileLock,
  FileLockTimeoutError,
  STALE_LOCK_MS,
  isTransientPermissionContention,
} from "./io/fileLock.js";
export { canonicalizeFilePath } from "./io/pathIdentity.js";

// IO: canonical `.audit-tools/` path layout (single source for both CLIs)
export {
  auditToolsDir,
  auditArtifactsDir,
  remediationArtifactsDir,
  stepsDir,
  artifactTreeLockPath,
  submissionsDir,
  expectedSubmissionsPath,
  laneAssetsDir,
  hostScratchDir,
  outputDirFor,
  auditReportPath,
  auditFindingsPath,
  promotedAuditReportPath,
  promotedAuditFindingsPath,
  AUDIT_TOOLS_DIRNAME,
  AUDIT_REPORT_FILENAME,
  AUDIT_FINDINGS_FILENAME,
  REMEDIATION_REPORT_FILENAME,
  REMEDIATION_OUTCOMES_FILENAME,
} from "./io/auditToolsPaths.js";

// IO: filesystem-safe artifact naming for a model-authored id, plus the
// recognizer for the exact format it produces (kept together so they can't drift).
export {
  digestId,
  safeArtifactStem,
  artifactNameForId,
  isCanonicalResultFilename,
} from "./io/artifactName.js";

// IO: repo-root anchoring (untrust the process cwd; never nest .audit-tools)
export { resolveRepoRoot, climbOutOfAuditTools } from "./io/repoRoot.js";
export { resolveWithinRoot, assertWithinRoot } from "./io/pathContainment.js";
export type { WithinRootOptions } from "./io/pathContainment.js";

// IO: node-worktree context guard (a dispatched worker's cwd must never reach
// the shared run state through a driver lifecycle CLI or a session writer).
export {
  AUDIT_TOOLS_CALLER_CWD_ENV,
  nodeWorktreeAncestor,
  assertCliCommandAllowedFromCwd,
  assertNotNodeWorktreeCwd,
} from "./io/nodeWorktreeGuard.js";

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
  archiveFrictionRecords,
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

// CE-005 — the single shared mechanically observed step-boundary chokepoint.
// Every workflow friction fact routes through `captureStepBoundaryFriction` with a CE-006
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
  runWithBlockedStepBackstop,
  renderBlockedStepPrompt,
  writeBlockedStepContract,
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
  projectApprovedFindings,
  projectAuditFindingsReportSubset,
  isValidAuditFindingsReport,
  claimsAuditFindingsContract,
} from "./validation/findingsReport.js";

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
  createMemoizedSourceReader,
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

export type { CacheablePromptParts } from "./prompts.js";
export {
  buildCacheablePrompt,
  DISPATCH_PROMPT_HANDOFF_NOTE,
  renderHostScratchNote,
  renderIndependentReviewMandate,
  renderFanoutExecutionLines,
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

// Parsing utilities
export type { QuoteChar, StringAwareScannerOptions } from "./parsing/stringAwareScanner.js";
export { scanStringAware } from "./parsing/stringAwareScanner.js";
export {
  pathMatchesPrefix,
  globMatches,
  fileExclusionReason,
  EXCLUDED_OVERRIDE_STATUSES,
} from "./intent/pathScope.js";
export {
  crossLensDedupe,
  absorbFinding,
  mergeGrounding,
  mergeAffectedFiles,
  sameLensDedupe,
  upsertFindingByIdentity,
  findingReEmissionKey,
} from "./findings/dedupe.js";
export type {
  CrossLensDedupePolicy,
  CrossLensDedupeResult,
  AbsorbOptions,
} from "./findings/dedupe.js";

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
export { LOOP_CORE_PATTERNS, isLoopCorePath } from "./loopCorePaths.js";
export { applyGuidanceFile } from "./intake/guidanceBootstrap.js";

// External analyzer acquisition substrate (one core, two draws: audit's read
// draw and remediate's close-verify draw both run analyzers through this).
export {
  OWNED_TOOL_IDS,
  admitSpawn,
  runSafetyGate,
  runExternalAnalyzer,
  registerExternalAnalyzers,
  runAcquisitionEngine,
  resolveBinaryCandidates,
  detectNodeEcosystem,
  detectPythonEcosystem,
} from "./analyzers/acquisitionEngine.js";
export type {
  EcosystemRunner,
  AnalyzerSafetyProfile,
  ExternalAnalyzerCandidate,
  AcquisitionRunner,
  AcquisitionEngineOptions,
  AcquisitionOutcome,
  RunAllOutcome,
  ResolvedBinaries,
} from "./analyzers/acquisitionEngine.js";
export { resolveBinary, expectedSha256For } from "./analyzers/binaryAcquisition.js";
export type {
  BinarySpec,
  BinaryFetcher,
  BinaryCommandRunner,
  BinaryResolveOptions,
  BinaryResolution,
} from "./analyzers/binaryAcquisition.js";
export {
  ExternalAnalyzerResultItemSchema,
  ExternalAnalyzerGraphEdgeSchema,
  ExternalAnalyzerOwnershipRootSchema,
  ExternalAnalyzerToolStatusSchema,
  ExternalAnalyzerResultsSchema,
  ExternalAnalyzerAcquisitionMarkerSchema,
  upsertExternalToolResults,
} from "./analyzers/types.js";
export type {
  ExternalAnalyzerResultItem,
  ExternalAnalyzerGraphEdge,
  ExternalAnalyzerToolStatus,
  ExternalAnalyzerResults,
  ExternalAnalyzerAcquisitionMarker,
} from "./analyzers/types.js";
export {
  normalizeGenericExternalResults,
  normalizeGenericExternalEdges,
} from "./analyzers/normalizeExternal.js";
export type { NormalizeExternalOptions } from "./analyzers/normalizeExternal.js";
export {
  AnalyzerLeadProvenanceSchema,
  normalizeAnalyzerSnippet,
  hashAnalyzerSnippet,
  analyzerProvenanceKey,
} from "./analyzers/provenance.js";
export type { AnalyzerLeadProvenance } from "./analyzers/provenance.js";
export {
  EXTERNAL_ANALYZER_CANDIDATES,
  gitleaksCandidate,
  semgrepCandidate,
  knipCandidate,
  parseKnip,
  eslintCandidate,
  parseGitleaks,
  GITLEAKS_VERSION,
  jscpdCandidate,
  parseJscpd,
  osvScannerCandidate,
  parseOsvScanner,
  OSV_SCANNER_VERSION,
  clippyCandidate,
  rubocopCandidate,
  hadolintCandidate,
  parseHadolint,
  HADOLINT_VERSION,
  actionlintCandidate,
  parseActionlint,
  ACTIONLINT_VERSION,
  typeCoverageCandidate,
  parseTypeCoverage,
  lizardCandidate,
  parseLizard,
} from "./analyzers/candidates.js";
export { parseClippy } from "./analyzers/clippy.js";
export { parseRubocop } from "./analyzers/rubocop.js";
