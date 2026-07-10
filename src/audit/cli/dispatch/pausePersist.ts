import { join } from "node:path";
import {
  readJsonFile,
  writeJsonFile,
  checkLivelockGuard,
  type PartialCompletionTerminal,
} from "audit-tools/shared";
import {
  ACTIVE_DISPATCH_FILENAME,
  type ActiveDispatchState,
  type DispatchPausedState,
} from "../../types/activeDispatch.js";

/**
 * Resumable-pause persistence on `active-dispatch.json`, single-sourced so the
 * IN-PROCESS rolling driver (`advanceRollingPause`) and the HOST-dispatch path
 * (`advanceHostDispatchPause`) share ONE copy. The paused_state ⊕
 * partial_completion_terminal mutual-exclusion invariant (activeDispatch.ts) is held
 * by these helpers clearing one when setting the other — a fork would let the two
 * producers violate it, so this extraction is load-bearing for correctness, not just DRY.
 */

/** Read the run's active-dispatch artifact, or null when absent / for another run. */
export async function readActiveDispatch(
  artifactsDir: string,
  runId: string,
): Promise<ActiveDispatchState | null> {
  const path = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  const existing = await readJsonFile<ActiveDispatchState>(path).catch(() => null);
  return existing && existing.run_id === runId ? existing : null;
}

/** Persist the resumable paused state onto the active-dispatch artifact. */
export async function persistPausedState(
  artifactsDir: string,
  runId: string,
  pausedState: DispatchPausedState,
): Promise<void> {
  const existing = await readActiveDispatch(artifactsDir, runId);
  if (!existing) return;
  await writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), {
    ...existing,
    paused_state: pausedState,
  } satisfies ActiveDispatchState);
}

/** Clear the paused state (run resumed or went terminal). */
export async function clearPausedState(
  artifactsDir: string,
  runId: string,
): Promise<void> {
  const existing = await readActiveDispatch(artifactsDir, runId);
  if (!existing || !existing.paused_state) return;
  const { paused_state: _dropped, ...rest } = existing;
  await writeJsonFile(join(artifactsDir, ACTIVE_DISPATCH_FILENAME), {
    ...rest,
  } satisfies ActiveDispatchState);
}

/**
 * Stamp the partial-completion terminal onto the run's active-dispatch artifact
 * (leaving every other field intact). The caller clears any paused_state first so the
 * two never coexist.
 */
export async function recordPartialCompletionTerminal(
  artifactsDir: string,
  runId: string,
  terminal: PartialCompletionTerminal,
): Promise<void> {
  const path = join(artifactsDir, ACTIVE_DISPATCH_FILENAME);
  const existing = await readJsonFile<ActiveDispatchState>(path).catch(() => null);
  if (!existing || existing.run_id !== runId) return;
  await writeJsonFile(path, {
    ...existing,
    partial_completion_terminal: terminal,
  } satisfies ActiveDispatchState);
}

/** Outcome of a host-path pause advance. */
export interface HostPauseAdvance {
  /** True when the run is (still) paused at the quota wall this pass. */
  paused: boolean;
  /** True when the pause hit the livelock bound → partial-completion terminal recorded. */
  livelocked: boolean;
}

/**
 * Advance the resumable pause on the HOST-dispatch path, decided from the FRESH
 * quota-wall snapshot (`atWall`) rather than provider re-discovery — a quota wall is
 * the SAME pool regaining capacity after a reset, which `advancePausedState`'s
 * new-provider test can never see (it would force livelock and make resume
 * impossible). Here `atWall` is re-evaluated against a fresh admission each next-step,
 * so a genuine reset clears the wall and resumes; the pure `checkLivelockGuard` still
 * bounds an indefinite stall to partial-coverage synthesis (read-only audit may
 * bound-and-give-up — remediate must not, hence the separate producers).
 */
export async function advanceHostDispatchPause(params: {
  artifactsDir: string;
  runId: string;
  atWall: boolean;
  /**
   * The WHOLE declined frontier this pass as PACKET ids — for the paused_state display
   * (never `frontier − granted`, which is empty in the cooldown over-grant case where
   * the whole frontier is granted yet nothing is dispatched).
   */
  strandedPacketIds: string[];
  /**
   * The same declined frontier expanded to its TASK ids — for the partial-completion
   * terminal on livelock. This MUST be task ids, not packet ids: `deriveAuditState`
   * marks `audit_tasks_completed` satisfied by matching the terminal's `stranded_ids`
   * against `task_id`, so packet ids would never unlock synthesis and the host run
   * would pause-loop forever (the exact case the livelock bound exists to end).
   */
  strandedTaskIds: string[];
  livelockLimit?: number;
}): Promise<HostPauseAdvance> {
  const { artifactsDir, runId, atWall, strandedPacketIds, strandedTaskIds } = params;
  const prior = await readActiveDispatch(artifactsDir, runId);
  const priorPaused = prior?.paused_state;

  if (!atWall) {
    // Wall cleared (or never hit): drop any carried pause so the next pass dispatches.
    if (priorPaused) await clearPausedState(artifactsDir, runId);
    return { paused: false, livelocked: false };
  }

  // First pause for this run: enter waiting_for_provider at pause_count 0.
  if (!priorPaused) {
    await persistPausedState(artifactsDir, runId, {
      lifecycle: {
        kind: "waiting_for_provider",
        paused_at: new Date().toISOString(),
        pause_count: 0,
        stranded_node_ids: strandedPacketIds,
      },
      // The host path decides running/paused from the fresh snapshot, not from a
      // settled-provider set, so no exclusions are carried.
      settled_exclusions: [],
    });
    return { paused: true, livelocked: false };
  }

  // Still walled on a subsequent pass: bump pause_count (netNewCapacity = 0 because we
  // are STILL at the wall) and bound livelock.
  const nextPauseCount = priorPaused.lifecycle.pause_count + 1;
  if (checkLivelockGuard(nextPauseCount, 0, params.livelockLimit)) {
    await clearPausedState(artifactsDir, runId);
    await recordPartialCompletionTerminal(artifactsDir, runId, {
      reason: "livelock_guard",
      stranded_ids: strandedTaskIds,
    });
    return { paused: true, livelocked: true };
  }
  await persistPausedState(artifactsDir, runId, {
    lifecycle: {
      kind: "waiting_for_provider",
      paused_at: priorPaused.lifecycle.paused_at,
      pause_count: nextPauseCount,
      stranded_node_ids: strandedPacketIds,
    },
    settled_exclusions: priorPaused.settled_exclusions,
  });
  return { paused: true, livelocked: false };
}
