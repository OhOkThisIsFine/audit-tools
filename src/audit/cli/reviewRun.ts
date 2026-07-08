import { join } from "node:path";
import {
  artifactTreeLockPath,
  isFileMissingError,
  readJsonFile,
  withFileLock,
  writeJsonFile,
} from "audit-tools/shared";
import {
  type ArtifactBundle,
  loadArtifactBundle,
  writeCoreArtifacts,
} from "../io/artifacts.js";
import { deriveAuditState } from "../orchestrator/state.js";
import type { AuditState } from "../types/auditState.js";
import type { AuditTask } from "../types.js";
import type { WorkerTask } from "../types/workerSession.js";
import {
  buildRunId,
  getRunPaths,
  writeWorkerTaskFiles,
} from "../io/runArtifacts.js";
import { renderWorkerPrompt } from "../prompts/renderWorkerPrompt.js";
import {
  buildAuditCodeHandoff,
  writeAuditCodeHandoffArtifacts,
  type ActiveReviewRun,
} from "../supervisor/operatorHandoff.js";
import { WORKER_COMMAND_PROVIDER_NAME } from "../providers/constants.js";
import { addFileLineCountHints } from "./lineIndex.js";
import { buildPendingAuditTasks } from "./dispatch.js";
import { buildBlockedAuditState, buildManualReviewBlocker } from "./envelope.js";

export function activeReviewRunFromTask(
  artifactsDir: string,
  task: WorkerTask,
): ActiveReviewRun | null {
  if (task.preferred_executor !== "agent" || !task.audit_results_path) {
    return null;
  }
  const paths = getRunPaths(artifactsDir, task.run_id);
  return {
    run_id: task.run_id,
    task_path: paths.taskPath,
    prompt_path: paths.promptPath,
    pending_audit_tasks_path: task.pending_audit_tasks_path,
    audit_results_path: task.audit_results_path,
    worker_command: task.worker_command,
  };
}

export async function loadCurrentActiveReviewRun(
  artifactsDir: string,
): Promise<ActiveReviewRun | null> {
  try {
    const task = await readJsonFile<WorkerTask>(
      join(artifactsDir, "dispatch", "current-task.json"),
    );
    return activeReviewRunFromTask(artifactsDir, task);
  } catch (error) {
    if (isFileMissingError(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeHandoffOnly(params: {
  root: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  audit_state: AuditState;
  progress_summary: string;
  providerName?: string | null;
  isConfigError?: boolean;
  activeReviewRun?: ActiveReviewRun;
}): Promise<void> {
  const handoff = buildAuditCodeHandoff({
    root: params.root,
    artifactsDir: params.artifactsDir,
    state: params.audit_state,
    bundle: params.bundle,
    providerName: params.providerName,
    progressSummary: params.progress_summary,
    isConfigError: params.isConfigError,
    activeReviewRun: params.activeReviewRun,
  });
  await writeAuditCodeHandoffArtifacts(handoff);
}

/** Inputs needed to materialize a semantic-review run's on-disk artifacts. */
export interface MaterializeReviewRunParams {
  root: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  obligationId: string | null;
  selfCliPath: string;
  timeoutMs: number;
  /**
   * Materialize the review over an explicit task subset rather than the full
   * coverage-derived pending set. The A-8 hybrid's in-process run passes the NIM
   * PARTITION so the run's pending-audit-tasks.json lists exactly those tasks — which is
   * what `driveRollingAuditDispatch`'s mergeAndIngest reads to fold the NIM results. The
   * host complement is NOT passed here: once the NIM tasks are ingested+covered, the host
   * `ensureSemanticReviewRun` re-derives the complement from coverage automatically.
   */
  tasksOverride?: AuditTask[];
  /**
   * Whether this run owns the shared host-facing dispatch pointer
   * (`dispatch/current-task.json`, which `loadCurrentActiveReviewRun` reads). Default
   * true (the host review run IS the current run). The A-8 hybrid's EPHEMERAL in-process
   * NIM run passes false: it must NOT become the "current" run, or the subsequent host
   * `ensureSemanticReviewRun` would reuse the NIM partition's task set (orphaning the
   * complement) instead of re-deriving the full coverage-driven host complement.
   */
  updateDispatch?: boolean;
}

/**
 * Materialize a semantic-review run's on-disk artifacts — the deterministic run id
 * (`buildRunId(obligationId, 1)`), pending-audit-tasks.json, task.json, and the
 * worker prompt — and return the active review run. This is the pure run-setup the
 * host-subagent path (`ensureSemanticReviewRun`) and the in-process rolling path
 * (`driveRollingAuditDispatch`) share; it writes NO blocked state and NO handoff,
 * so the in-process driver doesn't have to first stamp a misleading "manual review"
 * block it immediately drives past.
 */
export async function materializeReviewRun(
  params: MaterializeReviewRunParams,
): Promise<{ task: WorkerTask; activeReviewRun: ActiveReviewRun }> {
  const runId = buildRunId(params.obligationId, 1);
  const paths = getRunPaths(params.artifactsDir, runId);
  const pendingTasks = await addFileLineCountHints(
    params.root,
    params.tasksOverride ?? buildPendingAuditTasks(params.bundle),
  );
  const pendingTasksPath = join(paths.runDir, "pending-audit-tasks.json");
  const auditResultsPath = join(paths.runDir, "run-results.json");
  const taskReadPaths = new Set<string>();
  for (const pt of pendingTasks) {
    for (const fp of pt.file_paths) taskReadPaths.add(fp);
  }
  const task: WorkerTask = {
    contract_version: "audit-code-worker/v1alpha1",
    run_id: runId,
    repo_root: params.root,
    artifacts_dir: params.artifactsDir,
    obligation_id: params.obligationId,
    preferred_executor: "agent",
    result_path: paths.resultPath,
    worker_command: [
      process.execPath,
      params.selfCliPath,
      "worker-run",
      "--task",
      paths.taskPath,
    ],
    audit_results_path: auditResultsPath,
    pending_audit_tasks_path: pendingTasksPath,
    timeout_ms: params.timeoutMs,
    max_retries: 0,
    access: {
      read_paths: [...taskReadPaths],
      write_paths: [auditResultsPath, paths.resultPath],
    },
  };
  const prompt = renderWorkerPrompt(task);
  await writeWorkerTaskFiles(
    task,
    prompt,
    paths,
    params.artifactsDir,
    pendingTasks,
    { updateDispatch: params.updateDispatch },
  );
  await writeJsonFile(pendingTasksPath, pendingTasks);

  const activeReviewRun = activeReviewRunFromTask(params.artifactsDir, task);
  if (!activeReviewRun) {
    throw new Error("Internal error: failed to materialize active review run.");
  }
  return { task, activeReviewRun };
}

export async function ensureSemanticReviewRun(params: {
  root: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  state: AuditState;
  obligationId: string | null;
  selfCliPath: string;
  timeoutMs: number;
}): Promise<{ state: AuditState; bundle: ArtifactBundle; activeReviewRun: ActiveReviewRun }> {
  const existingRun = await loadCurrentActiveReviewRun(params.artifactsDir);
  if (existingRun) {
    const blockedState =
      params.bundle.audit_state?.status === "blocked"
        ? params.bundle.audit_state
        : buildBlockedAuditState({
            state: params.state,
            obligationId: params.obligationId,
            executor: "agent",
            blocker: buildManualReviewBlocker(WORKER_COMMAND_PROVIDER_NAME),
          });
    const blockedBundle = { ...params.bundle, audit_state: blockedState };
    await withFileLock(artifactTreeLockPath(params.artifactsDir), () =>
      writeCoreArtifacts(params.artifactsDir, blockedBundle),
    );
    await writeHandoffOnly({
      root: params.root,
      artifactsDir: params.artifactsDir,
      bundle: blockedBundle,
      audit_state: blockedState,
      progress_summary: buildManualReviewBlocker(WORKER_COMMAND_PROVIDER_NAME),
      providerName: WORKER_COMMAND_PROVIDER_NAME,
      activeReviewRun: existingRun,
    });
    return {
      state: blockedState,
      bundle: blockedBundle,
      activeReviewRun: existingRun,
    };
  }

  const blockedState = buildBlockedAuditState({
    state: params.state,
    obligationId: params.obligationId,
    executor: "agent",
    blocker: buildManualReviewBlocker(WORKER_COMMAND_PROVIDER_NAME),
  });
  await withFileLock(artifactTreeLockPath(params.artifactsDir), () =>
    writeCoreArtifacts(params.artifactsDir, {
      ...params.bundle,
      audit_state: blockedState,
    }),
  );

  const { activeReviewRun } = await materializeReviewRun(params);
  const blockedBundle = {
    ...params.bundle,
    audit_state: blockedState,
  };
  await writeHandoffOnly({
    root: params.root,
    artifactsDir: params.artifactsDir,
    bundle: blockedBundle,
    audit_state: blockedState,
    progress_summary: buildManualReviewBlocker(WORKER_COMMAND_PROVIDER_NAME),
    providerName: WORKER_COMMAND_PROVIDER_NAME,
    activeReviewRun,
  });
  return { state: blockedState, bundle: blockedBundle, activeReviewRun };
}

export async function persistConfigErrorHandoff(params: {
  root: string;
  artifactsDir: string;
  progressSummary: string;
}): Promise<void> {
  // O2: load→modify→persist is one artifact-tree mutation; hold the lock across
  // the whole RMW so it never interleaves with a concurrent next-step/ingest.
  await withFileLock(artifactTreeLockPath(params.artifactsDir), () =>
    persistConfigErrorHandoffLocked(params),
  );
}

async function persistConfigErrorHandoffLocked(params: {
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
