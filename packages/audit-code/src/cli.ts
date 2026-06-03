import {
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepoManifest } from "./extractors/fileInventory.js";
import { buildFileDisposition } from "./extractors/disposition.js";
import { buildCriticalFlowManifest } from "./extractors/flows.js";
import { buildSurfaceManifest } from "./extractors/surfaces.js";
import { buildUnitManifest } from "./orchestrator/unitBuilder.js";
import { buildFlowCoverage } from "./orchestrator/flowCoverage.js";
import {
  buildRuntimeValidationTasks,
} from "./orchestrator/runtimeValidation.js";
import { initializeCoverageFromPlan } from "./orchestrator/planning.js";
import {
  loadArtifactBundle,
  writeCoreArtifacts,
  promoteFinalAuditReport,
} from "./io/artifacts.js";
import {
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
  prefixValidationIssues,
  DEFAULT_EMPIRICAL_HALF_LIFE_HOURS,
} from "@audit-tools/shared";
import { buildQuotaSource } from "@audit-tools/shared/quota/compositeQuotaSource";
import { validateArtifactBundle } from "./validation/artifacts.js";
import {
  validateAuditResults,
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
import {
  createFreshSessionProvider,
  resolveFreshSessionProviderName,
} from "./providers/index.js";
import {
  getSessionConfigPath,
  loadSessionConfig,
  readSessionConfigFile,
} from "./supervisor/sessionConfig.js";
import {
  clearDispatchFiles,
  ensureSupervisorDirs,
} from "./io/runArtifacts.js";
import type {
  AuditResult,
  AuditTask,
} from "./types.js";
import type { AuditState } from "./types/auditState.js";
import type {
  SessionConfig,
} from "@audit-tools/shared";
import type { ExternalAnalyzerResults } from "./types/externalAnalyzer.js";
import { runAuditCodeMcpServer } from "./mcp/server.js";
import {
  scheduleWave,
  buildProviderModelKey,
  readQuotaState,
  resolveLimits,
  resolveHostActiveSubagentLimit,
  computeMaxSafeConcurrency,
  getQuotaStatePath,
  lookupDiscoveredLimits,
  setQuotaStateDir,
} from "./quota/index.js";

import {
  resolveHostDispatchCapability,
  DIRECT_CLI_DEFAULTS,
  getFlag,
  hasFlag,
  fromBase64Url,
  taskResultPath,
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
  resolveRunProviderName,
  chunkArray,
  getUiMode,
  looksLikeCliFlag,
  countLines,
} from "./cli/args.js";
import {
  type ActiveDispatchState,
  ACTIVE_DISPATCH_FILENAME,
  loadDispatchResultMap,
  prepareDispatchArtifacts,
} from "./cli/dispatch.js";
import {
  buildLineIndex,
} from "./cli/lineIndex.js";
import {
  emitEnvelope,
} from "./cli/envelope.js";
import { persistConfigErrorHandoff } from "./cli/reviewRun.js";
import {
  runAuditStep,
  ingestBatchAuditResults,
} from "./cli/auditStep.js";
import { packageRoot } from "./cli/paths.js";
import { cmdNextStep } from "./cli/nextStepCommand.js";
import { cmdRunToCompletion } from "./cli/runToCompletion.js";
import { cmdWorkerRun } from "./cli/workerRunCommand.js";
import { cmdSubmitPacket } from "./cli/submitPacketCommand.js";
import { cmdMergeAndIngest } from "./cli/mergeAndIngestCommand.js";
import { cmdStatus } from "./cli/statusCommand.js";
import { cleanupStaleArtifactsDir } from "./cli/cleanup.js";

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
          await validateConfiguredProviderEnvironment(rawSessionConfig as SessionConfig),
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

async function cmdMcp(argv: string[]): Promise<void> {
  await runAuditCodeMcpServer(argv.slice(3));
}

async function cmdQuota(argv: string[]): Promise<void> {
  const artifactsDir = getArtifactsDir(argv);
  const sessionConfig = await loadSessionConfig(artifactsDir).catch(() => ({} as SessionConfig));
  const explicitProvider = getExplicitProvider(argv);
  const hostModel = getHostModel(argv);
  const providerName = resolveFreshSessionProviderName(explicitProvider, sessionConfig);
  const providerModelKey = buildProviderModelKey(providerName, hostModel);

  const { limits, source, confidence } = resolveLimits({ providerName, sessionConfig, hostModel });

  const quotaState = await readQuotaState().catch((): { version: 2; entries: Record<string, never> } => ({ version: 2, entries: {} }));
  const quotaStateEntry = quotaState.entries[providerModelKey] ?? null;
  const halfLifeHours =
    sessionConfig.quota?.empirical_half_life_hours ??
    DEFAULT_EMPIRICAL_HALF_LIFE_HOURS;
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
