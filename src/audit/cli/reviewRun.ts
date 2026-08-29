import { join } from "node:path";
import {
  artifactTreeLockPath,
  isFileMissingError,
  readJsonFile,
  withFileLock,
} from "audit-tools/shared";
import {
  type ArtifactBundle,
  loadArtifactBundle,
  writeCoreArtifacts,
} from "../io/artifacts.js";
import { deriveAuditState } from "../orchestrator/state.js";
import type { AuditState } from "../types/auditState.js";
import type { AuditTask } from "../types.js";
import {
  buildRunId,
  getRunPaths,
  writeReviewRunFiles,
} from "../io/runArtifacts.js";
import {
  buildAuditCodeHandoff,
  writeAuditCodeHandoffArtifacts,
  CURRENT_TASK_FILENAME,
} from "../supervisor/operatorHandoff.js";
import { ActiveReviewRunSchema, type ActiveReviewRun } from "../contracts/wrapperResponse.js";
import { addFileLineCountHints } from "./lineIndex.js";
import { buildPendingAuditTasks } from "./dispatch.js";
import { buildBlockedAuditState, buildManualReviewBlocker } from "./envelope.js";

function isActiveReviewRun(value: unknown): value is ActiveReviewRun {
  return ActiveReviewRunSchema.safeParse(value).success;
}

export async function loadCurrentActiveReviewRun(
  artifactsDir: string,
): Promise<ActiveReviewRun | null> {
  const path = join(artifactsDir, "dispatch", CURRENT_TASK_FILENAME);
  try {
    const value = await readJsonFile<unknown>(path);
    if (!isActiveReviewRun(value)) {
      throw new Error(`Invalid audit review-run manifest: ${path}`);
    }
    return value;
  } catch (error) {
    if (isFileMissingError(error)) return null;
    throw error;
  }
}

export async function writeHandoffOnly(params: {
  root: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  audit_state: AuditState;
  progress_summary: string;
  isConfigError?: boolean;
  activeReviewRun?: ActiveReviewRun;
}): Promise<void> {
  await writeAuditCodeHandoffArtifacts(
    buildAuditCodeHandoff({
      root: params.root,
      artifactsDir: params.artifactsDir,
      state: params.audit_state,
      bundle: params.bundle,
      progressSummary: params.progress_summary,
      isConfigError: params.isConfigError,
      activeReviewRun: params.activeReviewRun,
    }),
  );
}

export interface MaterializeReviewRunParams {
  root: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  obligationId: string | null;
  /** Retained only for call-shape stability; execution is host-owned. */
  selfCliPath?: string;
  /** Retained only for call-shape stability; audit-tools launches nothing. */
  timeoutMs?: number;
  tasksOverride?: AuditTask[];
}

export async function materializeReviewRun(
  params: MaterializeReviewRunParams,
): Promise<{ activeReviewRun: ActiveReviewRun; pendingTasks: AuditTask[] }> {
  const runId = buildRunId(params.obligationId, 1);
  const paths = getRunPaths(params.artifactsDir, runId);
  const pendingTasks = await addFileLineCountHints(
    params.root,
    params.tasksOverride ?? buildPendingAuditTasks(params.bundle),
  );
  const activeReviewRun: ActiveReviewRun = {
    contract_version: "audit-review-run/v1alpha1",
    run_id: runId,
    review_run_path: paths.reviewRunPath,
    pending_audit_tasks_path: paths.pendingTasksPath,
    host_workload_path: paths.hostWorkloadPath,
    host_result_map_path: paths.hostResultMapPath,
  };
  await writeReviewRunFiles(params.artifactsDir, activeReviewRun, pendingTasks);
  return { activeReviewRun, pendingTasks };
}

function sortedTaskIds(tasks: readonly AuditTask[]): string[] {
  return tasks.map((task) => task.task_id).sort();
}

function sameTaskIds(left: readonly AuditTask[], right: readonly AuditTask[]): boolean {
  const leftIds = sortedTaskIds(left);
  const rightIds = sortedTaskIds(right);
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((taskId, index) => taskId === rightIds[index])
  );
}

interface ReviewPauseParams {
  root: string;
  artifactsDir: string;
  bundle: ArtifactBundle;
  state: AuditState;
  obligationId: string | null;
  selfCliPath?: string;
  timeoutMs?: number;
}

interface ReviewPause {
  state: AuditState;
  bundle: ArtifactBundle;
  activeReviewRun: ActiveReviewRun;
}

/**
 * Reuse the active run while its pending manifest still names the same tasks;
 * otherwise mint a fresh one. Shared by both entry points below so the reuse
 * rule cannot differ between the locked and lock-free halves.
 */
async function resolveReviewRun(
  params: ReviewPauseParams,
): Promise<ActiveReviewRun> {
  const currentPending = buildPendingAuditTasks(params.bundle);
  const existingRun = await loadCurrentActiveReviewRun(params.artifactsDir);
  if (existingRun) {
    try {
      const existingPending = await readJsonFile<AuditTask[]>(
        existingRun.pending_audit_tasks_path,
      );
      if (sameTaskIds(existingPending, currentPending)) return existingRun;
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
    }
  }

  const { activeReviewRun } = await materializeReviewRun(params);
  return activeReviewRun;
}

/** The blocked state and bundle a review pause hands back. Writes NOTHING. */
function buildReviewPause(
  params: ReviewPauseParams,
  activeReviewRun: ActiveReviewRun,
): ReviewPause & { blocker: string } {
  const blocker = buildManualReviewBlocker();
  const blockedState =
    params.bundle.audit_state?.status === "blocked"
      ? params.bundle.audit_state
      : buildBlockedAuditState({
          state: params.state,
          obligationId: params.obligationId,
          executor: "semantic_review_executor",
          blocker,
        });
  return {
    state: blockedState,
    bundle: { ...params.bundle, audit_state: blockedState },
    activeReviewRun,
    blocker,
  };
}

/** Handoff artifacts only — no core artifacts, so no artifact-tree lock. */
async function writeReviewPauseHandoff(
  params: ReviewPauseParams,
  pause: ReviewPause & { blocker: string },
): Promise<void> {
  await writeHandoffOnly({
    root: params.root,
    artifactsDir: params.artifactsDir,
    bundle: pause.bundle,
    audit_state: pause.state,
    progress_summary: pause.blocker,
    activeReviewRun: pause.activeReviewRun,
  });
}

/**
 * The lock-free half, for the fold — which already holds the artifact-tree lock
 * for its whole drain, so the acquisition above would be a second one on a
 * non-reentrant lock and would time out deterministically.
 *
 * It also does not persist the core artifacts: under persist-once the fold's
 * own halt writes them, and the blocked bundle it returns is what the fold
 * carries there.
 */
export async function ensureSemanticReviewRunUnlocked(
  params: ReviewPauseParams,
): Promise<ReviewPause> {
  const activeReviewRun = await resolveReviewRun(params);
  const pause = buildReviewPause(params, activeReviewRun);
  await writeReviewPauseHandoff(params, pause);
  return { state: pause.state, bundle: pause.bundle, activeReviewRun };
}

export async function persistConfigErrorHandoff(params: {
  root: string;
  artifactsDir: string;
  progressSummary: string;
}): Promise<void> {
  await withFileLock(artifactTreeLockPath(params.artifactsDir), async () => {
    const bundle = await loadArtifactBundle(params.artifactsDir);
    const blockedState = buildBlockedAuditState({
      state: bundle.audit_state ?? deriveAuditState(bundle),
      obligationId: null,
      executor: null,
      blocker: params.progressSummary,
    });
    const blockedBundle = { ...bundle, audit_state: blockedState };
    await writeCoreArtifacts(params.artifactsDir, blockedBundle);
    await writeAuditCodeHandoffArtifacts(
      buildAuditCodeHandoff({
        root: params.root,
        artifactsDir: params.artifactsDir,
        state: blockedState,
        bundle: blockedBundle,
        progressSummary: params.progressSummary,
        isConfigError: true,
      }),
    );
  });
}
