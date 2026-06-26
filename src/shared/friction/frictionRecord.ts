import { join } from "node:path";
import {
  type FrictionCaptureArtifact,
  type FrictionItem,
  FRICTION_CAPTURE_SCHEMA_VERSION,
  frictionCaptureDir,
  frictionCapturePath,
  sanitizeRunId,
} from "../io/frictionCapture.js";
import { readOptionalJsonFile, writeJsonFile } from "../io/json.js";
import { withFileLock } from "../quota/fileLock.js";

/**
 * The shared per-run friction RECORD substrate (CE-004 / CE-010, the O1
 * FRICTION-FOUNDATION layer). Single-sourced for BOTH orchestrators so the
 * record shape, the lock path, and the locked read-merge-write append cannot
 * drift between the two halves of the pipeline.
 *
 * `captureFrictionEvent` (the mechanical sink) and `recordFrictionDisposition` /
 * `decideFrictionTriage` (the host triage path) BOTH route their record
 * mutations through `appendFrictionUnderLock`, which rides ONE
 * `withFileLock(frictionLockPath)` and reads-then-MERGEs the existing record —
 * so a late mechanical emit never clobbers host `dispositions[]` /
 * `open_observations[]` already written, and a host disposition never drops a
 * concurrently-appended mechanical `frictions[]` entry (CE-010).
 *
 * Every path derives from `node:path` joins off the supplied artifacts dir
 * (via `frictionCapturePath` / `sanitizeRunId`) — no platform-baked literal, so
 * the substrate is OS/path-agnostic (INV-O1-7).
 */

/** A single captured mechanical friction event: a `FrictionItem` plus a stable id. */
export interface CapturedFrictionItem extends FrictionItem {
  /** Stable distinct id; re-recording an event with this id is a no-op de-dup. */
  id: string;
}

/** The host disposition vocabulary over a captured subject. */
export type FrictionDisposition = "keep" | "discard" | "annotate";

/** One host disposition recorded against a captured subject (event/reflection). */
export interface FrictionDispositionRecord {
  /** The captured subject's stable key (event id or reflection key). */
  target_id: string;
  /** The host's verdict on the subject. */
  disposition: FrictionDisposition;
  /** Optional free-form annotation (carried by the `annotate` disposition). */
  annotation?: string;
}

/** One mandatory end-of-run open observation along a named friction dimension. */
export interface FrictionOpenObservation {
  /** The named friction dimension (or a free-form string). */
  dimension: string;
  /** The host's observation note. */
  note: string;
}

/**
 * The full per-run friction record on disk — the base capture artifact, the
 * accreted mechanical events, plus the host-owned triage overlay
 * (`dispositions[]` / `open_observations[]`). The base `frictions` field is
 * narrowed to `CapturedFrictionItem[]` (each carries an `id`).
 */
export interface TriagedFrictionArtifact extends FrictionCaptureArtifact {
  frictions: CapturedFrictionItem[];
  /** Host dispositions, keyed by `target_id` (latest verdict wins). */
  dispositions?: FrictionDispositionRecord[];
  /** Host open observations (≥1 required to satisfy the blocking close-out). */
  open_observations?: FrictionOpenObservation[];
}

/**
 * `<artifactsDir>/friction/<run_id>.lock` — the lock path guarding the per-run
 * record. Single-sourced so every record mutator (mechanical sink + host triage)
 * serializes on the SAME lock (CE-004). Sibling of the record file, so it stays
 * within the friction dir and is OS/path-agnostic.
 */
export function frictionLockPath(artifactsDir: string, runId: string): string {
  return join(frictionCaptureDir(artifactsDir), `${sanitizeRunId(runId)}.lock`);
}

/** A fresh, empty record for a run (the clean-degrade base, `frictions: []`). */
function emptyRecord(
  runId: string,
  tool: FrictionCaptureArtifact["tool"],
): TriagedFrictionArtifact {
  return {
    schema_version: FRICTION_CAPTURE_SCHEMA_VERSION,
    tool,
    run_id: runId,
    captured_at: new Date().toISOString(),
    frictions: [],
  };
}

/**
 * Apply `mutate` to the per-run friction record under the shared lock, then
 * persist the result atomically and return it.
 *
 * The critical section reads the CURRENT record (materializing an empty base on
 * first touch), hands it to `mutate`, and writes the returned record back via
 * the shared atomic `writeJsonFile` (temp-then-rename). Because the read and the
 * write both happen inside ONE `withFileLock(frictionLockPath)`, two concurrent
 * appenders never lost-update each other's fields — the late writer always sees
 * the earlier writer's merged record (CE-010). `mutate` must be pure and
 * total (it returns the next record); it never performs IO of its own.
 */
export async function appendFrictionUnderLock(
  artifactsDir: string,
  runId: string,
  mutate: (record: TriagedFrictionArtifact) => TriagedFrictionArtifact,
  tool: FrictionCaptureArtifact["tool"] = "remediate-code",
): Promise<TriagedFrictionArtifact> {
  return withFileLock(frictionLockPath(artifactsDir, runId), async () => {
    const existing = await readOptionalJsonFile<TriagedFrictionArtifact>(
      frictionCapturePath(artifactsDir, runId),
    );
    const base = existing ?? emptyRecord(runId, tool);
    const next = mutate(base);
    await writeJsonFile(frictionCapturePath(artifactsDir, runId), next);
    return next;
  });
}
