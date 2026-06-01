import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readJsonFile, writeJsonFile } from "@audit-tools/shared";
import type { SessionConfig } from "@audit-tools/shared";
import { buildQuotaSource } from "@audit-tools/shared/quota/compositeQuotaSource";
import {
  loadArtifactBundle,
  writeCoreArtifacts,
  promoteFinalAuditReport,
} from "../io/artifacts.js";
import type { AuditResult, AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import type { WorkerResult } from "../types/workerResult.js";
import { decideNextStep } from "../orchestrator/nextStep.js";
import { deriveAuditState } from "../orchestrator/state.js";
import {
  estimateTaskGroupTokens,
  sizeIndexFromManifest,
} from "../orchestrator/reviewPackets.js";
import {
  createFreshSessionProvider,
  resolveFreshSessionProviderName,
} from "../providers/index.js";
import { LOCAL_SUBPROCESS_PROVIDER_NAME } from "../providers/constants.js";
import { loadSessionConfig } from "../supervisor/sessionConfig.js";
import { appendRunLedgerEntry } from "../supervisor/runLedger.js";
import type { ActiveReviewRun } from "../supervisor/operatorHandoff.js";
import {
  buildRunId,
  clearDispatchFiles,
  ensureSupervisorDirs,
  getRunPaths,
  writeDispatchBatchFiles,
  writeWorkerTaskFiles,
  type RunPaths,
} from "../io/runArtifacts.js";
import { renderWorkerPrompt } from "../prompts/renderWorkerPrompt.js";
import {
  validateAuditResults,
  formatAuditResultIssues,
} from "../validation/auditResults.js";
import {
  scheduleWave,
  buildProviderModelKey,
  readQuotaState,
  recordWaveOutcome,
  resolveHostActiveSubagentLimit,
  detectRateLimitError,
  computeCooldownUntil,
  runSlidingWindow,
  lookupDiscoveredLimits,
  updateDiscoveredLimits,
  mergeDiscoveredLimits,
  getHeaderExtractorForProvider,
} from "../quota/index.js";
import type { DiscoveredRateLimits } from "../quota/index.js";
import { runAuditStep } from "./auditStep.js";
import { persistConfigErrorHandoff } from "./reviewRun.js";
import {
  buildBlockedAuditState,
  buildManualReviewBlocker,
  emitEnvelope,
  shouldRunInlineExecutor,
} from "./envelope.js";
import { renderSemanticReviewStep } from "./semanticReviewStep.js";
import { buildPendingAuditTasks } from "./dispatch.js";
import {
  addFileLineCountHints,
  buildLineIndexForPaths,
} from "./lineIndex.js";
import {
  WORKER_RESULT_CONTRACT_VERSION,
  buildWorkerResult,
  persistWorkerRunArtifacts,
  isWorkerResult,
  buildWorkerFailureBlocker,
} from "./workerResult.js";
import {
  readWaveManifest,
  writeWaveManifest,
  removeWaveManifest,
  buildWaveSlotEntry,
} from "./waveManifest.js";
import { cleanupStaleArtifactsDir } from "./cleanup.js";
import {
  getRootDir,
  warnIfNotGitRepo,
  getArtifactsDir,
  getUiMode,
  getMaxRuns,
  getAgentBatchSize,
  getParallelWorkers,
  getTimeoutMs,
  getHostModel,
  getBatchResultsDir,
  getFlag,
  listBatchResultFiles,
  getExplicitProvider,
  chunkArray,
  resolveHostDispatchCapability,
  getOptionalBooleanFlag,
  getHostMaxActiveSubagents,
  summarizeLaunchExit,
} from "./args.js";

export async function cmdRunToCompletion(argv: string[]): Promise<void> {
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
