import {
  type FrictionCaptureArtifact,
  type FrictionItem,
  FRICTION_CAPTURE_SCHEMA_VERSION,
  frictionCapturePath,
  sanitizeRunId,
} from '../io/frictionCapture.js';
import { readOptionalJsonFile, writeJsonFile } from '../io/json.js';

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
 *  - OS/PATH-AGNOSTIC: the record path comes only from the substrate's
 *    `frictionCapturePath` (node:path joins off `artifactsDir` + `sanitizeRunId`);
 *    no platform-baked literal, never coupled to any repo doc (INV-O1-7).
 *
 * This is the substrate-wrapping sink only: live triage dispositions over the
 * accreted events are owned by O1's triage module, the locked append ordering by
 * O2 — this layer just appends one de-duped event, best-effort.
 */

/** A single mechanical friction event recorded through the sink. */
export interface FrictionEvent extends FrictionItem {
  /**
   * Stable distinct id for this logical event. Re-recording an event with an id
   * already present in the run record is a no-op (per-event de-dup, INV-O1-6).
   */
  id: string;
}

/** A friction record item carrying its mechanical-event de-dup id. */
export interface CapturedFrictionItem extends FrictionItem {
  id: string;
}

/** The per-run friction artifact whose `frictions[]` carry event de-dup ids. */
type CapturedFrictionArtifact = Omit<FrictionCaptureArtifact, 'frictions'> & {
  frictions: CapturedFrictionItem[];
};

/**
 * Append one mechanical friction event to the per-run record, best-effort.
 *
 * Never throws: any failure (missing/locked dir, malformed existing record,
 * write contention) is swallowed so the calling obligation is never broken
 * (INV-O1-5, FAIL-O1-3). De-duped on `event.id` (INV-O1-6, FAIL-O1-5).
 */
export async function captureFrictionEvent(
  artifactsDir: string,
  runId: string,
  event: FrictionEvent,
  tool: FrictionCaptureArtifact['tool'] = 'remediate-code',
): Promise<void> {
  try {
    const path = frictionCapturePath(artifactsDir, sanitizeRunId(runId));
    const existing = await readOptionalJsonFile<CapturedFrictionArtifact>(path);

    const frictions: CapturedFrictionItem[] = Array.isArray(existing?.frictions)
      ? existing!.frictions
      : [];

    // Per-event de-dup: drop an event whose id is already recorded.
    if (frictions.some((item) => item.id === event.id)) {
      return;
    }

    const artifact: CapturedFrictionArtifact = {
      schema_version: FRICTION_CAPTURE_SCHEMA_VERSION,
      tool: existing?.tool ?? tool,
      run_id: runId,
      captured_at: new Date().toISOString(),
      frictions: [...frictions, { ...event }],
    };

    await writeJsonFile(path, artifact);
  } catch {
    // Best-effort: swallow every failure so capture never breaks the obligation.
  }
}
