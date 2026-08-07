import { join } from "node:path";
import {
  checkLivelockGuard,
  createLockedJsonStore,
  SKIP_WRITE,
  type LockedJsonStore,
  type PartialCompletionTerminal,
} from "audit-tools/shared";
import {
  ACTIVE_DISPATCH_FILENAME,
  type ActiveDispatchState,
  type DispatchPausedState,
} from "../../types/activeDispatch.js";

const ACTIVE_DISPATCH_LOCK_FILENAME = "active-dispatch.lock";

/**
 * Resumable-pause persistence on `active-dispatch.json`, single-sourced so the
 * IN-PROCESS rolling driver (`advanceRollingPause`) and the HOST-dispatch path
 * (`advanceHostDispatchPause`) share ONE copy.
 *
 * `paused_state` ⊕ `partial_completion_terminal` is an ASYMMETRIC invariant, not
 * a symmetric mutual exclusion (CP-NODE-6): stamping a terminal ALWAYS clears any
 * paused_state (below, `recordPartialCompletionTerminal` does this atomically —
 * callers no longer order two calls by hand), but a terminal, once stamped, is a
 * ONE-WAY RATCHET for the run — it must SURVIVE every later write under the same
 * run_id, including a later `persistPausedState` (a routine follow-up pass over
 * tasks outside the terminal's `stranded_ids`; see `advanceRollingPause`). Erasing
 * it would also reset `lifecycle.pause_count` to 0, forcing the livelock bound to
 * re-earn `LIVELOCK_PAUSE_LIMIT` from scratch and breaking the no-indefinite-stall
 * guarantee CP-NODE-7's stranded-subtraction completion gate rests on. Every write
 * below therefore starts from a freshly-read `current` and only ever ADDS/REMOVES
 * its own field — never rebuilding the record from scratch — so an already-stamped
 * terminal is preserved by construction, not by caller discipline.
 *
 * Every read-modify-write below goes through the shared locked-JSON store
 * (`createLockedJsonStore`), so two concurrent advancers on the same run_id (e.g.
 * a host-dispatch pass and an in-process rolling pass racing on the same
 * artifacts dir) can never interleave read↔write and lose one another's update —
 * no bespoke lock is added here.
 */
function activeDispatchStore(
  artifactsDir: string,
): LockedJsonStore<ActiveDispatchState | null> {
  return createLockedJsonStore<ActiveDispatchState | null>({
    path: join(artifactsDir, ACTIVE_DISPATCH_FILENAME),
    lockPath: join(artifactsDir, ACTIVE_DISPATCH_LOCK_FILENAME),
    parse: (raw) => (raw as ActiveDispatchState | undefined) ?? null,
  });
}

/**
 * Read the run's active-dispatch artifact, or null when absent / for another
 * run. A plain lockless read (matches the store's own `read()` contract) — the
 * three mutators below are the ones that need TOCTOU safety.
 */
export async function readActiveDispatch(
  artifactsDir: string,
  runId: string,
): Promise<ActiveDispatchState | null> {
  const existing = await activeDispatchStore(artifactsDir).read();
  return existing && existing.run_id === runId ? existing : null;
}

/** Persist the resumable paused state onto the active-dispatch artifact. */
export async function persistPausedState(
  artifactsDir: string,
  runId: string,
  pausedState: DispatchPausedState,
): Promise<void> {
  await activeDispatchStore(artifactsDir).mutate((current) => {
    if (!current || current.run_id !== runId) return SKIP_WRITE;
    // Spread `current` (never rebuild) so an already-stamped
    // partial_completion_terminal survives this write untouched (the ratchet).
    return {
      ...current,
      paused_state: pausedState,
    } satisfies ActiveDispatchState;
  });
}

/** Clear the paused state (run resumed or went terminal). */
export async function clearPausedState(
  artifactsDir: string,
  runId: string,
): Promise<void> {
  await activeDispatchStore(artifactsDir).mutate((current) => {
    if (!current || current.run_id !== runId || !current.paused_state) {
      return SKIP_WRITE;
    }
    const { paused_state: _dropped, ...rest } = current;
    return { ...rest } satisfies ActiveDispatchState;
  });
}

/**
 * Stamp the partial-completion terminal onto the run's active-dispatch artifact
 * (leaving every other field intact) and atomically clear any paused_state in
 * the SAME write — the caller no longer needs to call `clearPausedState` first;
 * the mutual exclusion on the WAY IN is guaranteed here, not by call-site order.
 */
export async function recordPartialCompletionTerminal(
  artifactsDir: string,
  runId: string,
  terminal: PartialCompletionTerminal,
): Promise<void> {
  await activeDispatchStore(artifactsDir).mutate((current) => {
    if (!current || current.run_id !== runId) return SKIP_WRITE;
    const { paused_state: _dropped, ...rest } = current;
    return {
      ...rest,
      partial_completion_terminal: terminal,
    } satisfies ActiveDispatchState;
  });
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
  /**
   * D2: true when the in-process (NIM) partition ingested results THIS pass. Such a
   * pass is PROGRESS, not a stall — the wall-pass counter resets to 0, so a hybrid run
   * whose in-process partition keeps covering ground never trips the host livelock
   * give-up (which exists to bound an indefinite STALL, not steady partial progress).
   */
  madeProgress?: boolean;
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

  // Progress pass: still walled for the host complement, but the in-process partition
  // covered ground — reset the counter so steady progress never trips the livelock.
  if (params.madeProgress) {
    await persistPausedState(artifactsDir, runId, {
      lifecycle: {
        kind: "waiting_for_provider",
        paused_at: priorPaused?.lifecycle.paused_at ?? new Date().toISOString(),
        pause_count: 0,
        stranded_node_ids: strandedPacketIds,
      },
      settled_exclusions: priorPaused?.settled_exclusions ?? [],
    });
    return { paused: true, livelocked: false };
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
