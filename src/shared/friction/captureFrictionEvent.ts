import { type FrictionCaptureArtifact, type FrictionItem } from "../io/frictionCapture.js";
import {
  type CapturedFrictionItem,
  type FrictionCategory,
  appendFrictionUnderLock,
} from "./frictionRecord.js";

export type { CapturedFrictionItem } from "./frictionRecord.js";

/**
 * The single mechanical-friction sink (FC-005). Mechanical seams (O3
 * validation/coercion/repair warnings; O2 recovery / ingest-merge-retry) call
 * `captureFrictionEvent(artifactsDir, runId, event)` with a stable distinct
 * event id; the call accretes the event onto the per-run friction record that
 * `src/shared/io/frictionCapture.ts` owns.
 *
 * This module is landed FIRST, before O1's full triage UI, as a callable,
 * inert-no-op-safe API so O2/O3 can wire it at their seams immediately.
 *
 * Guaranteed properties (INV-O1-5 / INV-O1-6 / INV-O1-7, FC-005):
 *  - BEST-EFFORT / NON-FATAL: every read/write is swallowed. A failed or
 *    contended capture write NEVER throws into the in-flight obligation — the
 *    sink resolves regardless. A caller may `await` it or fire-and-forget.
 *  - NO-OP-SAFE: callable before any triage UI exists; with nothing wired it is
 *    a pure append to an otherwise-unread per-run record, and a missing/locked
 *    artifacts dir simply degrades to a swallowed write.
 *  - IDEMPOTENT / PER-EVENT DE-DUP: an event whose `id` already appears in the
 *    run record is dropped, so re-entrant passes (re-dispatch, retry) never
 *    double-record the same logical event (INV-O1-6, FAIL-O1-5).
 *  - LOCKED + MERGE-PRESERVING (CE-004 / CE-010): the append rides the SAME
 *    `withFileLock(frictionLockPath)` as the host triage path and reads-then-
 *    merges the current record, so a late mechanical emit never clobbers host
 *    `dispositions[]` / `open_observations[]` already written to the record.
 *  - OS/PATH-AGNOSTIC: the record path comes only from the substrate's
 *    `frictionCapturePath` (node:path joins off `artifactsDir` + `sanitizeRunId`);
 *    no platform-baked literal, never coupled to any repo doc (INV-O1-7).
 *
 * This is the substrate-wrapping sink only: live triage dispositions over the
 * accreted events are owned by O1's triage module, the locked append ordering by
 * the shared `frictionRecord` substrate — this layer just appends one de-duped
 * event, best-effort.
 */

/** A single mechanical friction event recorded through the sink. */
export interface FrictionEvent extends FrictionItem {
  /**
   * Stable distinct id for this logical event. Re-recording an event with an id
   * already present in the run record is a no-op (per-event de-dup, INV-O1-6).
   */
  id: string;
  /**
   * The REAL close-out category (one of `FRICTION_CATEGORIES`) this event feeds.
   * Carried through onto the persisted `CapturedFrictionItem` so the per-category
   * friction walk keys on a real category, not the coarse `bug|trap|suggestion`
   * origin hint. Optional so a bare `captureFrictionEvent` caller need not supply it.
   */
  frictionCategory?: FrictionCategory;
  /**
   * Optional artifact/subject key — the aggregation axis that collapses N
   * same-artifact events into ONE derived observation.
   */
  artifact?: string;
}

/**
 * Append one mechanical friction event to the per-run record, best-effort.
 *
 * Never throws: any failure (missing/locked dir, malformed existing record,
 * write contention) is swallowed so the calling obligation is never broken
 * (INV-O1-5, FAIL-O1-3). De-duped on `event.id` (INV-O1-6, FAIL-O1-5). Rides the
 * shared `withFileLock` and MERGES the existing record, so host
 * `dispositions[]` / `open_observations[]` survive a late emit (CE-004 / CE-010).
 */
export async function captureFrictionEvent(
  artifactsDir: string,
  runId: string,
  event: FrictionEvent,
  tool: FrictionCaptureArtifact["tool"] = "remediate-code",
): Promise<void> {
  try {
    await appendFrictionUnderLock(
      artifactsDir,
      runId,
      (record) => {
        const frictions: CapturedFrictionItem[] = Array.isArray(record.frictions)
          ? record.frictions
          : [];
        // Per-event de-dup: drop an event whose id is already recorded. The
        // record (incl. host dispositions / open observations) is returned
        // unchanged so the locked merge preserves every existing field.
        if (frictions.some((item) => item.id === event.id)) {
          return record;
        }
        return {
          ...record,
          tool: record.tool ?? tool,
          frictions: [...frictions, { ...event }],
        };
      },
      tool,
    );
  } catch {
    // Best-effort: swallow every failure so capture never breaks the obligation.
  }
}
