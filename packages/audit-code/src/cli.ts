import { mkdir, readFile, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoManifest } from "./extractors/fileInventory.js";
import { buildFileDisposition } from "./extractors/disposition.js";
import { buildCriticalFlowManifest } from "./extractors/flows.js";
import { buildSurfaceManifest } from "./extractors/surfaces.js";
import { buildUnitManifest } from "./orchestrator/unitBuilder.js";
import { buildFlowCoverage } from "./orchestrator/flowCoverage.js";
import {
  buildRuntimeValidationTasks,
  discoverRuntimeValidationCommand,
} from "./orchestrator/runtimeValidation.js";
import { initializeCoverageFromPlan } from "./orchestrator/planning.js";
import {
  type ArtifactBundle,
  loadArtifactBundle,
  writeCoreArtifacts,
  promoteFinalAuditReport,
  AUDIT_REPORT_FILENAME,
} from "./io/artifacts.js";
import { isFileMissingError, readJsonFile, writeJsonFile, prefixValidationIssues, RunLogger } from "@audit-tools/shared";
import { buildQuotaSource } from "@audit-tools/shared/quota/compositeQuotaSource";
import { validateArtifactBundle } from "./validation/artifacts.js";
import {
  validateAuditResults,
  formatAuditResultIssues,
} from "./validation/auditResults.js";
import {
  validateConfiguredProviderEnvironment,
  validateSessionConfig,
} from "./validation/sessionConfig.js";
import {
  buildAuditReportModel,
  renderAuditReportMarkdown,
} from "./reporting/synthesis.js";
import { deriveAuditState } from "./orchestrator/state.js";
import { advanceAudit, type AdvanceAuditResult } from "./orchestrator/advance.js";
import { checkFileIntegrity } from "./orchestrator/fileIntegrity.js";
import { decideNextStep } from "./orchestrator/nextStep.js";
import {
  collectLowConfidenceEdges,
  buildEdgeReasoningPrompt,
  edgeReasoningContentHash,
  type EdgeReasoningResults,
} from "./orchestrator/edgeReasoning.js";
import { renderDesignReviewPrompt } from "./orchestrator/designReviewPrompt.js";
import { renderSynthesisNarrativePrompt } from "./reporting/synthesisNarrativePrompt.js";
import {
  createFreshSessionProvider,
  resolveFreshSessionProviderName,
} from "./providers/index.js";
import { appendRunLedgerEntry, loadRunLedger } from "./supervisor/runLedger.js";
import {
  buildAuditCodeHandoff,
  writeAuditCodeHandoffArtifacts,
  type AuditCodeHandoff,
  type ActiveReviewRun,
} from "./supervisor/operatorHandoff.js";
import {
  getSessionConfigPath,
  loadSessionConfig,
  persistAnalyzerSettings,
  readSessionConfigFile,
} from "./supervisor/sessionConfig.js";
import {
  resolveAnalyzerPlan,
  needsInstallDecision,
} from "./extractors/analyzers/registry.js";
import { buildPathLookup } from "./extractors/graph.js";
import { buildDispositionMap } from "./extractors/disposition.js";
import type { AnalyzerPlanEntry } from "./extractors/analyzers/types.js";
import {
  clearDispatchFiles,
  buildRunId,
  ensureSupervisorDirs,
  getRunPaths,
  writeDispatchBatchFiles,
  writeWorkerTaskFiles,
  type RunPaths,
} from "./io/runArtifacts.js";
import { renderWorkerPrompt } from "./prompts/renderWorkerPrompt.js";
import {
  estimateTaskGroupTokens,
  sizeIndexFromManifest,
} from "./orchestrator/reviewPackets.js";
import type { AuditResult, AuditTask, Finding, RepoManifest } from "./types.js";
import type { AuditState } from "./types/auditState.js";
import type { AnalyzerSetting, GraphEdge, SessionConfig, StepStatus, SynthesisNarrative } from "@audit-tools/shared";
import type { RuntimeValidationReport } from "./types/runtimeValidation.js";
import type { ExternalAnalyzerResults } from "./types/externalAnalyzer.js";
import type { WorkerTask } from "./types/workerSession.js";
import type { WorkerResult } from "./types/workerResult.js";
import { LOCAL_SUBPROCESS_PROVIDER_NAME } from "./providers/constants.js";
import { runAuditCodeMcpServer } from "./mcp/server.js";
import {
  scheduleWave,
  buildProviderModelKey,
  readQuotaState,
  recordWaveOutcome,
  resolveLimits,
  resolveHostActiveSubagentLimit,
  probeProvider,
  computeMaxSafeConcurrency,
  getQuotaStatePath,
  detectRateLimitError,
  computeCooldownUntil,
  runSlidingWindow,
  lookupDiscoveredLimits,
  updateDiscoveredLimits,
  mergeDiscoveredLimits,
  getHeaderExtractorForProvider,
  setQuotaStateDir,
} from "./quota/index.js";
import type { DiscoveredRateLimits, DispatchQuota } from "./quota/index.js";

// Re-exports from extracted modules
export {
  resolveHostDispatchCapability,
  DIRECT_CLI_DEFAULTS,
  getFlag,
  hasFlag,
  getOptionalBooleanFlag,
  getArtifactsDir,
  getRootDir,
  getBatchResultsDir,
  getMaxRuns,
  getAgentBatchSize,
  getParallelWorkers,
  getTimeoutMs,
  chunkArray,
  getUiMode,
  looksLikeCliFlag,
  countLines,
  warnIfNotGitRepo,
} from "./cli/args.js";
import {
  type UiMode,
  DIRECT_CLI_DEFAULTS,
  getFlag,
  hasFlag,
  getOptionalBooleanFlag,
  optionalBooleanEnv,
  toBase64Url,
  fromBase64Url,
  digestId,
  safeArtifactStem,
  artifactNameForId,
  quoteCommandArg,
  renderCommand,
  summarizeLaunchExit,
  taskResultPath,
  packetPromptPath,
  readStdinText,
  normalizePositiveInteger,
  parsePositiveIntegerFlag,
  getArtifactsDir,
  getRootDir,
  warnIfNotGitRepo,
  getBatchResultsDir,
  getMaxRuns,
  getAgentBatchSize,
  getParallelWorkers,
  getTimeoutMs,
  getExplicitProvider,
  getHostModel,
  getHostMaxActiveSubagents,
  getQuotaProbeMode,
  resolveRunProviderName,
  chunkArray,
  getUiMode,
  looksLikeCliFlag,
  resolveHostDispatchCapability,
  countLines,
  listBatchResultFiles,
} from "./cli/args.js";
import {
  nextStepCommand,
  mergeAndIngestCommand,
  renderDispatchReviewPrompt,
  renderSingleTaskFallbackStepPrompt,
  renderPresentReportPrompt,
  renderAnalyzerInstallPrompt,
  renderEdgeReasoningStepPrompt,
  renderEdgeReasoningDispatchPrompt,
  renderBlockedStepPrompt,
} from "./cli/prompts.js";
import {
  STEP_CONTRACT_VERSION,
  type StepKind,
  type StepArtifact,
  writeCurrentStep,
} from "./cli/steps.js";
import {
  WORKER_RESULT_CONTRACT_VERSION,
  buildWorkerResult,
  persistWorkerRunArtifacts,
  isWorkerResult,
  buildWorkerFailureBlocker,
  formatAuditResultValidationError,
} from "./cli/workerResult.js";
import {
  type ActiveDispatchState,
  type PrepareDispatchResult,
  DISPATCH_RESULT_MAP_FILENAME,
  ACTIVE_DISPATCH_FILENAME,
  dispatchResultMapPath,
  resolveRunScopedArg,
  loadDispatchResultMap,
  entriesByTaskId,
  buildPendingAuditTasks,
  prepareDispatchArtifacts,
} from "./cli/dispatch.js";
import {
  readWaveManifest,
  writeWaveManifest,
  removeWaveManifest,
  buildWaveSlotEntry,
} from "./cli/waveManifest.js";
import {
  buildLineIndex,
  buildLineIndexForPaths,
  addFileLineCountHints,
} from "./cli/lineIndex.js";
import {
  emitEnvelope,
  buildBlockedAuditState,
  buildManualReviewBlocker,
  shouldRunInlineExecutor,
} from "./cli/envelope.js";
import {
  writeHandoffOnly,
  ensureSemanticReviewRun,
} from "./cli/reviewRun.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SAMPLE_REPO_FILES = [
  { path: "src/api/auth.ts", size_bytes: 1240, hash: "abc123" },
  { path: "src/lib/session.ts", size_bytes: 980, hash: "def456" },
  { path: "infra/deploy.yml", size_bytes: 420, hash: "ghi789" },
  { path: "docs/notes.md", size_bytes: 300, hash: "doc111" },
];


export const cliTestUtils = {
  defaults: DIRECT_CLI_DEFAULTS,
  getFlag,
  hasFlag,
  getArtifactsDir,
  getRootDir,
  getBatchResultsDir,
  getMaxRuns,
  getAgentBatchSize,
  getParallelWorkers,
  getTimeoutMs,
  chunkArray,
  getUiMode,
  looksLikeCliFlag,
  countLines,
  warnIfNotGitRepo,
};

async function maybeArchiveLegacyPendingResults(
  auditResultsPath: string | undefined,
): Promise<string | undefined> {
  if (!auditResultsPath || basename(auditResultsPath) !== "worker_results_pending.json") {
    return undefined;
  }

  const archivedPath = join(
    dirname(auditResultsPath),
    `worker_results_submitted_${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
  try {
    await rename(auditResultsPath, archivedPath);
    return archivedPath;
  } catch (error) {
    process.stderr.write(
      `[audit-results cleanup] failed to archive ${auditResultsPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

async function runAuditStep(options: {
  root: string;
  artifactsDir: string;
  preferredExecutor?: string;
  auditResultsPath?: string;
  runtimeUpdatesPath?: string;
  externalAnalyzerPath?: string;
  narrativeResultsPath?: string;
  edgeReasoningResultsPath?: string;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  since?: string;
  opentoken?: boolean;
  runLog?: boolean;
}) {
  const bundle = await loadArtifactBundle(options.artifactsDir);
  const runLogger = new RunLogger(join(options.artifactsDir, "run.log.jsonl"), {
    enabled: options.runLog ?? true,
  });
  const lineIndex = bundle.repo_manifest
    ? await buildLineIndex(options.root, bundle.repo_manifest)
    : undefined;
  const sizeIndex = bundle.repo_manifest
    ? sizeIndexFromManifest(bundle.repo_manifest)
    : undefined;
  if (looksLikeCliFlag(options.auditResultsPath)) {
    throw new Error(
      `Invalid audit results path '${options.auditResultsPath}'. This looks like a CLI flag rather than a file path.`,
    );
  }
  const auditResults = options.auditResultsPath
    ? await readJsonFile<unknown>(options.auditResultsPath)
    : undefined;
  if (auditResults !== undefined) {
    const issues = validateAuditResults(auditResults, bundle.audit_tasks ?? [], {
      lineIndex,
    });
    const errors = issues.filter((issue) => issue.severity === "error");
    const warnings = issues.filter((issue) => issue.severity === "warning");

    if (warnings.length > 0) {
      process.stderr.write(
        `audit-results validation: ${warnings.length} warning(s):\n` +
          formatAuditResultIssues(warnings) +
          "\n",
      );
    }
    if (errors.length > 0) {
      throw new Error(formatAuditResultValidationError(errors));
    }
  }
  const runtimeValidationUpdates = options.runtimeUpdatesPath
    ? await readJsonFile<RuntimeValidationReport>(options.runtimeUpdatesPath)
    : undefined;
  const externalAnalyzerResults = options.externalAnalyzerPath
    ? await readJsonFile<ExternalAnalyzerResults>(options.externalAnalyzerPath)
    : undefined;
  const narrativeResults = options.narrativeResultsPath
    ? await readJsonFile<SynthesisNarrative>(options.narrativeResultsPath)
    : undefined;
  const edgeReasoningResults = options.edgeReasoningResultsPath
    ? await readJsonFile<EdgeReasoningResults>(options.edgeReasoningResultsPath)
    : undefined;

  const result = await advanceAudit(bundle, {
    root: options.root,
    lineIndex,
    sizeIndex,
    auditResults: auditResults as AuditResult[] | undefined,
    runtimeValidationUpdates,
    externalAnalyzerResults,
    narrativeResults,
    edgeReasoningResults,
    analyzers: options.analyzers,
    graphLlmEdgeReasoning: options.graphLlmEdgeReasoning,
    since: options.since,
    preferredExecutor: options.preferredExecutor,
    opentoken: options.opentoken,
    runLogger,
  });

  await writeCoreArtifacts(options.artifactsDir, result.updated_bundle);
  const archivedPendingResults = await maybeArchiveLegacyPendingResults(
    options.auditResultsPath,
  );
  if (archivedPendingResults) {
    result.progress_summary +=
      ` Archived legacy staging file to ${archivedPendingResults}.`;
  }
  return result;
}

async function ingestBatchAuditResults(options: {
  root: string;
  artifactsDir: string;
  batchDir: string;
}) {
  const batchFiles = await listBatchResultFiles(options.batchDir);
  const artifactsWritten = new Set<string>();
  const progressSummaries: string[] = [];
  let lastStep:
    | Awaited<ReturnType<typeof runAuditStep>>
    | null = null;
  let anyProgress = false;

  for (const batchFile of batchFiles) {
    const step = await runAuditStep({
      root: options.root,
      artifactsDir: options.artifactsDir,
      preferredExecutor: "result_ingestion_executor",
      auditResultsPath: batchFile,
    });
    lastStep = step;
    anyProgress ||= step.progress_made;
    for (const artifact of step.artifacts_written) {
      artifactsWritten.add(artifact);
    }
    progressSummaries.push(`${basename(batchFile)}: ${step.progress_summary}`);
  }

  const bundle =
    lastStep?.updated_bundle ??
    (await loadArtifactBundle(options.artifactsDir));
  const state = deriveAuditState(bundle);
  const decision = decideNextStep(bundle);

  return {
    batchFiles,
    bundle,
    audit_state: state,
    selected_obligation:
      lastStep?.selected_obligation ?? decision.selected_obligation,
    selected_executor:
      lastStep?.selected_executor ?? "result_ingestion_executor",
    progress_made: anyProgress,
    artifacts_written: Array.from(artifactsWritten),
    progress_summary:
      `Imported ${batchFiles.length} batch result file${batchFiles.length === 1 ? "" : "s"} from ${options.batchDir}.` +
      (progressSummaries.length > 0
        ? `\n${progressSummaries.join("\n")}`
        : ""),
    next_likely_step:
      state.status === "complete" ? null : decision.selected_obligation,
  };
}


async function persistConfigErrorHandoff(params: {
  root: string;
  artifactsDir: string;
  progressSummary: string;
}): Promise<void> {
  const bundle = await loadArtifactBundle(params.artifactsDir);
  const blockedState = buildBlockedAuditState({
    state: bundle.audit_state ?? deriveAuditState(bundle),
    obligationId: null,
    executor: null,
    blocker: params.progressSummary,
  });
  await writeCoreArtifacts(params.artifactsDir, {
    ...bundle,
    audit_state: blockedState,
  });
  const handoff = buildAuditCodeHandoff({
    root: params.root,
    artifactsDir: params.artifactsDir,
    state: blockedState,
    bundle: { ...bundle, audit_state: blockedState },
    progressSummary: params.progressSummary,
    isConfigError: true,
  });
  await writeAuditCodeHandoffArtifacts(handoff);
}


export async function runSample(argv: string[] = process.argv): Promise<void> {
  const repoManifest = buildRepoManifest("sample-repo", SAMPLE_REPO_FILES);
  const disposition = buildFileDisposition(repoManifest);
  const unitManifest = buildUnitManifest(repoManifest, disposition);
  const surfaceManifest = buildSurfaceManifest(repoManifest, disposition);
  const criticalFlows = buildCriticalFlowManifest(
    repoManifest,
    surfaceManifest,
    disposition,
  );
  const coverage = initializeCoverageFromPlan(
    repoManifest,
    unitManifest,
    disposition,
  );
  const sampleResults: AuditResult[] = [
    {
      task_id: "src-api:security:src/api/auth.ts:1-100",
      unit_id: unitManifest.units[0]?.unit_id ?? "sample-unit",
      pass_id: "pass:security",
      lens: "security",
      agent_role: "security-auditor",
      file_coverage: [{ path: "src/api/auth.ts", total_lines: 100 }],
      findings: [],
      notes: ["Sample result ingestion path."],
      requires_followup: false,
    },
  ];
  const flowCoverage = buildFlowCoverage(criticalFlows, coverage);
  const runtimeValidationTasks = buildRuntimeValidationTasks({
    unitManifest,
    criticalFlows,
    flowCoverage,
    command: ["npm", "test"],
  });
  const runtimeValidationReport = {
    results: runtimeValidationTasks.tasks.map((task) => ({
      task_id: task.id,
      status: "confirmed" as const,
      summary: "Sample runtime validation completed.",
      evidence: [],
      notes: [],
    })),
  };
  const auditReport = renderAuditReportMarkdown(
    buildAuditReportModel({
      results: sampleResults,
      unitManifest,
      criticalFlows,
      coverageMatrix: coverage,
      runtimeValidationReport,
    }),
  );
  const auditState = deriveAuditState({
    repo_manifest: repoManifest,
    file_disposition: disposition,
    unit_manifest: unitManifest,
    surface_manifest: surfaceManifest,
    critical_flows: criticalFlows,
    flow_coverage: flowCoverage,
    coverage_matrix: coverage,
    runtime_validation_tasks: runtimeValidationTasks,
    runtime_validation_report: runtimeValidationReport,
    audit_results: sampleResults,
    audit_report: auditReport,
  });
  const artifactsDir = getArtifactsDir(argv);
  await mkdir(artifactsDir, { recursive: true });
  await writeCoreArtifacts(artifactsDir, {
    repo_manifest: repoManifest,
    file_disposition: disposition,
    unit_manifest: unitManifest,
    surface_manifest: surfaceManifest,
    critical_flows: criticalFlows,
    flow_coverage: flowCoverage,
    coverage_matrix: coverage,
    runtime_validation_tasks: runtimeValidationTasks,
    runtime_validation_report: runtimeValidationReport,
    audit_results: sampleResults,
    audit_report: auditReport,
    audit_state: auditState,
  });
  console.log(
    JSON.stringify(
      { audit_state: auditState, artifacts_dir: artifactsDir },
      null,
      2,
    ),
  );
}

async function cmdAdvanceAudit(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  await cleanupStaleArtifactsDir(artifactsDir);
  await mkdir(artifactsDir, { recursive: true });
  await ensureSupervisorDirs(artifactsDir);
  let sessionConfig: SessionConfig;
  try {
    sessionConfig = await loadSessionConfig(artifactsDir);
  } catch (error) {
    await persistConfigErrorHandoff({
      root,
      artifactsDir,
      progressSummary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  const providerName = resolveRunProviderName(argv, sessionConfig);
  const batchResultsDir = getBatchResultsDir(argv);
  if (batchResultsDir && getFlag(argv, "--results")) {
    throw new Error("Use either --results <file> or --batch-results <dir>, not both.");
  }
  if (batchResultsDir) {
    const result = await ingestBatchAuditResults({
      root,
      artifactsDir,
      batchDir: batchResultsDir,
    });
    if (result.selected_executor !== "agent") {
      await clearDispatchFiles(artifactsDir);
    }
    await emitEnvelope({
      root,
      artifactsDir,
      bundle: result.bundle,
      audit_state: result.audit_state,
      selected_obligation: result.selected_obligation,
      selected_executor: result.selected_executor,
      progress_made: result.progress_made,
      artifacts_written: result.artifacts_written,
      progress_summary: result.progress_summary,
      next_likely_step: result.next_likely_step,
      providerName,
    });
    if (result.audit_state.status === "complete") {
      await promoteFinalAuditReport({ artifactsDir, repoRoot: root });
    }
    return;
  }
  const externalAnalyzerPath = getFlag(argv, "--external-analyzer-results");
  const result = await runAuditStep({
    root,
    artifactsDir,
    preferredExecutor:
      getFlag(argv, "--preferred-executor") ??
      (externalAnalyzerPath ? "external_analyzer_import_executor" : undefined),
    auditResultsPath: getFlag(argv, "--results"),
    runtimeUpdatesPath: getFlag(argv, "--updates"),
    externalAnalyzerPath,
    analyzers: sessionConfig.analyzers,
    graphLlmEdgeReasoning: sessionConfig.graph?.llm_edge_reasoning,
    since: getFlag(argv, "--since"),
    opentoken: sessionConfig.opentoken?.enabled,
    runLog: sessionConfig.observability?.run_log,
  });
  if (result.selected_executor !== "agent") {
    await clearDispatchFiles(artifactsDir);
  }
  await emitEnvelope({
    root,
    artifactsDir,
    bundle: result.updated_bundle,
    audit_state: result.audit_state,
    selected_obligation: result.selected_obligation,
    selected_executor: result.selected_executor,
    progress_made: result.progress_made,
    artifacts_written: result.artifacts_written,
    progress_summary: result.progress_summary,
    next_likely_step: result.next_likely_step,
    providerName,
  });
  if (result.audit_state.status === "complete") {
    await promoteFinalAuditReport({ artifactsDir, repoRoot: root });
  }
}

async function runDeterministicForNextStep(params: {
  root: string;
  artifactsDir: string;
  selfCliPath: string;
  timeoutMs: number;
  maxRuns: number;
  opentoken?: boolean;
  narrativeEnabled?: boolean;
  analyzers?: Record<string, AnalyzerSetting>;
  graphLlmEdgeReasoning?: boolean;
  since?: string;
}): Promise<
  | {
      kind: "semantic_review";
      state: AuditState;
      bundle: ArtifactBundle;
      activeReviewRun: ActiveReviewRun;
    }
  | {
      kind: "design_review";
      state: AuditState;
      bundle: ArtifactBundle;
    }
  | {
      kind: "analyzer_install";
      state: AuditState;
      bundle: ArtifactBundle;
      unresolved: AnalyzerPlanEntry[];
    }
  | {
      kind: "edge_reasoning";
      state: AuditState;
      bundle: ArtifactBundle;
      candidates: GraphEdge[];
    }
  | {
      kind: "synthesis_narrative";
      state: AuditState;
      bundle: ArtifactBundle;
    }
  | {
      kind: "complete";
      state: AuditState;
      bundle: ArtifactBundle;
      finalReportPath: string;
    }
  | {
      kind: "blocked";
      state: AuditState;
      bundle: ArtifactBundle;
      reason: string;
    }
> {
  let lastSummary = "";
  let analyzers = params.analyzers;
  for (let index = 0; index < params.maxRuns; index++) {
    const bundle = await loadArtifactBundle(params.artifactsDir);
    const decision = decideNextStep(bundle);
    const state = decision.state;

    if (state.status === "complete") {
      await writeHandoffOnly({
        root: params.root,
        artifactsDir: params.artifactsDir,
        bundle,
        audit_state: state,
        progress_summary: decision.reason,
        providerName: LOCAL_SUBPROCESS_PROVIDER_NAME,
      });
      const promoted = await promoteFinalAuditReport({
        artifactsDir: params.artifactsDir,
        repoRoot: params.root,
      });
      return {
        kind: "complete",
        state,
        bundle,
        finalReportPath: promoted.promoted
          ? join(params.root, AUDIT_REPORT_FILENAME)
          : join(params.artifactsDir, AUDIT_REPORT_FILENAME),
      };
    }

    if (index === 0 && bundle.repo_manifest) {
      const pendingTasks = buildPendingAuditTasks(bundle);
      const taskFiles = new Set<string>();
      for (const task of pendingTasks) {
        for (const fp of Object.keys(task.file_line_counts ?? {})) taskFiles.add(fp);
      }
      if (taskFiles.size > 0) {
        const integrity = await checkFileIntegrity(params.root, bundle.repo_manifest, [...taskFiles]);
        if (!integrity.is_clean) {
          console.log(
            `File integrity check: ${integrity.changed_files.length} changed, ${integrity.missing_files.length} missing — re-running intake.`,
          );
          await advanceAudit(bundle, { root: params.root, preferredExecutor: "intake_executor", opentoken: params.opentoken });
          continue;
        }
      }
    }

    if (decision.selected_executor === "graph_enrichment_executor") {
      const includedFiles = bundle.repo_manifest
        ? [
            ...new Set(
              buildPathLookup(
                bundle.repo_manifest,
                buildDispositionMap(bundle.file_disposition),
              ).values(),
            ),
          ]
        : [];
      const plan = resolveAnalyzerPlan(params.root, analyzers, includedFiles);
      const unresolved = plan.filter(needsInstallDecision);
      if (unresolved.length > 0) {
        const decisionsPath = join(
          params.artifactsDir,
          "incoming",
          "analyzer-decisions.json",
        );
        let decisions: Record<string, unknown> | undefined;
        try {
          decisions = await readJsonFile<Record<string, unknown>>(decisionsPath);
        } catch (error) {
          if (!isFileMissingError(error)) throw error;
        }
        if (decisions && typeof decisions === "object") {
          const settings: Record<string, AnalyzerSetting> = {};
          for (const [id, value] of Object.entries(decisions)) {
            if (
              value === "ephemeral" ||
              value === "permanent" ||
              value === "skip" ||
              value === "repo" ||
              value === "auto"
            ) {
              settings[id] = value;
            }
          }
          if (Object.keys(settings).length > 0) {
            const merged = await persistAnalyzerSettings(
              params.artifactsDir,
              settings,
            );
            analyzers = merged.analyzers;
          }
          await unlink(decisionsPath).catch(() => {});
          continue;
        }
        return {
          kind: "analyzer_install",
          state,
          bundle,
          unresolved,
        };
      }

      // Phase 4B — optional edge-reasoning producing turn. Once analyzer installs
      // are resolved, if the flag is on and the floor carries low-confidence
      // (< 0.65) edges, emit one bounded host turn (subagent dispatch or a single
      // host step) to produce reason rewrites, then re-run. The enrichment
      // executor applies the host-supplied rewrites in the SAME advanceAudit call
      // that merges analyzer edges and writes analyzer_capability, so graph_bundle
      // and its marker stay revision-consistent (no staleness loop). Flag off or
      // no candidates → fall through and run the executor with no rewrites.
      if (params.graphLlmEdgeReasoning === true && bundle.graph_bundle) {
        const candidates = collectLowConfidenceEdges(bundle.graph_bundle);
        if (candidates.length > 0) {
          const edgeReasoningResultsPath = join(
            params.artifactsDir,
            "incoming",
            "edge-reasoning.json",
          );
          let edgeReasoningResults: EdgeReasoningResults | undefined;
          try {
            edgeReasoningResults = await readJsonFile<EdgeReasoningResults>(
              edgeReasoningResultsPath,
            );
          } catch (error) {
            if (!isFileMissingError(error)) throw error;
          }
          if (edgeReasoningResults) {
            await runAuditStep({
              root: params.root,
              artifactsDir: params.artifactsDir,
              analyzers,
              graphLlmEdgeReasoning: true,
              edgeReasoningResultsPath,
              since: params.since,
              opentoken: params.opentoken,
            });
            await unlink(edgeReasoningResultsPath).catch(() => {});
            continue;
          }
          return { kind: "edge_reasoning", state, bundle, candidates };
        }
      }
      // No undecided installs (and no pending edge reasoning): fall through to run
      // the executor below (it installs for ephemeral/permanent, uses repo/cache,
      // skips the rest).
    }

    if (decision.selected_executor === "design_review") {
      const findingsPath = join(
        params.artifactsDir,
        "incoming",
        "design-review-findings.json",
      );
      let reviewFindings: Finding[] | undefined;
      try {
        reviewFindings = await readJsonFile<Finding[]>(findingsPath);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
      if (reviewFindings && Array.isArray(reviewFindings)) {
        const existing = bundle.design_assessment;
        if (existing) {
          existing.review_findings = reviewFindings;
          existing.reviewed = true;
          await writeJsonFile(
            join(params.artifactsDir, "design_assessment.json"),
            existing,
          );
          await unlink(findingsPath).catch(() => {});
          continue;
        }
      }
      return {
        kind: "design_review",
        state,
        bundle,
      };
    }

    if (decision.selected_executor === "synthesis_narrative_executor") {
      const narrativePath = join(
        params.artifactsDir,
        "incoming",
        "synthesis-narrative.json",
      );
      let narrativeResults: SynthesisNarrative | undefined;
      try {
        narrativeResults = await readJsonFile<SynthesisNarrative>(narrativePath);
      } catch (error) {
        if (!isFileMissingError(error)) throw error;
      }
      if (narrativeResults) {
        await runAuditStep({
          root: params.root,
          artifactsDir: params.artifactsDir,
          preferredExecutor: "synthesis_narrative_executor",
          narrativeResultsPath: narrativePath,
          opentoken: params.opentoken,
        });
        await unlink(narrativePath).catch(() => {});
        continue;
      }
      if (params.narrativeEnabled) {
        return {
          kind: "synthesis_narrative",
          state,
          bundle,
        };
      }
      // Narrative disabled: fall through so the deterministic omit runs below.
    }

    if (decision.selected_executor === "agent") {
      return {
        kind: "semantic_review",
        ...(await ensureSemanticReviewRun({
          root: params.root,
          artifactsDir: params.artifactsDir,
          bundle,
          state,
          obligationId: decision.selected_obligation,
          selfCliPath: params.selfCliPath,
          timeoutMs: params.timeoutMs,
        })),
      };
    }

    if (!decision.selected_executor) {
      await writeHandoffOnly({
        root: params.root,
        artifactsDir: params.artifactsDir,
        bundle,
        audit_state: state,
        progress_summary: lastSummary || decision.reason,
        providerName: LOCAL_SUBPROCESS_PROVIDER_NAME,
      });
      return {
        kind: "blocked",
        state,
        bundle,
        reason: lastSummary || decision.reason,
      };
    }

    let result: AdvanceAuditResult;
    try {
      result = await runAuditStep({
        root: params.root,
        artifactsDir: params.artifactsDir,
        analyzers,
        graphLlmEdgeReasoning: params.graphLlmEdgeReasoning,
        since: params.since,
        opentoken: params.opentoken,
      });
    } catch (error) {
      const current = await loadArtifactBundle(params.artifactsDir);
      const currentState = deriveAuditState(current);
      currentState.last_executor = decision.selected_executor ?? undefined;
      currentState.last_obligation = decision.selected_obligation ?? undefined;
      await writeCoreArtifacts(params.artifactsDir, { ...current, audit_state: currentState });
      await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
        iteration: index + 1,
        max_runs: params.maxRuns,
        last_executor: decision.selected_executor,
        last_obligation: decision.selected_obligation,
        prior_summary: lastSummary || null,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Deterministic executor ${decision.selected_executor} failed on obligation ${decision.selected_obligation} (iteration ${index + 1}/${params.maxRuns}, prior progress: ${lastSummary || "none"}): ${detail}`,
        { cause: error instanceof Error ? error : undefined },
      );
    }
    lastSummary = result.progress_summary;
    await writeJsonFile(join(params.artifactsDir, "steps", "deterministic-progress.json"), {
      iteration: index + 1,
      max_runs: params.maxRuns,
      last_executor: result.selected_executor,
      last_obligation: decision.selected_obligation,
      progress_made: result.progress_made,
      summary: result.progress_summary,
      timestamp: new Date().toISOString(),
    });
    if (result.selected_executor !== "agent") {
      await clearDispatchFiles(params.artifactsDir);
    }
    if (!result.progress_made) {
      return {
        kind: "blocked",
        state: result.audit_state,
        bundle: result.updated_bundle,
        reason: result.progress_summary,
      };
    }
  }

  const bundle = await loadArtifactBundle(params.artifactsDir);
  const state = deriveAuditState(bundle);
  return {
    kind: "blocked",
    state,
    bundle,
    reason: `Reached max run limit (${params.maxRuns}) before a review, report, or blocker step was ready.`,
  };
}

// Renders the actionable semantic-review step (packet dispatch or single-task
// fallback) and writes steps/current-step.json. Shared by next-step and
// run-to-completion so the backend produces the actionable step itself rather
// than handing the host a second command. Host dispatch capability is resolved
// by the caller (flag -> session config -> env -> default true) and is never
// required from the host to make progress.
async function renderSemanticReviewStep(params: {
  root: string;
  artifactsDir: string;
  activeReviewRun: ActiveReviewRun;
  hostCanDispatch: boolean;
  hostMaxActiveSubagents: number | null;
  hostCanRestrictSubagentTools: boolean;
  hostCanSelectSubagentModel: boolean;
}): Promise<Awaited<ReturnType<typeof writeCurrentStep>>> {
  const { root, artifactsDir, activeReviewRun } = params;
  if (!params.hostCanDispatch) {
    const singleTaskPromptPath = join(
      artifactsDir,
      "dispatch",
      "current-single-task-prompt.md",
    );
    const workerCommand = renderCommand(activeReviewRun.worker_command);
    return writeCurrentStep({
      artifactsDir,
      stepKind: "single_task_fallback",
      status: "ready",
      runId: activeReviewRun.run_id,
      allowedCommands: [workerCommand],
      stopCondition:
        "Run the exact worker_command after one result, then stop without looping.",
      repoRoot: root,
      artifactPaths: {
        active_review_task: activeReviewRun.task_path,
        active_review_prompt: activeReviewRun.prompt_path,
        pending_audit_tasks: activeReviewRun.pending_audit_tasks_path ?? null,
        audit_results: activeReviewRun.audit_results_path,
        single_task_prompt: singleTaskPromptPath,
      },
      prompt: renderSingleTaskFallbackStepPrompt({
        singleTaskPromptPath,
        activeReviewRun,
      }),
      access: {
        read_paths: [singleTaskPromptPath],
        write_paths: [activeReviewRun.audit_results_path],
      },
    });
  }

  const sessionConfig = await loadSessionConfig(artifactsDir).catch(
    () => ({} as SessionConfig),
  );
  const provider = createFreshSessionProvider(undefined, sessionConfig);
  const dispatch = await prepareDispatchArtifacts({
    packageRoot,
    runId: activeReviewRun.run_id,
    artifactsDir,
    root,
    sessionConfig,
    hostModel: sessionConfig.block_quota?.host_model ?? null,
    queryLimits: provider.queryLimits?.bind(provider),
    hostActiveSubagentLimit: params.hostMaxActiveSubagents,
  });
  const mergeCommand = mergeAndIngestCommand(artifactsDir, activeReviewRun.run_id);
  const continueCommand = nextStepCommand(root, artifactsDir);
  return writeCurrentStep({
    artifactsDir,
    stepKind: "dispatch_review",
    status: "ready",
    runId: activeReviewRun.run_id,
    allowedCommands: [mergeCommand, continueCommand],
    allowedMcpTools: ["auditor_merge_and_ingest", "auditor_continue_audit"],
    progress: {
      summary:
        `Dispatching ${dispatch.packet_count} review packet(s) covering ` +
        `${dispatch.task_count} task(s) in waves of ${dispatch.wave_size}` +
        (dispatch.skipped_task_count > 0
          ? `; ${dispatch.skipped_task_count} task(s) already completed.`
          : "."),
      pending_packets: dispatch.packet_count,
      pending_tasks: dispatch.task_count,
      completed_tasks: dispatch.skipped_task_count,
      wave_size: dispatch.wave_size,
    },
    stopCondition:
      "Dispatch every packet, run merge-and-ingest once, then run next-step.",
    repoRoot: root,
    artifactPaths: {
      dispatch_plan: dispatch.dispatch_plan_path,
      dispatch_quota: dispatch.dispatch_quota_path,
      dispatch_warnings: dispatch.dispatch_warnings_path,
      active_review_task: activeReviewRun.task_path,
      pending_audit_tasks: activeReviewRun.pending_audit_tasks_path ?? null,
    },
    prompt: renderDispatchReviewPrompt({
      root,
      artifactsDir,
      activeReviewRun,
      dispatchPlanPath: dispatch.dispatch_plan_path,
      dispatchQuotaPath: dispatch.dispatch_quota_path,
      hostCanRestrictSubagentTools: params.hostCanRestrictSubagentTools,
      hostCanSelectSubagentModel: params.hostCanSelectSubagentModel,
    }),
    access: {
      read_paths: [
        dispatch.dispatch_plan_path,
        ...(dispatch.dispatch_quota_path ? [dispatch.dispatch_quota_path] : []),
      ],
      write_paths: [],
    },
  });
}

async function cmdNextStep(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  await mkdir(artifactsDir, { recursive: true });
  await ensureSupervisorDirs(artifactsDir);

  const hostCanDispatchSubagents = getOptionalBooleanFlag(
    argv,
    "--host-can-dispatch-subagents",
  );
  const hostCanRestrictSubagentTools =
    getOptionalBooleanFlag(argv, "--host-can-restrict-subagent-tools") ??
    false;
  const hostCanSelectSubagentModel =
    getOptionalBooleanFlag(argv, "--host-can-select-subagent-model") ?? false;
  const hostMaxActiveSubagents = getHostMaxActiveSubagents(argv);
  let sessionConfig: SessionConfig;
  try {
    sessionConfig = await loadSessionConfig(artifactsDir);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await persistConfigErrorHandoff({
      root,
      artifactsDir,
      progressSummary: reason,
    });
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "blocked",
      status: "blocked",
      runId: null,
      allowedCommands: [],
      stopCondition: "Report the configuration blocker and stop.",
      repoRoot: root,
      artifactPaths: {
        operator_handoff: join(artifactsDir, "operator-handoff.json"),
      },
      prompt: renderBlockedStepPrompt(reason),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  const hostCanDispatch = resolveHostDispatchCapability({
    explicit: hostCanDispatchSubagents,
    sessionConfig,
  });

  const result = await runDeterministicForNextStep({
    root,
    artifactsDir,
    selfCliPath: resolve(argv[1] ?? process.argv[1] ?? ""),
    timeoutMs: getTimeoutMs(argv, sessionConfig),
    maxRuns: getMaxRuns(argv),
    opentoken: sessionConfig.opentoken?.enabled,
    narrativeEnabled: sessionConfig.synthesis?.narrative !== false,
    analyzers: sessionConfig.analyzers,
    graphLlmEdgeReasoning: sessionConfig.graph?.llm_edge_reasoning,
    since: getFlag(argv, "--since"),
  });

  if (result.kind === "complete") {
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "present_report",
      status: "complete",
      runId: null,
      allowedCommands: [],
      stopCondition: "Present the final report and stop.",
      repoRoot: root,
      artifactPaths: {
        final_report: result.finalReportPath,
      },
      prompt: renderPresentReportPrompt(result.finalReportPath),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "blocked") {
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "blocked",
      status: "blocked",
      runId: null,
      allowedCommands: [],
      stopCondition: "Report the blocker and stop.",
      repoRoot: root,
      artifactPaths: {
        operator_handoff: join(artifactsDir, "operator-handoff.json"),
      },
      prompt: renderBlockedStepPrompt(result.reason),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "design_review") {
    const designReviewResultsPath = join(
      artifactsDir,
      "incoming",
      "design-review-findings.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const prompt = renderDesignReviewPrompt(result.bundle);
    const fullPrompt = [
      prompt,
      "## Results path",
      "",
      `Write the JSON array of findings to:`,
      "",
      `  ${designReviewResultsPath}`,
      "",
      `Then run: ${continueCommand}`,
      "",
    ].join("\n");
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "design_review",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write design review findings to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        design_review_results: designReviewResultsPath,
      },
      prompt: fullPrompt,
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "analyzer_install") {
    const decisionsPath = join(
      artifactsDir,
      "incoming",
      "analyzer-decisions.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "analyzer_install",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write analyzer install decisions to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        analyzer_decisions: decisionsPath,
      },
      prompt: renderAnalyzerInstallPrompt({
        unresolved: result.unresolved,
        decisionsPath,
        continueCommand,
      }),
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "edge_reasoning") {
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const edgeReasoningResultsPath = join(
      artifactsDir,
      "incoming",
      "edge-reasoning.json",
    );
    const continueCommand = nextStepCommand(root, artifactsDir);
    const basePrompt = buildEdgeReasoningPrompt(result.candidates);
    const contentHash = edgeReasoningContentHash(result.candidates);

    if (hostCanDispatch) {
      // Dispatch path: isolate the (potentially large) edge-list prompt in a file
      // and have the host fan it out to one subagent, mirroring the packet review
      // dispatch contract. The subagent writes the rewrites file; next-step applies.
      const edgeReasoningPromptPath = join(
        artifactsDir,
        "incoming",
        "edge-reasoning-prompt.md",
      );
      await writeFile(edgeReasoningPromptPath, basePrompt, "utf8");
      const step = await writeCurrentStep({
        artifactsDir,
        stepKind: "edge_reasoning_dispatch",
        status: "ready",
        runId: null,
        allowedCommands: [continueCommand],
        stopCondition:
          "Dispatch one subagent to write the edge-reasoning rewrites, then run next-step.",
        repoRoot: root,
        artifactPaths: {
          edge_reasoning_prompt: edgeReasoningPromptPath,
          edge_reasoning_results: edgeReasoningResultsPath,
        },
        prompt: renderEdgeReasoningDispatchPrompt({
          promptPath: edgeReasoningPromptPath,
          resultsPath: edgeReasoningResultsPath,
          continueCommand,
          contentHash,
          candidateCount: result.candidates.length,
        }),
        access: {
          read_paths: [edgeReasoningPromptPath],
          write_paths: [edgeReasoningResultsPath],
        },
      });
      console.log(JSON.stringify(step, null, 2));
      return;
    }

    // One-step fallback (no callable subagent facility): the host produces the
    // rewrites itself in a single bounded turn, mirroring the narrative step.
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "edge_reasoning",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write the edge-reasoning rewrites to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        edge_reasoning_results: edgeReasoningResultsPath,
      },
      prompt: renderEdgeReasoningStepPrompt({
        basePrompt,
        resultsPath: edgeReasoningResultsPath,
        continueCommand,
        contentHash,
      }),
      access: {
        read_paths: [],
        write_paths: [edgeReasoningResultsPath],
      },
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  if (result.kind === "synthesis_narrative") {
    const narrativeResultsPath = join(
      artifactsDir,
      "incoming",
      "synthesis-narrative.json",
    );
    await mkdir(join(artifactsDir, "incoming"), { recursive: true });
    const continueCommand = nextStepCommand(root, artifactsDir);
    const basePrompt = result.bundle.audit_findings
      ? renderSynthesisNarrativePrompt(result.bundle.audit_findings)
      : "# Synthesis narrative\n\nNo findings report is available; write an empty themes array.";
    const fullPrompt = [
      basePrompt,
      "## Results path",
      "",
      "Write the SynthesisNarrative JSON object to:",
      "",
      `  ${narrativeResultsPath}`,
      "",
      `Then run: ${continueCommand}`,
      "",
    ].join("\n");
    const step = await writeCurrentStep({
      artifactsDir,
      stepKind: "synthesis_narrative",
      status: "ready",
      runId: null,
      allowedCommands: [continueCommand],
      stopCondition:
        "Write the synthesis narrative to the results path, then run next-step.",
      repoRoot: root,
      artifactPaths: {
        synthesis_narrative_results: narrativeResultsPath,
      },
      prompt: fullPrompt,
    });
    console.log(JSON.stringify(step, null, 2));
    return;
  }

  const step = await renderSemanticReviewStep({
    root,
    artifactsDir,
    activeReviewRun: result.activeReviewRun,
    hostCanDispatch,
    hostMaxActiveSubagents,
    hostCanRestrictSubagentTools,
    hostCanSelectSubagentModel,
  });
  console.log(JSON.stringify(step, null, 2));
}

async function cmdRunToCompletion(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  await cleanupStaleArtifactsDir(artifactsDir);
  await mkdir(artifactsDir, { recursive: true });
  await ensureSupervisorDirs(artifactsDir);
  let sessionConfig: SessionConfig;
  try {
    sessionConfig = await loadSessionConfig(artifactsDir);
  } catch (error) {
    await persistConfigErrorHandoff({
      root,
      artifactsDir,
      progressSummary: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
const explicitProvider = getExplicitProvider(argv);
  const provider = createFreshSessionProvider(
    explicitProvider,
    sessionConfig,
  );
  const uiMode = getUiMode(argv, sessionConfig.ui_mode ?? "headless");
  const maxRuns = getMaxRuns(argv);
  const agentBatchSize = getAgentBatchSize(argv, sessionConfig);
  const parallelWorkers = getParallelWorkers(argv, sessionConfig);
  const timeoutMs = getTimeoutMs(argv, sessionConfig);
  const hostModel = getHostModel(argv);
  const selfCliPath = resolve(argv[1] ?? process.argv[1] ?? "");
  const batchResultsDir = getBatchResultsDir(argv);
  if (batchResultsDir && getFlag(argv, "--results")) {
    throw new Error("Use either --results <file> or --batch-results <dir>, not both.");
  }
  let pendingBatchAuditResults = batchResultsDir
    ? await listBatchResultFiles(batchResultsDir)
    : [];

  let pendingAuditResultsPath = getFlag(argv, "--results");
  let pendingRuntimeUpdatesPath = getFlag(argv, "--updates");
  let pendingExternalAnalyzerPath = getFlag(
    argv,
    "--external-analyzer-results",
  );
  let runCount = 0;
  let deepeningCycles = 0;
  const MAX_DEEPENING_CYCLES = 3;
  let anyProgress = false;
  let lastResult: WorkerResult | null = null;
  const artifactsWritten = new Set<string>();

  while (runCount < maxRuns) {
    const bundle = await loadArtifactBundle(artifactsDir);
    const decision = decideNextStep(bundle);

    // Resume interrupted parallel wave: ingest any results that workers
    // wrote before the previous process exited.
    const priorWave = await readWaveManifest(artifactsDir);
    if (priorWave) {
      process.stderr.write(
        `[audit-code] Recovering interrupted wave (${priorWave.slots.length} slot(s), obligation ${priorWave.obligation_id}).\n`,
      );
      let recoveredProgress = false;
      for (const entry of priorWave.slots) {
        try {
          const results = await readJsonFile<AuditResult[]>(entry.audit_results_path);
          if (!results || results.length === 0) continue;
          const stepResult = await runAuditStep({
            root,
            artifactsDir,
            preferredExecutor: "result_ingestion_executor",
            auditResultsPath: entry.audit_results_path,
          });
          if (stepResult.progress_made) {
            recoveredProgress = true;
            anyProgress = true;
            for (const a of stepResult.artifacts_written) artifactsWritten.add(a);
          }
        } catch {
          process.stderr.write(`[audit-code] Skipping unreadable results for ${entry.run_id}.\n`);
        }
      }
      await removeWaveManifest(artifactsDir);
      if (recoveredProgress) continue;
    }

    if (
      decision.selected_executor === "agent" &&
      bundle.audit_tasks?.some(
        (t) =>
          t.tags?.includes("selective_deepening") &&
          t.status !== "complete",
      ) &&
      !bundle.audit_tasks?.some(
        (t) =>
          !t.tags?.includes("selective_deepening") &&
          t.status !== "complete",
      )
    ) {
      deepeningCycles++;
      if (deepeningCycles > MAX_DEEPENING_CYCLES) {
        process.stderr.write(
          `[audit-code] Reached max deepening cycles (${MAX_DEEPENING_CYCLES}). Stopping to prevent churn.\n`,
        );
        break;
      }
    }

    let preferredExecutor = decision.selected_executor;
    let obligationId = decision.selected_obligation;
    let auditResultsPath: string | undefined;
    let runtimeUpdatesPath: string | undefined;
    let externalAnalyzerPath: string | undefined;

    if (pendingExternalAnalyzerPath) {
      preferredExecutor = "external_analyzer_import_executor";
      obligationId = "external_analyzer_import";
      externalAnalyzerPath = pendingExternalAnalyzerPath;
    } else if (pendingBatchAuditResults.length > 0 && bundle.coverage_matrix) {
      preferredExecutor = "result_ingestion_executor";
      obligationId = "audit_results_ingested";
      auditResultsPath = pendingBatchAuditResults[0];
    } else if (pendingAuditResultsPath && bundle.coverage_matrix) {
      preferredExecutor = "result_ingestion_executor";
      obligationId = "audit_results_ingested";
      auditResultsPath = pendingAuditResultsPath;
    } else if (pendingRuntimeUpdatesPath && bundle.runtime_validation_tasks) {
      preferredExecutor = "runtime_validation_update_executor";
      obligationId = "runtime_validation_current";
      runtimeUpdatesPath = pendingRuntimeUpdatesPath;
    }

    if (preferredExecutor === "agent" && provider.name === LOCAL_SUBPROCESS_PROVIDER_NAME) {
      const blocker = buildManualReviewBlocker(provider.name);
      const blockedState = buildBlockedAuditState({
        state: decision.state,
        obligationId,
        executor: preferredExecutor,
        blocker,
      });
      await writeCoreArtifacts(artifactsDir, {
        ...bundle,
        audit_state: blockedState,
      });

      const blockRunId = buildRunId(obligationId, runCount + 1);
      const blockPaths = getRunPaths(artifactsDir, blockRunId);
      const blockPendingTasks = await addFileLineCountHints(
        root,
        buildPendingAuditTasks(bundle),
      );
      const blockPendingTasksPath = join(blockPaths.runDir, "pending-audit-tasks.json");
      const blockAuditResultsPath = join(blockPaths.runDir, "audit-results.json");
      const blockReadPaths = new Set<string>();
      for (const pt of blockPendingTasks) {
        for (const fp of pt.file_paths) blockReadPaths.add(fp);
      }
      const blockTask: WorkerTask = {
        contract_version: "audit-code-worker/v1alpha1",
        run_id: blockRunId,
        repo_root: root,
        artifacts_dir: artifactsDir,
        obligation_id: obligationId,
        preferred_executor: preferredExecutor,
        result_path: blockPaths.resultPath,
        worker_command: [
          process.execPath,
          selfCliPath,
          "worker-run",
          "--task",
          blockPaths.taskPath,
        ],
        audit_results_path: blockAuditResultsPath,
        pending_audit_tasks_path: blockPendingTasksPath,
        timeout_ms: timeoutMs,
        max_retries: 0,
        access: {
          read_paths: [...blockReadPaths],
          write_paths: [blockAuditResultsPath, blockPaths.resultPath],
        },
      };
      const blockPrompt = renderWorkerPrompt(blockTask);
      await writeWorkerTaskFiles(
        blockTask,
        blockPrompt,
        blockPaths,
        artifactsDir,
        blockPendingTasks,
      );
      await writeJsonFile(blockPendingTasksPath, blockPendingTasks);

      const reviewRun: ActiveReviewRun = {
        run_id: blockRunId,
        task_path: blockPaths.taskPath,
        prompt_path: blockPaths.promptPath,
        pending_audit_tasks_path: blockPendingTasksPath,
        audit_results_path: blockAuditResultsPath,
        worker_command: blockTask.worker_command,
      };
      // Render the actionable dispatch / single-task step here instead of
      // leaving the host to issue next-step as a second command. Capability is
      // resolved from flags/config/env with a sane default, so nothing is
      // required from the host to make progress. If rendering fails we still
      // emit the hand-off below — run-to-completion is never worse than before,
      // and next-step will re-render and surface the error loudly.
      try {
        await renderSemanticReviewStep({
          root,
          artifactsDir,
          activeReviewRun: reviewRun,
          hostCanDispatch: resolveHostDispatchCapability({
            explicit: getOptionalBooleanFlag(
              argv,
              "--host-can-dispatch-subagents",
            ),
            sessionConfig,
          }),
          hostMaxActiveSubagents: getHostMaxActiveSubagents(argv),
          hostCanRestrictSubagentTools:
            getOptionalBooleanFlag(
              argv,
              "--host-can-restrict-subagent-tools",
            ) ?? false,
          hostCanSelectSubagentModel:
            getOptionalBooleanFlag(
              argv,
              "--host-can-select-subagent-model",
            ) ?? false,
        });
      } catch (stepError) {
        process.stderr.write(
          `[audit-code] Could not pre-render the review step; the operator hand-off points to next-step instead. ${
            stepError instanceof Error ? stepError.message : String(stepError)
          }\n`,
        );
      }

      await emitEnvelope({
        root,
        artifactsDir,
        bundle: {
          ...bundle,
          audit_state: blockedState,
        },
        audit_state: blockedState,
        selected_obligation: obligationId,
        selected_executor: preferredExecutor,
        progress_made: anyProgress,
        artifacts_written: Array.from(
          new Set([...artifactsWritten, "audit_state.json"]),
        ),
        progress_summary: blocker,
        next_likely_step: null,
        providerName: provider.name,
        activeReviewRun: reviewRun,
      });
      return;
    }

    if (!preferredExecutor) {
      const state = decision.state;
      await clearDispatchFiles(artifactsDir);
      await emitEnvelope({
        root,
        artifactsDir,
        bundle,
        audit_state: state,
        selected_obligation: anyProgress
          ? (lastResult?.obligation_id ?? null)
          : null,
        selected_executor: anyProgress
          ? (lastResult?.selected_executor ?? null)
          : null,
        progress_made: anyProgress,
        artifacts_written: Array.from(artifactsWritten),
        progress_summary:
          anyProgress && state.status === "complete"
            ? `Completed audit in ${runCount} fresh worker runs.`
            : decision.reason,
        next_likely_step:
          state.status === "complete" ? null : decision.selected_obligation,
        providerName: provider.name,
      });
      if (state.status === "complete") {
        await promoteFinalAuditReport({ artifactsDir, repoRoot: root });
      }
      return;
    }

    if (preferredExecutor === "agent" && parallelWorkers > 1) {
      const quotaState = await readQuotaState();
      const providerModelKey = buildProviderModelKey(provider.name, hostModel);
      const quotaStateEntry = quotaState.entries[providerModelKey] ?? null;
      const allCandidateTasks = buildPendingAuditTasks(bundle);
      const candidateGroups = chunkArray(
        allCandidateTasks.slice(0, parallelWorkers * agentBatchSize),
        agentBatchSize,
      );
      const candidateSizeIndex = sizeIndexFromManifest(bundle.repo_manifest);
      const slotTokenEstimates = candidateGroups.map((g) =>
        estimateTaskGroupTokens(g, candidateSizeIndex),
      );

      const providerLimits: DiscoveredRateLimits | null =
        await provider.queryLimits?.(hostModel)
          .then((r) => r ? { ...r, source: "provider_query" } : null)
          .catch(() => null)
        ?? null;
      const cachedLimits = await lookupDiscoveredLimits(providerModelKey).catch(() => null);
      const discoveredLimits = mergeDiscoveredLimits(providerLimits, cachedLimits);

      const halfLifeHours = sessionConfig.quota?.empirical_half_life_hours ?? 24;
      const quotaSource = buildQuotaSource({ halfLifeHours });
      const quotaSourceSnapshot = await quotaSource.queryCurrentUsage(providerModelKey).catch(() => null);

      const hostConcurrencyLimit = resolveHostActiveSubagentLimit({
        sessionConfig,
      });

      const waveSchedule = scheduleWave({
        providerName: resolveFreshSessionProviderName(getExplicitProvider(argv), sessionConfig),
        sessionConfig,
        hostModel,
        requestedConcurrency: parallelWorkers,
        estimatedSlotTokens: slotTokenEstimates,
        quotaStateEntry,
        hostConcurrencyLimit,
        quotaSourceSnapshot,
        discoveredLimits,
      });
      const waveSize = waveSchedule.wave_size;

      if (waveSchedule.cooldown_until) {
        const waitMs = new Date(waveSchedule.cooldown_until).getTime() - Date.now();
        if (waitMs > 0) {
          const cappedWait = Math.min(waitMs, 120_000);
          process.stderr.write(
            `[quota] Cooldown active — waiting ${Math.ceil(cappedWait / 1000)}s before next wave.\n`,
          );
          await new Promise<void>((r) => setTimeout(r, cappedWait));
        }
      }

      const taskGroups = candidateGroups.slice(0, waveSize);

      interface WorkerSlot {
        runId: string;
        paths: RunPaths;
        auditResultsPath: string;
        pendingTasksPath: string;
        group: AuditTask[];
      }

      const workerSlots: WorkerSlot[] = [];
      for (const rawGroup of taskGroups) {
        const group = await addFileLineCountHints(root, rawGroup);
        runCount += 1;
        const slotRunId = buildRunId(obligationId, runCount);
        const slotPaths = getRunPaths(artifactsDir, slotRunId);
        const slotAuditResultsPath = join(slotPaths.runDir, "audit-results.json");
        const slotPendingTasksPath = join(slotPaths.runDir, "pending-audit-tasks.json");
        const slotReadPaths = new Set<string>();
        for (const t of group) {
          for (const fp of t.file_paths) slotReadPaths.add(fp);
        }
        const slotTask: WorkerTask = {
          contract_version: "audit-code-worker/v1alpha1",
          run_id: slotRunId,
          repo_root: root,
          artifacts_dir: artifactsDir,
          obligation_id: obligationId,
          preferred_executor: "agent",
          result_path: slotPaths.resultPath,
          worker_command: [process.execPath, selfCliPath, "worker-run", "--task", slotPaths.taskPath],
          audit_results_path: slotAuditResultsPath,
          pending_audit_tasks_path: slotPendingTasksPath,
          worker_command_mode: "deferred",
          timeout_ms: timeoutMs,
          max_retries: 0,
          access: {
            read_paths: [...slotReadPaths],
            write_paths: [slotAuditResultsPath, slotPaths.resultPath],
          },
        };
        const slotPrompt = renderWorkerPrompt(slotTask);
        await writeWorkerTaskFiles(
          slotTask,
          slotPrompt,
          slotPaths,
          artifactsDir,
          group,
          { updateDispatch: false },
        );
        await writeJsonFile(slotPendingTasksPath, group);
        workerSlots.push({ runId: slotRunId, paths: slotPaths, auditResultsPath: slotAuditResultsPath, pendingTasksPath: slotPendingTasksPath, group });
      }
      await writeDispatchBatchFiles(
        artifactsDir,
        workerSlots.map((slot) => ({
          run_id: slot.runId,
          task_path: slot.paths.taskPath,
          prompt_path: slot.paths.promptPath,
          result_path: slot.paths.resultPath,
          status_path: slot.paths.statusPath,
          audit_results_path: slot.auditResultsPath,
          pending_audit_tasks_path: slot.pendingTasksPath,
        })),
        workerSlots.flatMap((slot) => slot.group),
      );

      const parallelStartedAt = new Date().toISOString();

      await writeWaveManifest(artifactsDir, {
        obligation_id: obligationId ?? "unknown",
        started_at: parallelStartedAt,
        pid: process.pid,
        slots: workerSlots.map(buildWaveSlotEntry),
      });

      const { results: launchResults } = await runSlidingWindow(
        workerSlots.map((slot) => () =>
          provider.launch({
            repoRoot: root,
            runId: slot.runId,
            obligationId,
            promptPath: slot.paths.promptPath,
            taskPath: slot.paths.taskPath,
            resultPath: slot.paths.resultPath,
            stdoutPath: slot.paths.stdoutPath,
            stderrPath: slot.paths.stderrPath,
            uiMode,
            timeoutMs,
          }),
        ),
        waveSize,
      );
      const launchErrorsByRunId = new Map<string, string>();
      for (let index = 0; index < launchResults.length; index++) {
        const outcome = launchResults[index];
        if (outcome?.status === "rejected") {
          launchErrorsByRunId.set(
            workerSlots[index].runId,
            outcome.reason instanceof Error
              ? outcome.reason.message
              : String(outcome.reason),
          );
        } else if (outcome?.status === "fulfilled") {
          const launchExitSummary = summarizeLaunchExit(outcome.value);
          if (launchExitSummary) {
            launchErrorsByRunId.set(workerSlots[index].runId, launchExitSummary);
          }
        }
      }

      // Result ingestion is intentionally sequential even though agent launch
      // was parallel. Writing to coverage_matrix.json is not atomic, so
      // concurrent ingest calls would race and corrupt coverage state.
      let batchProgress = false;
      const batchErrors: string[] = [];
      for (const slot of workerSlots) {
        const parallelEndedAt = new Date().toISOString();
        let workerResult = buildWorkerResult({
          runId: slot.runId,
          obligationId,
          status: "no_progress",
          progressMade: false,
          selectedExecutor: "agent",
          artifactsWritten: [],
          summary: "Parallel worker batch made no progress.",
          nextLikelyStep: obligationId,
          errors: [],
        });

        try {
          const launchError = launchErrorsByRunId.get(slot.runId);
          if (launchError) {
            throw new Error(`Worker launch failed: ${launchError}`);
          }

          const auditResults = await readJsonFile<AuditResult[]>(slot.auditResultsPath);
          const pendingTaskIds = new Set(slot.group.map((t) => t.task_id));
          const matchedCount = auditResults.filter((r) => pendingTaskIds.has(r.task_id)).length;

          if (slot.group.length > 0 && matchedCount === 0) {
            throw new Error("Worker did not emit any audit results for the assigned tasks.");
          }

          const issues = validateAuditResults(auditResults, slot.group, {
            lineIndex: await buildLineIndexForPaths(
              root,
              slot.group.flatMap((task) => task.file_paths),
            ),
          });
          const errors = issues.filter((issue) => issue.severity === "error");
          const warnings = issues.filter((issue) => issue.severity === "warning");

          if (warnings.length > 0) {
            process.stderr.write(
              `audit-results validation: ${warnings.length} warning(s) for ${slot.runId}:\n` +
                formatAuditResultIssues(warnings) + "\n",
            );
          }
          if (errors.length > 0) {
            throw new Error(
              `audit-results validation failed with ${errors.length} error(s):\n` +
                formatAuditResultIssues(errors),
            );
          }

          const stepResult = await runAuditStep({
            root,
            artifactsDir,
            preferredExecutor: "result_ingestion_executor",
            auditResultsPath: slot.auditResultsPath,
          });

          workerResult = buildWorkerResult({
            runId: slot.runId,
            obligationId,
            status: stepResult.progress_made ? "completed" : "no_progress",
            progressMade: stepResult.progress_made,
            selectedExecutor: stepResult.selected_executor,
            artifactsWritten: stepResult.artifacts_written,
            summary: stepResult.progress_summary,
            nextLikelyStep: stepResult.next_likely_step,
            errors: [],
          });
          batchProgress ||= stepResult.progress_made;
          if (stepResult.progress_made) anyProgress = true;
          for (const a of stepResult.artifacts_written) artifactsWritten.add(a);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          batchErrors.push(`${slot.runId}: ${message}`);
          workerResult = buildWorkerResult({
            runId: slot.runId,
            obligationId,
            status: "failed",
            progressMade: false,
            selectedExecutor: "agent",
            artifactsWritten: [],
            summary: `Worker failed for executor agent: ${message}`,
            nextLikelyStep: obligationId,
            errors: [message],
          });
          process.stderr.write(`[agent-batch] ${slot.runId} failed: ${message}\n`);
        }
        await persistWorkerRunArtifacts(
          slot.paths,
          workerResult,
          "parallel-deferred-agent",
        );

        await appendRunLedgerEntry(artifactsDir, {
          run_id: slot.runId,
          provider: provider.name,
          obligation_id: obligationId,
          selected_executor: workerResult.selected_executor,
          status: workerResult.status,
          started_at: parallelStartedAt,
          ended_at: parallelEndedAt,
          result_path: slot.paths.resultPath,
        });
        artifactsWritten.add("run-ledger.json");
      }

      // Record outcome for adaptive learning (best-effort — never blocks dispatch)
      {
        const rateLimitResults = batchErrors.map((e) => detectRateLimitError(e));
        const rateLimitHit = rateLimitResults.find((r) => r.isRateLimited);
        const retryAfterMs = rateLimitHit?.retryAfterMs ?? null;
        await recordWaveOutcome(
          providerModelKey,
          {
            concurrency: workerSlots.length,
            estimated_tokens: slotTokenEstimates.slice(0, workerSlots.length).reduce((a, b) => a + b, 0),
            outcome: rateLimitHit ? "rate_limited" : batchErrors.length > 0 ? "timeout" : "success",
            cooldown_until: rateLimitHit ? computeCooldownUntil(retryAfterMs) : null,
          },
          sessionConfig.quota?.empirical_half_life_hours ?? 24,
        ).catch(() => undefined);
      }

      // Extract rate-limit headers from worker stderr (best-effort)
      {
        const extractor = getHeaderExtractorForProvider(provider.name);
        for (const slot of workerSlots) {
          try {
            const stderr = await readFile(slot.paths.stderrPath, "utf8");
            const extracted = extractor.extract(stderr);
            if (extracted && (extracted.requests_per_minute != null || extracted.input_tokens_per_minute != null)) {
              await updateDiscoveredLimits(providerModelKey, {
                requests_per_minute: extracted.requests_per_minute,
                input_tokens_per_minute: extracted.input_tokens_per_minute,
                source: "header_extraction",
              });
              break; // one successful extraction is enough
            }
          } catch {
            // stderr file missing or unreadable — skip
          }
        }
      }

      await removeWaveManifest(artifactsDir);

      if (batchErrors.length > 0) {
        const bundleAfter = await loadArtifactBundle(artifactsDir);
        const blockedState = buildBlockedAuditState({
          state: bundleAfter.audit_state ?? deriveAuditState(bundleAfter),
          obligationId,
          executor: "agent",
          blocker:
            `Parallel worker batch failed for ${batchErrors.length} run(s). ` +
            batchErrors.slice(0, 3).join(" | "),
        });
        await writeCoreArtifacts(artifactsDir, {
          ...bundleAfter,
          audit_state: blockedState,
        });
        await emitEnvelope({
          root,
          artifactsDir,
          bundle: { ...bundleAfter, audit_state: blockedState },
          audit_state: blockedState,
          selected_obligation: obligationId,
          selected_executor: "agent",
          progress_made: anyProgress,
          artifacts_written: Array.from(
            new Set([...artifactsWritten, "audit_state.json"]),
          ),
          progress_summary:
            `Parallel worker batch failed for ${batchErrors.length} run(s).\n` +
            batchErrors.join("\n"),
          next_likely_step: null,
          providerName: provider.name,
        });
        return;
      }

      if (!batchProgress) {
        const bundleAfter = await loadArtifactBundle(artifactsDir);
        const state = bundleAfter.audit_state ?? deriveAuditState(bundleAfter);
        await emitEnvelope({
          root,
          artifactsDir,
          bundle: bundleAfter,
          audit_state: state,
          selected_obligation: obligationId,
          selected_executor: "agent",
          progress_made: anyProgress,
          artifacts_written: Array.from(artifactsWritten),
          progress_summary: "Parallel worker batch made no progress.",
          next_likely_step: obligationId,
          providerName: provider.name,
        });
        return;
      }

      continue;
    }

    runCount += 1;
    const runId = buildRunId(obligationId, runCount);
    const paths = getRunPaths(artifactsDir, runId);
    if (shouldRunInlineExecutor(preferredExecutor)) {
      await clearDispatchFiles(artifactsDir);
      const startedAt = new Date().toISOString();
      let workerResult: WorkerResult;

      try {
        const result = await runAuditStep({
          root,
          artifactsDir,
          preferredExecutor,
          auditResultsPath,
          runtimeUpdatesPath,
          externalAnalyzerPath,
          analyzers: sessionConfig.analyzers,
          since: getFlag(argv, "--since"),
        });
        workerResult = {
          contract_version: WORKER_RESULT_CONTRACT_VERSION,
          run_id: runId,
          obligation_id: obligationId,
          status: result.progress_made ? "completed" : "no_progress",
          progress_made: result.progress_made,
          selected_executor: result.selected_executor,
          artifacts_written: result.artifacts_written,
          summary: result.progress_summary,
          next_likely_step: result.next_likely_step,
          errors: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        workerResult = {
          contract_version: WORKER_RESULT_CONTRACT_VERSION,
          run_id: runId,
          obligation_id: obligationId,
          status: "failed",
          progress_made: false,
          selected_executor: preferredExecutor,
          artifacts_written: [],
          summary: `Inline executor failed for ${preferredExecutor}: ${message}`,
          next_likely_step: decision.selected_obligation,
          errors: [message],
        };
      }

      await persistWorkerRunArtifacts(paths, workerResult, "inline");
      await appendRunLedgerEntry(artifactsDir, {
        run_id: runId,
        provider: provider.name,
        obligation_id: obligationId,
        selected_executor: workerResult.selected_executor,
        status: workerResult.status,
        started_at: startedAt,
        ended_at: new Date().toISOString(),
        result_path: paths.resultPath,
      });

      lastResult = workerResult;
      if (workerResult.progress_made) {
        anyProgress = true;
      }
      for (const artifact of workerResult.artifacts_written) {
        artifactsWritten.add(artifact);
      }
      artifactsWritten.add("run-ledger.json");

      if (externalAnalyzerPath) pendingExternalAnalyzerPath = undefined;
      if (
        auditResultsPath &&
        pendingBatchAuditResults[0] === auditResultsPath &&
        preferredExecutor === "result_ingestion_executor" &&
        workerResult.status !== "failed" &&
        workerResult.status !== "blocked"
      ) {
        pendingBatchAuditResults.shift();
      }
      if (auditResultsPath) pendingAuditResultsPath = undefined;
      if (runtimeUpdatesPath) pendingRuntimeUpdatesPath = undefined;

      if (
        workerResult.status === "failed" ||
        workerResult.status === "blocked" ||
        workerResult.status === "no_progress"
      ) {
        const bundleAfter = await loadArtifactBundle(artifactsDir);
        const shouldBlock =
          workerResult.status === "failed" || workerResult.status === "blocked";
        const state = shouldBlock
          ? buildBlockedAuditState({
              state: bundleAfter.audit_state ?? deriveAuditState(bundleAfter),
              obligationId: workerResult.obligation_id,
              executor: workerResult.selected_executor,
              blocker: buildWorkerFailureBlocker(workerResult),
            })
          : bundleAfter.audit_state ?? deriveAuditState(bundleAfter);
        if (shouldBlock) {
          await writeCoreArtifacts(artifactsDir, {
            ...bundleAfter,
            audit_state: state,
          });
        }
        await emitEnvelope({
          root,
          artifactsDir,
          bundle: shouldBlock
            ? { ...bundleAfter, audit_state: state }
            : bundleAfter,
          audit_state: state,
          selected_obligation: workerResult.obligation_id,
          selected_executor: workerResult.selected_executor,
          progress_made: anyProgress,
          artifacts_written: Array.from(
            shouldBlock
              ? new Set([...artifactsWritten, "audit_state.json"])
              : artifactsWritten,
          ),
          progress_summary: buildWorkerFailureBlocker(workerResult),
          next_likely_step: shouldBlock ? null : workerResult.next_likely_step,
          providerName: provider.name,
        });
        return;
      }

      continue;
    }

    const pendingAuditTasks =
      preferredExecutor === "agent"
        ? await addFileLineCountHints(root, buildPendingAuditTasks(bundle))
        : undefined;
    const pendingAuditTasksPath =
      preferredExecutor === "agent"
        ? join(paths.runDir, "pending-audit-tasks.json")
        : undefined;
    const providerAuditResultsPath =
      preferredExecutor === "agent"
        ? join(paths.runDir, "audit-results.json")
        : auditResultsPath;
    const providerReadPaths = new Set<string>();
    if (pendingAuditTasks) {
      for (const pt of pendingAuditTasks) {
        for (const fp of pt.file_paths) providerReadPaths.add(fp);
      }
    }
    const task: WorkerTask = {
      contract_version: "audit-code-worker/v1alpha1",
      run_id: runId,
      repo_root: root,
      artifacts_dir: artifactsDir,
      obligation_id: obligationId,
      preferred_executor: preferredExecutor,
      result_path: paths.resultPath,
      worker_command: [
        process.execPath,
        selfCliPath,
        "worker-run",
        "--task",
        paths.taskPath,
      ],
      audit_results_path: providerAuditResultsPath,
      pending_audit_tasks_path: pendingAuditTasksPath,
      runtime_updates_path: runtimeUpdatesPath,
      external_analyzer_results_path: externalAnalyzerPath,
      timeout_ms: timeoutMs,
      max_retries: 0,
      access: providerReadPaths.size > 0 ? {
        read_paths: [...providerReadPaths],
        write_paths: [providerAuditResultsPath ?? paths.resultPath, paths.resultPath],
      } : undefined,
    };
    const prompt = renderWorkerPrompt(task);
    await writeWorkerTaskFiles(
      task,
      prompt,
      paths,
      artifactsDir,
      pendingAuditTasks,
    );
    if (pendingAuditTasksPath && pendingAuditTasks) {
      await writeJsonFile(pendingAuditTasksPath, pendingAuditTasks);
    }

    const startedAt = new Date().toISOString();
    let workerResult: WorkerResult;
    let launchResult:
      | Awaited<ReturnType<typeof provider.launch>>
      | null = null;

    try {
      launchResult = await provider.launch({
        repoRoot: root,
        runId,
        obligationId,
        promptPath: paths.promptPath,
        taskPath: paths.taskPath,
        resultPath: paths.resultPath,
        stdoutPath: paths.stdoutPath,
        stderrPath: paths.stderrPath,
        uiMode,
        timeoutMs,
      });
      const candidate = await readJsonFile<unknown>(paths.resultPath);
      if (isWorkerResult(candidate)) {
        workerResult = candidate;
      } else {
        const launchExitSummary = summarizeLaunchExit(launchResult);
        workerResult = {
            contract_version: WORKER_RESULT_CONTRACT_VERSION,
            run_id: runId,
            obligation_id: obligationId,
            status: "failed",
            progress_made: false,
            selected_executor: preferredExecutor,
            artifacts_written: [],
            summary: launchExitSummary
              ? `Worker did not emit a valid worker result after provider exit: ${launchExitSummary}`
              : "Worker did not emit a valid worker result.",
            next_likely_step: decision.selected_obligation,
            errors: ["Invalid worker result contract."],
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const launchExitSummary =
        launchResult && summarizeLaunchExit(launchResult);
      workerResult = {
        contract_version: WORKER_RESULT_CONTRACT_VERSION,
        run_id: runId,
        obligation_id: obligationId,
        status: "failed",
        progress_made: false,
        selected_executor: preferredExecutor,
        artifacts_written: [],
        summary: `Worker launch failed for ${preferredExecutor}: ${
          launchExitSummary ?? message
        }`,
        next_likely_step: decision.selected_obligation,
        errors: launchExitSummary ? [message, launchExitSummary] : [message],
      };
      await persistWorkerRunArtifacts(paths, workerResult, "provider-launch");
    }

    await appendRunLedgerEntry(artifactsDir, {
      run_id: runId,
      provider: provider.name,
      obligation_id: obligationId,
      selected_executor: workerResult.selected_executor,
      status: workerResult.status,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      result_path: paths.resultPath,
    });

    lastResult = workerResult;
    if (workerResult.progress_made) {
      anyProgress = true;
    }
    for (const artifact of workerResult.artifacts_written) {
      artifactsWritten.add(artifact);
    }
    artifactsWritten.add("run-ledger.json");

    if (externalAnalyzerPath) pendingExternalAnalyzerPath = undefined;
    if (
      auditResultsPath &&
      pendingBatchAuditResults[0] === auditResultsPath &&
      preferredExecutor === "result_ingestion_executor" &&
      workerResult.status !== "failed" &&
      workerResult.status !== "blocked"
    ) {
      pendingBatchAuditResults.shift();
    }
    if (providerAuditResultsPath) pendingAuditResultsPath = undefined;
    if (runtimeUpdatesPath) pendingRuntimeUpdatesPath = undefined;

    if (
      workerResult.status === "failed" ||
      workerResult.status === "blocked" ||
      workerResult.status === "no_progress"
    ) {
      const bundleAfter = await loadArtifactBundle(artifactsDir);
      const shouldBlock =
        workerResult.status === "failed" || workerResult.status === "blocked";
      const state = shouldBlock
        ? buildBlockedAuditState({
            state: deriveAuditState(bundleAfter),
            obligationId: workerResult.obligation_id,
            executor: workerResult.selected_executor,
            blocker: buildWorkerFailureBlocker(workerResult),
          })
        : deriveAuditState(bundleAfter);
      if (shouldBlock) {
        await writeCoreArtifacts(artifactsDir, {
          ...bundleAfter,
          audit_state: state,
        });
      }
      await emitEnvelope({
        root,
        artifactsDir,
        bundle: shouldBlock
          ? { ...bundleAfter, audit_state: state }
          : bundleAfter,
        audit_state: state,
        selected_obligation: workerResult.obligation_id,
        selected_executor: workerResult.selected_executor,
        progress_made: anyProgress,
        artifacts_written: Array.from(
          shouldBlock
            ? new Set([...artifactsWritten, "audit_state.json"])
            : artifactsWritten,
        ),
        progress_summary: buildWorkerFailureBlocker(workerResult),
        next_likely_step: shouldBlock ? null : workerResult.next_likely_step,
        providerName: provider.name,
      });
      return;
    }
  }

  const bundle = await loadArtifactBundle(artifactsDir);
  const decision = decideNextStep(bundle);
  const state = decision.state;
  if (state.status === "complete") {
    await clearDispatchFiles(artifactsDir);
  }
  await emitEnvelope({
    root,
    artifactsDir,
    bundle,
    audit_state: state,
    selected_obligation:
      lastResult?.obligation_id ?? decision.selected_obligation,
    selected_executor:
      lastResult?.selected_executor ?? decision.selected_executor,
    progress_made: anyProgress,
    artifacts_written: Array.from(artifactsWritten),
    progress_summary: `Reached max run limit (${maxRuns}) before terminal state.`,
    next_likely_step:
      state.status === "complete" ? null : decision.selected_obligation,
    providerName: provider.name,
  });
  if (state.status === "complete") {
    await promoteFinalAuditReport({ artifactsDir, repoRoot: root });
  }
}

async function cmdWorkerRun(argv: string[]): Promise<void> {
  const taskPath = getFlag(argv, "--task");
  if (!taskPath) {
    throw new Error("worker-run requires --task <path>");
  }
  const task = await readJsonFile<WorkerTask>(taskPath);

  let workerResult: WorkerResult;
  try {
    if (looksLikeCliFlag(task.audit_results_path)) {
      throw new Error(
        `task.audit_results_path resolved to '${task.audit_results_path}', which looks like a CLI flag instead of a file path.`,
      );
    }
    if (task.preferred_executor === "agent" && !task.audit_results_path) {
      throw new Error(
        "agent worker-run requires audit_results_path so provider-assisted review can be ingested.",
      );
    }
    if (task.preferred_executor === "agent" && task.audit_results_path) {
      const pendingTasks = task.pending_audit_tasks_path
        ? await readJsonFile<AuditTask[]>(task.pending_audit_tasks_path)
        : [];
      const auditResults = await readJsonFile<AuditResult[]>(
        task.audit_results_path,
      );
      const pendingTaskIds = new Set(pendingTasks.map((item) => item.task_id));
      const matchedResultCount = auditResults.filter((result) =>
        pendingTaskIds.has(result.task_id),
      ).length;
      if (pendingTasks.length > 0 && matchedResultCount === 0) {
        throw new Error(
          "Provider-assisted review did not emit any audit results for the pending audit tasks.",
        );
      }

      const issues = validateAuditResults(auditResults, pendingTasks, {
        lineIndex: await buildLineIndexForPaths(
          task.repo_root,
          pendingTasks.flatMap((item) => item.file_paths),
        ),
      });
      const errors = issues.filter((issue) => issue.severity === "error");
      const warnings = issues.filter((issue) => issue.severity === "warning");

      if (warnings.length > 0) {
        process.stderr.write(
          `audit-results validation: ${warnings.length} warning(s):\n` +
            formatAuditResultIssues(warnings) +
            "\n",
        );
      }
      if (errors.length > 0) {
        throw new Error(formatAuditResultValidationError(errors));
      }
    }
    const preferredExecutor =
      task.preferred_executor === "agent"
        ? "result_ingestion_executor"
        : task.preferred_executor;
    const result = await runAuditStep({
      root: task.repo_root,
      artifactsDir: task.artifacts_dir,
      preferredExecutor,
      auditResultsPath: task.audit_results_path,
      runtimeUpdatesPath: task.runtime_updates_path,
      externalAnalyzerPath: task.external_analyzer_results_path,
    });
    workerResult = {
      contract_version: WORKER_RESULT_CONTRACT_VERSION,
      run_id: task.run_id,
      obligation_id: task.obligation_id,
      status: result.progress_made ? "completed" : "no_progress",
      progress_made: result.progress_made,
      selected_executor: result.selected_executor,
      artifacts_written: result.artifacts_written,
      summary: result.progress_summary,
      next_likely_step: result.next_likely_step,
      errors: [],
    };
  } catch (error) {
    workerResult = {
      contract_version: WORKER_RESULT_CONTRACT_VERSION,
      run_id: task.run_id,
      obligation_id: task.obligation_id,
      status: "failed",
      progress_made: false,
      selected_executor: task.preferred_executor,
      artifacts_written: [],
      summary: `Worker failed for executor ${task.preferred_executor}: ${error instanceof Error ? error.message : String(error)}`,
      next_likely_step: task.obligation_id,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }

  await writeJsonFile(task.result_path, workerResult);
  console.log(JSON.stringify(workerResult, null, 2));
  if (workerResult.status === "failed") {
    process.exitCode = 1;
  }
}

async function cmdPrepareDispatch(argv: string[]): Promise<void> {
  const runId = getFlag(argv, "--run-id");
  if (!runId) throw new Error("prepare-dispatch requires --run-id <run_id>");
  const artifactsDir = getArtifactsDir(argv);
  const sessionConfig = await loadSessionConfig(artifactsDir).catch(
    () => ({} as SessionConfig),
  );
  const provider = createFreshSessionProvider(getExplicitProvider(argv), sessionConfig);
  const hostModel = getHostModel(argv) ?? sessionConfig.block_quota?.host_model ?? null;
  const result = await prepareDispatchArtifacts({
    packageRoot,
    runId,
    artifactsDir,
    root: getFlag(argv, "--root") ? getRootDir(argv) : undefined,
    sessionConfig,
    hostModel,
    queryLimits: provider.queryLimits?.bind(provider),
    hostActiveSubagentLimit: getHostMaxActiveSubagents(argv),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function cmdSubmitPacket(argv: string[]): Promise<void> {
  const runId = resolveRunScopedArg(argv, "--run-id", "--run-id-b64");
  const packetId = resolveRunScopedArg(argv, "--packet-id", "--packet-id-b64");
  const artifactsDirB64 = getFlag(argv, "--artifacts-dir-b64");
  const artifactsDir = artifactsDirB64
    ? resolve(fromBase64Url(artifactsDirB64))
    : getArtifactsDir(argv);
  if (!runId || !packetId) {
    throw new Error(
      "submit-packet requires --run-id and --packet-id (or --run-id-b64/--packet-id-b64)",
    );
  }

  const runDir = join(artifactsDir, "runs", runId);
  const tasksPath = join(runDir, "pending-audit-tasks.json");
  const resultMap = await loadDispatchResultMap(runDir);
  if (!resultMap) {
    throw new Error(
      `No ${DISPATCH_RESULT_MAP_FILENAME} found for run ${runId}; run prepare-dispatch first.`,
    );
  }

  let packetEntries = resultMap.entries.filter(
    (entry) => entry.packet_id === packetId,
  );
  let resolvedPacketId = packetId;
  if (packetEntries.length === 0) {
    const trimmed = packetId.trim();
    packetEntries = resultMap.entries.filter(
      (entry) => entry.packet_id.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (packetEntries.length > 0) {
      resolvedPacketId = packetEntries[0]!.packet_id;
      process.stderr.write(
        `[submit-packet] Resolved packet_id '${packetId}' → '${resolvedPacketId}' (case/whitespace normalization)\n`,
      );
    }
  }
  if (packetEntries.length === 0) {
    const knownIds = [...new Set(resultMap.entries.map((e) => e.packet_id))];
    throw new Error(
      `Unknown packet_id '${packetId}' for run ${runId}.\n` +
      `Valid packet IDs: ${knownIds.join(", ")}`,
    );
  }
  if (entriesByTaskId(packetEntries).size !== packetEntries.length) {
    throw new Error(`Dispatch result map has duplicate task entries for packet '${resolvedPacketId}'.`);
  }

  const allTasks = await readJsonFile<AuditTask[]>(tasksPath);
  const taskById = new Map(allTasks.map((task) => [task.task_id, task]));
  const packetTasks = packetEntries.map((entry) => taskById.get(entry.task_id));
  const missingTask = packetEntries.find((entry, index) => !packetTasks[index]);
  if (missingTask) {
    throw new Error(
      `Dispatch result map references unknown task '${missingTask.task_id}'.`,
    );
  }
  const tasks = packetTasks as AuditTask[];
  const expectedTaskIds = new Set(tasks.map((task) => task.task_id));
  const lineIndex = Object.fromEntries(
    tasks.flatMap((task) => Object.entries(task.file_line_counts ?? {})),
  );
  const encodedResults = getFlag(argv, "--results-b64");
  const raw = encodedResults ? fromBase64Url(encodedResults) : await readStdinText();
  if (raw.trim().length === 0) {
    throw new Error(
      "submit-packet requires an AuditResult[] JSON payload on stdin or --results-b64.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid submit-packet JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const resultErrors: string[] = [];
  const issues = validateAuditResults(payload, tasks, { lineIndex });
  const validationErrors = issues.filter((issue) => issue.severity === "error");
  const validationWarnings = issues.filter((issue) => issue.severity === "warning");
  if (validationWarnings.length > 0) {
    process.stderr.write(
      `audit-results validation: ${validationWarnings.length} warning(s):\n` +
        formatAuditResultIssues(validationWarnings) +
        "\n",
    );
  }
  if (validationErrors.length > 0) {
    resultErrors.push(formatAuditResultIssues(validationErrors));
  }

  if (Array.isArray(payload)) {
    const seen = new Set<string>();
    for (const [index, result] of payload.entries()) {
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        continue;
      }
      const taskId = (result as Record<string, unknown>).task_id;
      if (typeof taskId !== "string" || taskId.trim().length === 0) {
        continue;
      }
      if (seen.has(taskId)) {
        resultErrors.push(`Duplicate audit result for assigned task '${taskId}'.`);
      }
      seen.add(taskId);
      if (!expectedTaskIds.has(taskId)) {
        resultErrors.push(
          `Result at index ${index} uses task_id '${taskId}', which is not assigned to packet '${resolvedPacketId}'.`,
        );
      }
    }
    for (const task of tasks) {
      if (!seen.has(task.task_id)) {
        resultErrors.push(`Missing audit result for assigned task '${task.task_id}'.`);
      }
    }
  }

  if (resultErrors.length > 0) {
    throw new Error(`submit-packet rejected ${resolvedPacketId}:\n${resultErrors.join("\n")}`);
  }

  // Check for duplicate findings against already-submitted results in this run
  const existingFindingKeys = new Set<string>();
  const otherEntries = resultMap.entries.filter(
    (e) => e.packet_id !== resolvedPacketId,
  );
  for (const other of otherEntries) {
    try {
      const existing = JSON.parse(await readFile(other.result_path, "utf8")) as AuditResult;
      if (existing?.findings) {
        for (const f of existing.findings) {
          const key = [
            (f.lens ?? "").trim().toLowerCase(),
            (f.category ?? "").trim().toLowerCase(),
            (f.title ?? "").trim().toLowerCase(),
            f.affected_files?.[0]?.path ?? "",
          ].join("|");
          existingFindingKeys.add(key);
        }
      }
    } catch { /* file doesn't exist yet or invalid — skip */ }
  }
  let dupCount = 0;
  for (const result of payload as AuditResult[]) {
    for (const f of result.findings ?? []) {
      const key = [
        (f.lens ?? "").trim().toLowerCase(),
        (f.category ?? "").trim().toLowerCase(),
        (f.title ?? "").trim().toLowerCase(),
        f.affected_files?.[0]?.path ?? "",
      ].join("|");
      if (existingFindingKeys.has(key)) {
        dupCount++;
      }
    }
  }
  if (dupCount > 0) {
    process.stderr.write(
      `[submit-packet] Warning: ${dupCount} finding(s) appear to duplicate findings from other packets in this run.\n`,
    );
  }

  const entryByTaskId = entriesByTaskId(packetEntries);
  for (const result of payload as AuditResult[]) {
    const entry = entryByTaskId.get(result.task_id);
    if (!entry) {
      throw new Error(
        `Internal error: no result path for accepted task '${result.task_id}'.`,
      );
    }
    await writeJsonFile(entry.result_path, result);
  }

  const findingCount = (payload as AuditResult[]).reduce(
    (sum, result) => sum + result.findings.length,
    0,
  );
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        packet_id: resolvedPacketId,
        accepted_count: (payload as AuditResult[]).length,
        finding_count: findingCount,
        ...(dupCount > 0 ? { duplicate_warning_count: dupCount } : {}),
      },
      null,
      2,
    ),
  );
}

async function cmdMergeAndIngest(argv: string[]): Promise<void> {
  const runId = getFlag(argv, "--run-id");
  if (!runId) throw new Error("merge-and-ingest requires --run-id <run_id>");
  const artifactsDir = getArtifactsDir(argv);

  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  const auditResultsPath = join(runDir, "audit-results.json");
  const taskPath = join(runDir, "task.json");
  const tasksPath = join(runDir, "pending-audit-tasks.json");
  const workerTask = await readJsonFile<WorkerTask>(taskPath);
  const resultMap = await loadDispatchResultMap(runDir);
  if (!resultMap) {
    throw new Error(
      `No ${DISPATCH_RESULT_MAP_FILENAME} found for run ${runId}; run prepare-dispatch first.`,
    );
  }

  let allTasks: AuditTask[] = [];
  try { allTasks = await readJsonFile<AuditTask[]>(tasksPath); } catch { /* may not exist */ }
  const entryByTaskId = entriesByTaskId(resultMap.entries);
  if (entryByTaskId.size !== resultMap.entries.length) {
    throw new Error(`Dispatch result map for run ${runId} contains duplicate task entries.`);
  }
  const expectedPaths = new Set(
    resultMap.entries.map((entry) => resolve(entry.result_path)),
  );

  let files: string[];
  try {
    files = (await readdir(taskResultsDir)).filter(f => f.endsWith(".json")).sort();
  } catch {
    files = [];
  }

  const passing: AuditResult[] = [];
  const failing: Array<{ task_id: string; errors: string[] }> = [];
  const seenTaskIds = new Set<string>();
  let spuriousFileCount = 0;

  const fallbackByTaskId = new Map<string, unknown>();
  for (const filename of files) {
    const filePath = resolve(join(taskResultsDir, filename));
    if (!expectedPaths.has(filePath)) {
      spuriousFileCount++;
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const tid = typeof (parsed as Record<string, unknown>).task_id === "string"
            ? String((parsed as Record<string, unknown>).task_id) : undefined;
          if (tid && !fallbackByTaskId.has(tid)) {
            fallbackByTaskId.set(tid, parsed);
          }
        }
      } catch { /* not parseable — skip */ }
      process.stderr.write(
        `[merge-and-ingest] Warning: unexpected file in task-results/: ${filename}\n`,
      );
    }
  }

  for (const task of allTasks) {
    const entry = entryByTaskId.get(task.task_id);
    if (!entry) {
      failing.push({
        task_id: task.task_id,
        errors: ["Missing dispatch result-map entry for assigned task."],
      });
      continue;
    }
    const filePath = entry.result_path;
    let obj: unknown;
    try {
      obj = JSON.parse(await readFile(filePath, "utf8"));
    } catch (e) {
      if (isFileMissingError(e)) {
        const fallback = fallbackByTaskId.get(task.task_id);
        if (fallback) {
          process.stderr.write(
            `[merge-and-ingest] Recovered result for '${task.task_id}' from unexpected file (matched by task_id)\n`,
          );
          obj = fallback;
        } else {
          failing.push({
            task_id: task.task_id,
            errors: ["Missing audit result for assigned task."],
          });
          continue;
        }
      } else {
        failing.push({ task_id: task.task_id, errors: [`Invalid JSON: ${(e as Error).message}`] });
        continue;
      }
    }
    const record = obj && typeof obj === "object" && !Array.isArray(obj)
      ? obj as Record<string, unknown>
      : undefined;
    const taskId = typeof record?.task_id === "string"
      ? String(record.task_id) : undefined;
    const resultErrors: string[] = [];
    if (taskId) {
      if (seenTaskIds.has(taskId)) {
        resultErrors.push(`Duplicate audit result for assigned task '${taskId}'.`);
      } else {
        seenTaskIds.add(taskId);
      }
      if (taskId !== task.task_id) {
        resultErrors.push(
          `Result file is assigned to '${task.task_id}' but contains task_id '${taskId}'.`,
        );
      }
    }
    const issues = validateAuditResults(
      [obj],
      [task],
      { lineIndex: task.file_line_counts ?? {} },
    );
    resultErrors.push(
      ...issues
        .filter(i => i.severity === "error")
        .map(i => i.message),
    );
    if (resultErrors.length === 0) {
      passing.push(obj as AuditResult);
    } else {
      failing.push({ task_id: taskId ?? task.task_id, errors: resultErrors });
    }
  }

  await writeJsonFile(auditResultsPath, passing);

  const failedTasksPath = join(runDir, "failed-tasks.json");
  if (failing.length > 0) {
    await writeJsonFile(failedTasksPath, failing);
  }

  if (passing.length === 0 && failing.length > 0) {
    throw new Error(
      `All ${failing.length} assigned task result(s) were missing or invalid; blocked before ingestion. See ${failedTasksPath}`,
    );
  }

  const findingCount = passing.reduce(
    (sum, result) => sum + result.findings.length,
    0,
  );

  let result: Awaited<ReturnType<typeof runAuditStep>> | null = null;
  if (passing.length > 0) {
    result = await runAuditStep({
      root: workerTask.repo_root,
      artifactsDir,
      preferredExecutor: "result_ingestion_executor",
      auditResultsPath,
    });
    const updatedPendingTasks = await addFileLineCountHints(
      workerTask.repo_root,
      buildPendingAuditTasks(result.updated_bundle),
    );
    await writeJsonFile(tasksPath, updatedPendingTasks);
  }

  const activeDispatchPath = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  try {
    const dispatch = await readJsonFile<ActiveDispatchState>(activeDispatchPath);
    if (dispatch.run_id === runId) {
      dispatch.status = failing.length > 0 ? "active" : "merged";
      await writeJsonFile(activeDispatchPath, dispatch);
    }
  } catch { /* no active dispatch file — skip */ }

  let retryDispatchPath: string | null = null;
  if (failing.length > 0) {
    const failedTaskIds = new Set(failing.map((f) => f.task_id));
    const failedPacketIds = [
      ...new Set(
        resultMap.entries
          .filter((e) => failedTaskIds.has(e.task_id))
          .map((e) => e.packet_id),
      ),
    ];
    const retryDispatch = {
      run_id: runId,
      retry_packet_ids: failedPacketIds,
      failed_task_count: failing.length,
      accepted_task_count: passing.length,
    };
    retryDispatchPath = join(runDir, "retry-dispatch.json");
    await writeJsonFile(retryDispatchPath, retryDispatch);
    process.stderr.write(
      `[merge-and-ingest] ${passing.length} accepted, ${failing.length} failed. ` +
      `Retry packets: ${failedPacketIds.join(", ")}\n`,
    );
  }

  const status = failing.length > 0
    ? "partial"
    : (result?.progress_made ? "completed" : "no_progress");
  const workerResult = buildWorkerResult({
    runId,
    obligationId: workerTask.obligation_id,
    status: failing.length > 0 ? "no_progress" : (result?.progress_made ? "completed" : "no_progress"),
    progressMade: result?.progress_made ?? false,
    selectedExecutor: result?.selected_executor ?? null,
    artifactsWritten: result?.artifacts_written ?? [],
    summary: result?.progress_summary ?? `${failing.length} task(s) failed`,
    nextLikelyStep: result?.next_likely_step ?? null,
    errors: [],
  });
  await writeJsonFile(workerTask.result_path, workerResult);
  console.log(
    JSON.stringify(
      {
        run_id: runId,
        status,
        accepted_count: passing.length,
        rejected_count: failing.length,
        spurious_file_count: spuriousFileCount,
        finding_count: findingCount,
        audit_results_path: auditResultsPath,
        ...(retryDispatchPath ? { retry_dispatch_path: retryDispatchPath } : {}),
        ...(result ? {
          selected_executor: workerResult.selected_executor,
          progress_made: workerResult.progress_made,
          progress_summary: workerResult.summary,
          next_likely_step: workerResult.next_likely_step,
        } : {}),
      },
      null,
      2,
    ),
  );

  if (failing.length > 0) {
    process.exitCode = 2;
  }
}

async function cmdValidateResult(argv: string[]): Promise<void> {
  const rawRunId = getFlag(argv, "--run-id");
  const runIdB64 = getFlag(argv, "--run-id-b64");
  const rawTaskId = getFlag(argv, "--task-id");
  const artifactsDirB64 = getFlag(argv, "--artifacts-dir-b64");
  const runId = rawRunId ?? (runIdB64 ? fromBase64Url(runIdB64) : undefined);
  const taskIdB64 = getFlag(argv, "--task-id-b64");
  const taskId = rawTaskId ?? (taskIdB64 ? fromBase64Url(taskIdB64) : undefined);
  const artifactsDir = artifactsDirB64
    ? resolve(fromBase64Url(artifactsDirB64))
    : getArtifactsDir(argv);
  if (!runId || !taskId) {
    throw new Error(
      "validate-result requires --run-id and --task-id (or --run-id-b64/--task-id-b64)",
    );
  }

  const runDir = join(artifactsDir, "runs", runId);
  const taskResultsDir = join(runDir, "task-results");
  const resultMap = await loadDispatchResultMap(runDir);
  const resultPath =
    resultMap?.entries.find((entry) => entry.task_id === taskId)?.result_path ??
    taskResultPath(taskResultsDir, taskId);
  const tasksPath = join(runDir, "pending-audit-tasks.json");

  let raw: string;
  try {
    raw = await readFile(resultPath, "utf8");
  } catch {
    console.error(`File not found: ${resultPath}`);
    process.exitCode = 1;
    return;
  }

  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON: ${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }

  let allTasks: AuditTask[] = [];
  try { allTasks = await readJsonFile<AuditTask[]>(tasksPath); } catch { /* may not exist */ }

  const matchingTasks = allTasks.filter(t => t.task_id === taskId);
  const lineIndex = matchingTasks[0]?.file_line_counts ?? {};
  const issues = validateAuditResults([obj], matchingTasks, { lineIndex });
  const errors = issues.filter(i => i.severity === "error");

  if (errors.length === 0) {
    console.log(`✓ valid: ${taskId}`);
  } else {
    console.error(`✗ invalid: ${taskId}`);
    for (const e of errors) console.error(`  ${e.path}: ${e.message}`);
    process.exitCode = 1;
  }
}

async function cmdImportExternalAnalyzer(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const sourcePath = getFlag(
    argv,
    "--external-analyzer-results",
    `${artifactsDir}/external_analyzer_results.json`,
  ) as string;
  const externalAnalyzerResults =
    await readJsonFile<ExternalAnalyzerResults>(sourcePath);
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    preferredExecutor: "external_analyzer_import_executor",
    externalAnalyzerPath: sourcePath,
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        tool: externalAnalyzerResults.tool,
        imported_count: externalAnalyzerResults.results.length,
        selected_executor: result.selected_executor,
      },
      null,
      2,
    ),
  );
}

async function cmdIntake(argv: string[]): Promise<void> {
  const root = getRootDir(argv);
  warnIfNotGitRepo(root);
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root,
    artifactsDir,
    preferredExecutor: "intake_executor",
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        selected_executor: result.selected_executor,
        progress_summary: result.progress_summary,
      },
      null,
      2,
    ),
  );
}

async function cmdPlan(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    since: getFlag(argv, "--since"),
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        selected_executor: result.selected_executor,
        progress_summary: result.progress_summary,
        next_likely_step: result.next_likely_step,
      },
      null,
      2,
    ),
  );
}

async function cmdIngestResults(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const batchResultsDir = getBatchResultsDir(argv);
  if (batchResultsDir && getFlag(argv, "--results")) {
    throw new Error("Use either --results <file> or --batch-results <dir>, not both.");
  }
  if (batchResultsDir) {
    const result = await ingestBatchAuditResults({
      root: getRootDir(argv),
      artifactsDir,
      batchDir: batchResultsDir,
    });
    console.log(
      JSON.stringify(
        {
          artifacts_dir: artifactsDir,
          imported_files: result.batchFiles,
          selected_executor: result.selected_executor,
          progress_summary: result.progress_summary,
        },
        null,
        2,
      ),
    );
    return;
  }
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    preferredExecutor: "result_ingestion_executor",
    auditResultsPath: getFlag(argv, "--results"),
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        selected_executor: result.selected_executor,
        progress_summary: result.progress_summary,
      },
      null,
      2,
    ),
  );
}

async function cmdExplainTask(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const taskId = getFlag(argv, "--task-id") ?? argv[3];
  if (!taskId) {
    throw new Error("explain-task requires <task_id> or --task-id <task_id>");
  }

  const bundle = await loadArtifactBundle(artifactsDir);
  const task =
    [...(bundle.audit_tasks ?? []), ...(bundle.requeue_tasks ?? [])].find(
      (item) => item.task_id === taskId,
    );
  if (!task) {
    throw new Error(`Unknown task_id '${taskId}'.`);
  }

  const coverageEntries = (bundle.coverage_matrix?.files ?? [])
    .filter((file) => task.file_paths.includes(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));
  const matchingResults = (bundle.audit_results ?? []).filter(
    (result) => result.task_id === task.task_id,
  );

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        task_id: task.task_id,
        task,
        file_count: task.file_paths.length,
        coverage_entries: coverageEntries,
        pending_coverage: coverageEntries
          .map((file) => ({
            path: file.path,
            missing_lenses: file.required_lenses.filter(
              (lens) => !file.completed_lenses.includes(lens),
            ),
          }))
          .filter((file) => file.missing_lenses.length > 0),
        matching_result_count: matchingResults.length,
        matching_finding_ids: matchingResults.flatMap((result) =>
          result.findings.map((finding) => finding.id),
        ),
      },
      null,
      2,
    ),
  );
}

async function cmdUpdateRuntimeValidation(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    preferredExecutor: "runtime_validation_update_executor",
    runtimeUpdatesPath: getFlag(argv, "--updates"),
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        selected_executor: result.selected_executor,
        progress_summary: result.progress_summary,
      },
      null,
      2,
    ),
  );
}

async function cmdValidate(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const bundle = await loadArtifactBundle(artifactsDir);
  const sessionConfigPath = getSessionConfigPath(artifactsDir);
  const rawSessionConfig = await readSessionConfigFile(artifactsDir);
  const artifactIssues = validateArtifactBundle(bundle);
  const sessionConfigIssues =
    rawSessionConfig === undefined
      ? []
      : prefixValidationIssues(
          "session_config",
          validateSessionConfig(rawSessionConfig),
        );
  const providerIssues =
    rawSessionConfig === undefined || sessionConfigIssues.length > 0
      ? []
      : prefixValidationIssues(
          "session_config",
          validateConfiguredProviderEnvironment(rawSessionConfig as SessionConfig),
        );
  const issues = [
    ...artifactIssues,
    ...sessionConfigIssues,
    ...providerIssues,
  ];
  const resolvedProvider =
    rawSessionConfig === undefined
      ? "local-subprocess"
      : sessionConfigIssues.length > 0
        ? null
        : resolveFreshSessionProviderName(
            undefined,
            rawSessionConfig as SessionConfig,
          );
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        session_config_path: sessionConfigPath,
        session_config_present: rawSessionConfig !== undefined,
        resolved_provider: resolvedProvider,
        artifact_issue_count: artifactIssues.length,
        session_config_issue_count:
          sessionConfigIssues.length + providerIssues.length,
        issue_count: issues.length,
        issues,
      },
      null,
      2,
    ),
  );
  process.exitCode = issues.length > 0 ? 1 : 0;
}

async function cmdValidateResults(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const resultsPath = getFlag(argv, "--results");
  if (!resultsPath) {
    throw new Error("validate-results requires --results <file>");
  }
  const bundle = await loadArtifactBundle(artifactsDir);
  const lineIndex = bundle.repo_manifest
    ? await buildLineIndex(getRootDir(argv), bundle.repo_manifest)
    : undefined;
  const auditResults = await readJsonFile<unknown>(resultsPath);
  const issues = validateAuditResults(auditResults, bundle.audit_tasks ?? [], {
    lineIndex,
  });
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        results_path: resolve(resultsPath),
        warning_count: warnings.length,
        error_count: errors.length,
        issues,
      },
      null,
      2,
    ),
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

async function cmdRequeue(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const bundle = await loadArtifactBundle(artifactsDir);
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        task_count: bundle.requeue_tasks?.length ?? 0,
      },
      null,
      2,
    ),
  );
}

async function cmdSynthesize(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const result = await runAuditStep({
    root: getRootDir(argv),
    artifactsDir,
    preferredExecutor: "synthesis_executor",
  });
  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        selected_executor: result.selected_executor,
        progress_summary: result.progress_summary,
      },
      null,
      2,
    ),
  );
}

async function cleanupStaleArtifactsDir(artifactsDir: string): Promise<void> {
  let status: AuditState["status"] | undefined;
  try {
    const state = await readJsonFile<AuditState>(
      join(artifactsDir, "audit_state.json"),
    );
    status = state.status;
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    return;
  }
  if (status === "complete" || status === "not_started") {
    await rm(artifactsDir, { recursive: true, force: true });
  }
}

async function cmdCleanup(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const dryRun = hasFlag(argv, "--dry-run");
  const force = hasFlag(argv, "--force");

  let status: AuditState["status"] | undefined;
  try {
    const state = await readJsonFile<AuditState>(
      join(artifactsDir, "audit_state.json"),
    );
    status = state.status;
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }

  const resumable = status === "active" || status === "blocked";
  const unknown = status === undefined;

  if ((resumable || unknown) && !force) {
    const reason = resumable
      ? `audit is ${status} and may be resumed`
      : "no audit_state.json found; artifacts may be from a crashed audit";
    console.log(
      JSON.stringify(
        {
          artifacts_dir: artifactsDir,
          action: "skipped",
          reason: `${reason} — use --force to delete anyway`,
          dry_run: dryRun,
        },
        null,
        2,
      ),
    );
    process.exitCode = 1;
    return;
  }

  if (!dryRun) {
    await rm(artifactsDir, { recursive: true, force: true });
  }

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        action: dryRun ? "dry-run" : "deleted",
        status: status ?? "unknown",
        dry_run: dryRun,
      },
      null,
      2,
    ),
  );
}

async function cmdStatus(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const auditStatePath = join(artifactsDir, "audit_state.json");

  // 1. Read audit_state.json
  let auditState: AuditState | null = null;
  try {
    auditState = await readJsonFile<AuditState>(auditStatePath);
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
  }

  if (!auditState) {
    console.error("No audit_state.json found; no active audit in this artifacts directory.");
    process.exitCode = 1;
    return;
  }

  // Build obligations summary: count by state
  const obligationStates: Record<string, number> = {
    missing: 0,
    present: 0,
    stale: 0,
    blocked: 0,
    satisfied: 0,
  };
  for (const obligation of auditState.obligations ?? []) {
    const state = obligation.state;
    if (state in obligationStates) {
      obligationStates[state]!++;
    }
  }

  // 2. Read run ledger for last N entries
  const ledger = await loadRunLedger(artifactsDir);
  const RECENT_RUN_LIMIT = 5;
  const recentRuns = ledger.runs
    .slice(-RECENT_RUN_LIMIT)
    .reverse()
    .map((entry) => ({
      run_id: entry.run_id,
      obligation_id: entry.obligation_id,
      status: entry.status,
      started_at: entry.started_at,
    }));

  // 3. Find the most recent run directory and read pending-audit-tasks.json
  let pendingTasksSummary: {
    run_id: string;
    total: number;
    remaining: number;
  } | null = null;

  const runsDir = join(artifactsDir, "runs");
  let runDirs: string[] = [];
  try {
    const entries = await readdir(runsDir, { withFileTypes: true });
    runDirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    // runs directory may not exist yet
  }

  for (const runDirName of runDirs) {
    const runDir = join(runsDir, runDirName);
    const tasksPath = join(runDir, "pending-audit-tasks.json");
    let tasks: AuditTask[] | null = null;
    try {
      tasks = await readJsonFile<AuditTask[]>(tasksPath);
    } catch {
      continue; // no pending-audit-tasks.json in this run dir — try previous
    }
    if (!Array.isArray(tasks)) continue;

    // Count remaining: tasks without status "complete"
    const total = tasks.length;
    const remaining = tasks.filter(
      (t) => t.status !== "complete",
    ).length;

    pendingTasksSummary = {
      run_id: runDirName,
      total,
      remaining,
    };
    break;
  }

  // 4. Surface failed-tasks.json from the most recent run that has one
  let failedTasks: Array<{ task_id: string; errors: string[] }> | null = null;
  for (const runDirName of runDirs) {
    const failedTasksPath = join(runsDir, runDirName, "failed-tasks.json");
    try {
      const raw = await readJsonFile<Array<{ task_id: string; errors: string[] }>>(
        failedTasksPath,
      );
      if (Array.isArray(raw) && raw.length > 0) {
        failedTasks = raw;
        break;
      }
    } catch {
      // Not present in this run dir — keep looking
    }
  }

  console.log(
    JSON.stringify(
      {
        artifacts_dir: artifactsDir,
        status: auditState.status,
        last_obligation: auditState.last_obligation ?? null,
        last_executor: auditState.last_executor ?? null,
        blockers: auditState.blockers ?? [],
        obligations_summary: obligationStates,
        recent_runs: recentRuns,
        pending_tasks: pendingTasksSummary,
        failed_tasks: failedTasks,
      },
      null,
      2,
    ),
  );
}

async function cmdMcp(argv: string[]): Promise<void> {
  await runAuditCodeMcpServer(argv.slice(3));
}

async function cmdQuota(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const sessionConfig = await loadSessionConfig(artifactsDir).catch(() => ({} as SessionConfig));
  const explicitProvider = getExplicitProvider(argv);
  const hostModel = getHostModel(argv);
  const probeMode = getQuotaProbeMode(argv, sessionConfig);
  const providerName = resolveFreshSessionProviderName(explicitProvider, sessionConfig);
  const providerModelKey = buildProviderModelKey(providerName, hostModel);

  const { limits, source, confidence } = resolveLimits({ providerName, sessionConfig, hostModel });

  const probeResult = await probeProvider(providerName, probeMode);

  const quotaState = await readQuotaState().catch((): { version: 2; entries: Record<string, never> } => ({ version: 2, entries: {} }));
  const quotaStateEntry = quotaState.entries[providerModelKey] ?? null;
  const halfLifeHours = sessionConfig.quota?.empirical_half_life_hours ?? 24;
  const hostConcurrencyLimit = resolveHostActiveSubagentLimit({
    explicitLimit: getHostMaxActiveSubagents(argv),
    sessionConfig,
  });

  const quotaSource = buildQuotaSource({ halfLifeHours });
  const quotaSourceSnapshot = await quotaSource.queryCurrentUsage(providerModelKey).catch(() => null);
  const queryDiscoveredLimits = await lookupDiscoveredLimits(providerModelKey).catch(() => null);

  const waveSchedule = scheduleWave({
    providerName,
    sessionConfig,
    hostModel,
    requestedConcurrency: sessionConfig.parallel_workers ?? 1,
    quotaStateEntry,
    hostConcurrencyLimit,
    quotaSourceSnapshot,
    discoveredLimits: queryDiscoveredLimits,
  });

  console.log(
    JSON.stringify(
      {
        provider: providerName,
        model: hostModel,
        provider_model_key: providerModelKey,
        resolved_limits: limits,
        confidence,
        source,
        host_concurrency_limit: hostConcurrencyLimit,
        probe: probeResult,
        learned_caps: quotaStateEntry
          ? {
              max_safe_concurrency: computeMaxSafeConcurrency(quotaStateEntry, halfLifeHours),
              cooldown_until: quotaStateEntry.cooldown_until,
              last_429_at: quotaStateEntry.last_429_at,
            }
          : null,
        quota_source_snapshot: quotaSourceSnapshot,
        discovered_limits: queryDiscoveredLimits,
        wave_schedule: waveSchedule,
        quota_state_path: getQuotaStatePath(),
      },
      null,
      2,
    ),
  );
}

async function cmdDispatchStatus(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const activeDispatchPath = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  let activeDispatch: ActiveDispatchState | null = null;
  try {
    activeDispatch = await readJsonFile<ActiveDispatchState>(activeDispatchPath);
  } catch (e) {
    if (!isFileMissingError(e)) throw e;
  }
  if (!activeDispatch) {
    console.log(JSON.stringify({ status: "no_active_dispatch" }, null, 2));
    return;
  }

  const runDir = join(artifactsDir, "runs", activeDispatch.run_id);
  const resultMap = await loadDispatchResultMap(runDir);
  if (!resultMap) {
    console.log(JSON.stringify({
      status: "missing_result_map",
      run_id: activeDispatch.run_id,
    }, null, 2));
    return;
  }

  const packetIds = [...new Set(resultMap.entries.map((e) => e.packet_id))];
  const packetStatus: Array<{
    packet_id: string;
    task_count: number;
    completed_count: number;
    missing_task_ids: string[];
  }> = [];

  for (const pid of packetIds) {
    if (pid === "__prior_dispatch__") continue;
    const entries = resultMap.entries.filter((e) => e.packet_id === pid);
    let completed = 0;
    const missing: string[] = [];
    for (const entry of entries) {
      try {
        await readFile(entry.result_path, "utf8");
        completed++;
      } catch {
        missing.push(entry.task_id);
      }
    }
    packetStatus.push({
      packet_id: pid,
      task_count: entries.length,
      completed_count: completed,
      missing_task_ids: missing,
    });
  }

  const totalTasks = packetStatus.reduce((s, p) => s + p.task_count, 0);
  const completedTasks = packetStatus.reduce((s, p) => s + p.completed_count, 0);
  const completedPackets = packetStatus.filter((p) => p.missing_task_ids.length === 0).length;

  console.log(JSON.stringify({
    run_id: activeDispatch.run_id,
    dispatch_status: activeDispatch.status,
    created_at: activeDispatch.created_at,
    total_packets: packetStatus.length,
    completed_packets: completedPackets,
    total_tasks: totalTasks,
    completed_tasks: completedTasks,
    missing_tasks: totalTasks - completedTasks,
    packets: packetStatus,
  }, null, 2));
}

async function main(argv: string[]): Promise<void> {
  setQuotaStateDir(join(homedir(), ".audit-code"));
  const command = argv[2] ?? "sample-run";
  switch (command) {
    case "sample-run":
      await runSample(argv);
      return;
    case "advance-audit":
      await cmdAdvanceAudit(argv);
      return;
    case "next-step":
      await cmdNextStep(argv);
      return;
    case "run-to-completion":
      await cmdRunToCompletion(argv);
      return;
    case "worker-run":
      await cmdWorkerRun(argv);
      return;
    case "import-external-analyzer":
      await cmdImportExternalAnalyzer(argv);
      return;
    case "intake":
      await cmdIntake(argv);
      return;
    case "plan":
      await cmdPlan(argv);
      return;
    case "ingest-results":
      await cmdIngestResults(argv);
      return;
    case "explain-task":
      await cmdExplainTask(argv);
      return;
    case "update-runtime-validation":
      await cmdUpdateRuntimeValidation(argv);
      return;
    case "validate":
      await cmdValidate(argv);
      return;
    case "validate-results":
      await cmdValidateResults(argv);
      return;
    case "requeue":
      await cmdRequeue(argv);
      return;
    case "synthesize":
      await cmdSynthesize(argv);
      return;
    case "cleanup":
      await cmdCleanup(argv);
      return;
    case "mcp":
      await cmdMcp(argv);
      return;
    case "prepare-dispatch":
      await cmdPrepareDispatch(argv);
      return;
    case "merge-and-ingest":
      await cmdMergeAndIngest(argv);
      return;
    case "submit-packet":
      await cmdSubmitPacket(argv);
      return;
    case "validate-result":
      await cmdValidateResult(argv);
      return;
    case "quota":
      await cmdQuota(argv);
      return;
    case "status":
      await cmdStatus(argv);
      return;
    case "dispatch-status":
      await cmdDispatchStatus(argv);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      console.error(
        "Available commands: sample-run, advance-audit, next-step, run-to-completion, worker-run, import-external-analyzer, intake, plan, ingest-results, explain-task, update-runtime-validation, validate, validate-results, requeue, synthesize, cleanup, mcp, prepare-dispatch, merge-and-ingest, submit-packet, validate-result, quota, status, dispatch-status",
      );
      process.exitCode = 1;
  }
}

export async function runCli(argv: string[]): Promise<void> {
  await main(argv).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isDirectCliExecution(argv: string[]): boolean {
  const entryPath = argv[1];
  if (!entryPath) {
    return false;
  }
  return resolve(entryPath) === fileURLToPath(import.meta.url);
}

if (isDirectCliExecution(process.argv)) {
  await runCli(process.argv);
}
