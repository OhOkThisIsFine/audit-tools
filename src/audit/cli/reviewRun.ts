import { access, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertSubmissionRunId,
  isFileMissingError,
  readJsonFile,
  writeJsonFile,
} from "audit-tools/shared";
import { withArtifactTreeHold } from "./auditStep.js";
import {
  type ArtifactBundle,
  loadArtifactBundle,
  writeCoreArtifacts,
} from "../io/artifacts.js";
import { deriveAuditState } from "../orchestrator/state.js";
import type { AuditState } from "../types/auditState.js";
import type { AuditTask } from "../types.js";
import {
  deriveReviewRunId,
  getRunPaths,
  isLegacyClockRunId,
  openReviewWavePath,
  reviewWaveClosedPath,
  reviewWaveDigest,
  writeReviewRunFiles,
} from "../io/runArtifacts.js";
import {
  buildAuditCodeHandoff,
  writeAuditCodeHandoffArtifacts,
  CURRENT_TASK_FILENAME,
} from "../supervisor/operatorHandoff.js";
import { ActiveReviewRunSchema, type ActiveReviewRun } from "../contracts/wrapperResponse.js";
import { addFileLineCountHints } from "./lineIndex.js";
import { buildPendingAuditTasks } from "./dispatch/packetFilter.js";
import { buildBlockedAuditState, buildManualReviewBlocker } from "./envelope.js";

/**
 * The persisted wave counter's contract. The file sits BESIDE the runs it counts
 * (under `runs/`) rather than inside `dispatch/`, so an artifacts dir's identity
 * bookkeeping travels with the thing it is bookkeeping for.
 */
const OPEN_REVIEW_WAVE_CONTRACT_VERSION = "audit-open-review-wave/v1alpha1";

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
  /**
   * Persist at this run id instead of deriving one — used ONLY to adopt a run an
   * earlier build minted (see `resolveReviewRun`). Never host-supplied.
   */
  runIdOverride?: string;
  /**
   * The wave generation this pause already resolved.
   * Absent means "resolve it here" — the direct-call path. Present means the
   * caller resolved it, which the pause does because the counter is advanced
   * exactly once, only on the branch that OPENS a wave.
   */
  waveGeneration?: number | null;
}

/**
 * Read the persisted wave generation.
 *
 * A counter file that is absent means no wave has been opened yet, and a file
 * that is present but unreadable or mis-shaped is treated as ABSENT too — the
 * value it carries is always PROMOTED (never served as-is), so a corrupt counter
 * costs at most one extra promotion and never a run identity that moves
 * underneath a worker. This read is on the fold's hot path, so it degrades
 * rather than throwing.
 */
async function readWaveGenerationFile(
  artifactsDir: string,
): Promise<number | null> {
  try {
    const value = await readJsonFile<unknown>(openReviewWavePath(artifactsDir));
    return parseWaveGeneration(value);
  } catch {
    return null;
  }
}

function parseWaveGeneration(value: unknown): number | null {
  if (typeof value !== "object" || value === null) return null;
  const generation = (value as { generation?: unknown }).generation;
  return typeof generation === "number" &&
    Number.isInteger(generation) &&
    generation >= 0
    ? generation
    : null;
}

/**
 * How many `runs/<id>/review-run.json` manifests the artifacts dir holds. Read
 * from the run DIRECTORIES, which are always present and never pruned, rather
 * than from a record that could have been lost.
 */
async function countOpenedReviewRuns(
  artifactsDir: string,
): Promise<number | null> {
  let entries;
  try {
    entries = await readdir(join(artifactsDir, "runs"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isFileMissingError(error)) return 0;
    return null;
  }
  const present = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) =>
        (await fileExists(
          join(artifactsDir, "runs", entry.name, "review-run.json"),
        ))
          ? 1
          : 0,
      ),
  );
  return present.reduce<number>((total, value) => total + value, 0);
}

/** Existence without a throw, for a scan that must never abort the fold. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The generation the OPEN wave's run is derived from.
 *
 * The counter names a generation, in the same units `deriveReviewRunId`
 * consumes, so the run directory it names is reachable from it
 * (`getRunPaths(artifactsDir, deriveReviewRunId(...))`). That directory's own
 * manifest is what proves the counter still names the open wave: present means
 * this artifacts dir has already opened the wave the counter names, and every
 * pause of that wave derives from it. Absent means the derivation under that
 * counter would land on a directory that is not this wave's, and the two states
 * that reach it are exactly the two ways the counter and the runs can disagree —
 * an artifacts dir whose `runs/` was removed wholesale (the counter outlived the
 * runs it named) and a `runs/` directory carried across an artifacts-dir RESET
 * (a new audit reusing the directory: the runs outlived the counter). Both
 * answer `runsOpen`, which is one more than the run directories on disk and
 * therefore a directory this wave has not taken.
 *
 * `runsOpen` is monotone because `runs/` is never pruned and every transition
 * here either keeps it or raises it by one — so a wave that has taken its
 * directory keeps it for its whole life, and the counter may be rewritten at any
 * point in that life without moving the identity underneath a worker.
 */
async function resolveWaveGeneration(
  artifactsDir: string,
): Promise<number | null> {
  const runsOpen = await countOpenedReviewRuns(artifactsDir);
  if (runsOpen === null) return null;
  const persisted = await readWaveGenerationFile(artifactsDir);
  if (persisted === null) return runsOpen;
  const openRunId = await openedRunIdForGeneration(artifactsDir, persisted);
  if (openRunId === null) return runsOpen;
  // The wave the counter names is on disk. It is still the OPEN wave unless its
  // own run directory says it drained — and when it does, this pause is the next
  // wave and must take a directory of its own.
  return (await isWaveClosed(artifactsDir, openRunId)) ? runsOpen : persisted;
}

/**
 * Is the wave this run belongs to fully accepted? Asked of the run's own dir.
 *
 * A marker that is absent, unreadable, mis-shaped, or names a different run is
 * NOT a closure: the question is asked from the run's own directory, where the
 * only writer is the publish of that run, so every other state means "no
 * statement has been made" and the wave stays open. Degrading that way is the
 * safe direction — an unread closure leaves the run where it is (a wave that
 * publishes again is still correct), while an invented one moves the identity
 * out from under every worker still writing.
 */
async function isWaveClosed(
  artifactsDir: string,
  runId: string,
): Promise<boolean> {
  try {
    const value = await readJsonFile<unknown>(
      reviewWaveClosedPath(artifactsDir, runId),
    );
    if (typeof value !== "object" || value === null) return false;
    const record = value as { run_id?: unknown; closed?: unknown };
    return record.closed === true && record.run_id === runId;
  } catch {
    return false;
  }
}

/**
 * The run directory the wave named by `generation` already opened, if any.
 *
 * Asked by SUBSTITUTION, not by a second marker: a derived id is
 * `<slug>-<digest>` where only the digest depends on the generation, so the
 * digest is matched against the directories' own trailing segments. The slug
 * half is deliberately not fixed — the wave a generation names may have been
 * opened by a different obligation than the one asking now.
 */
async function openedRunIdForGeneration(
  artifactsDir: string,
  generation: number,
): Promise<string | null> {
  const digest = reviewWaveDigest(generation);
  const openedIds = await listOpenedReviewRunIds(artifactsDir);
  return openedIds.find((runId) => runId.endsWith(`-${digest}`)) ?? null;
}

/** Every run directory id present under `runs/`, straight from `readdir`. */
async function listOpenedReviewRunIds(
  artifactsDir: string,
): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(artifactsDir, "runs"), {
      withFileTypes: true,
    });
    return entries.filter((entry) => entry.isDirectory()).map((e) => e.name);
  } catch (error) {
    if (isFileMissingError(error)) return [];
    throw error;
  }
}

/** Advance the persisted generation to name the wave this run belongs to. */
async function openReviewWave(
  artifactsDir: string,
  generation: number,
): Promise<void> {
  await mkdir(join(artifactsDir, "runs"), { recursive: true });
  await writeJsonFile(openReviewWavePath(artifactsDir), {
    contract_version: OPEN_REVIEW_WAVE_CONTRACT_VERSION,
    generation,
  });
}

export async function materializeReviewRun(
  params: MaterializeReviewRunParams,
): Promise<{ activeReviewRun: ActiveReviewRun; pendingTasks: AuditTask[] }> {
  // Derived AFTER the pending set is computed, deliberately: the id no longer
  // depends on it, and the ordering is what makes that visible — a partial
  // ingest shrinks the pending set, and must not move the run identity.
  const pendingTasks = await addFileLineCountHints(
    params.root,
    params.tasksOverride ?? buildPendingAuditTasks(params.bundle),
  );
  const generation =
    params.waveGeneration !== undefined
      ? params.waveGeneration
      : await resolveWaveGeneration(params.artifactsDir);
  const runId =
    params.runIdOverride ??
    deriveReviewRunId({
      obligationId: params.obligationId,
      waveGeneration: generation,
    });
  const paths = getRunPaths(params.artifactsDir, runId);
  const activeReviewRun: ActiveReviewRun = {
    contract_version: "audit-review-run/v1alpha1",
    run_id: runId,
    review_run_path: paths.reviewRunPath,
    pending_audit_tasks_path: paths.pendingTasksPath,
    host_workload_path: paths.hostWorkloadPath,
    host_result_map_path: paths.hostResultMapPath,
  };
  // The counter and the run directory are written together and the RESULT is
  // what makes the two agree: the derivation above is only ever read back
  // through `resolveWaveGeneration`, which checks the directory the counter
  // names. Whichever of these two lands first, the pair resolves to the same
  // generation — a counter ahead of its directory is corrected back to the
  // directory state, and a directory ahead of the counter is found by the
  // promotion. That is also what makes the NEXT wave open: once this wave's
  // pending set is fully accepted the obligation re-opens, the pause re-enters
  // here, the counter is proven stale (this wave is closed, but a new wave still
  // needs a directory of its OWN), and `runsOpen` is one more than this run.
  if (generation !== null) {
    await openReviewWave(params.artifactsDir, generation);
  }
  await writeReviewRunFiles(params.artifactsDir, activeReviewRun, pendingTasks);
  return { activeReviewRun, pendingTasks };
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
 * The active run, created or refreshed. Shared by both entry points below so the
 * resolution cannot differ between the locked and lock-free halves.
 *
 * The id is derived from (review obligation × wave generation), and the
 * generation moves at exactly one moment — when a wave OPENS. So the normal path
 * here is a single manifest read and a re-materialization: within one open wave
 * the derived id cannot move, however much a partial ingest shrinks the pending
 * set, and a run that is still owed work is by construction still the active
 * one. The branch that asked whether the persisted pending set still matched was
 * a decision with no distinguishable behaviour behind it — and it was the
 * mechanism that re-minted the whole wave on every ingest.
 *
 * The first branch is ADOPTION, and it is scoped to the transition itself. On an
 * artifacts dir the tool has never opened a wave for (no counter file), a run
 * minted by an EARLIER build may be in flight: its published workload, every
 * bound `result_path`, its accepted pair and its own `run_id` all hang off the
 * OLD id, and workers are holding bindings derived from it. Serving it under its
 * own id — refreshed in place at the current pending set — lets that wave drain
 * exactly as published, and the generation the promotion hands back is the one
 * that makes the NEXT wave derive a new id. The alternative strands those
 * workers or needs a cross-run copy of the accepted pair, which is a second
 * durable store for a fact the run directory already holds.
 *
 * Adoption is decided from the persisted id's FORMAT (`isLegacyClockRunId`) and
 * the absence of the counter, never from an instruction to the host.
 */
async function resolveReviewRun(
  params: ReviewPauseParams,
): Promise<ActiveReviewRun> {
  const active = await loadCurrentActiveReviewRun(params.artifactsDir);
  const persisted = await readWaveGenerationFile(params.artifactsDir);
  const adopted =
    persisted === null &&
    active !== null &&
    isLegacyClockRunId(active.run_id)
      ? active.run_id
      : null;
  if (adopted !== null) {
    // The active manifest is tool-owned and never host-supplied, but the adopted
    // id becomes a directory segment — so it clears the SAME grammar as any
    // other run id before it is used to build a path, exactly as the
    // host-handoff boundary does.
    assertSubmissionRunId(adopted, "audit review run id");
    const { activeReviewRun } = await materializeReviewRun({
      ...params,
      runIdOverride: adopted,
      waveGeneration: await resolveWaveGeneration(params.artifactsDir),
    });
    return activeReviewRun;
  }
  const generation = await resolveWaveGeneration(params.artifactsDir);
  const { activeReviewRun } = await materializeReviewRun({
    ...params,
    waveGeneration: generation,
  });
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
  await withArtifactTreeHold(params.artifactsDir, undefined, async () => {
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
