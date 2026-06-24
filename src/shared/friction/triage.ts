import {
  type FrictionCaptureArtifact,
  FRICTION_CAPTURE_SCHEMA_VERSION,
  frictionCapturePath,
  sanitizeRunId,
} from '../io/frictionCapture.js';
import {
  type AgentReflection,
  AGENT_FEEDBACK_FILENAME,
  parseReflectionsNdjson,
} from '../agentReflections.js';
import { readOptionalJsonFile, readOptionalTextFile, writeJsonFile } from '../io/json.js';
import { withFileLock } from '../quota/fileLock.js';
import type { CapturedFrictionItem } from './captureFrictionEvent.js';

/**
 * O1 end-of-run friction TRIAGE — single-sourced for BOTH orchestrators so the
 * triage step shape, the disposition vocabulary, the blocking semantics, and the
 * close-out deciders cannot drift between the two halves of the pipeline. This is
 * the analog (and now the single source) of the former per-orchestrator
 * `decideAuditFrictionCloseout` / `decideRemediateFrictionCloseout` deciders,
 * collapsed here as one parameterized decider.
 *
 * What the triage gates:
 *  - The MECHANICAL friction events the O3/O2 seams accreted through the sink
 *    (`captureFrictionEvent` → the per-run `friction/<run_id>.json` record).
 *  - The OPT-IN agent-feedback reflections workers appended to
 *    `agent-feedback.jsonl` during the run.
 *
 * The satisfaction predicate set is the UNION of those two sources. The triage is
 * a MANDATORY, BLOCKING end-of-run step: it stays unsatisfied until every captured
 * event AND every surfaced reflection carries a recorded disposition. This is
 * DISTINCT from the optional, untouched mid-run worker reflection channel — a
 * worker MAY append a reflection line, but the blocking triage is the host's
 * end-of-run obligation to dispose of what was captured.
 *
 * False-green is dropped: an empty up-front zero-friction record NO LONGER
 * satisfies the close-out. Satisfaction requires either:
 *  - EMPTY SET: zero events AND zero reflections → trivially disposed (the
 *    close-out fires once, persists a disposed record, and never re-loops); or
 *  - DISPOSED: every event id and every reflection key has a `keep|discard|
 *    annotate` disposition recorded against it.
 *
 * Friction appends ride O2's `withFileLock` (keyed off the friction record path)
 * so a friction append never races the locked critical section.
 */

/** The triage disposition vocabulary — the host's verdict per captured item. */
export type FrictionDisposition = 'keep' | 'discard' | 'annotate';

/** The set of valid dispositions, for validation at the contract boundary. */
export const FRICTION_DISPOSITIONS: readonly FrictionDisposition[] = [
  'keep',
  'discard',
  'annotate',
];

/** Whether a value is a valid disposition (mechanical contract check). */
export function isFrictionDisposition(value: unknown): value is FrictionDisposition {
  return (
    typeof value === 'string' &&
    (FRICTION_DISPOSITIONS as readonly string[]).includes(value)
  );
}

/**
 * One triage record: a host disposition against a captured item key. `target_id`
 * is the friction-event id (mechanical sink) or the reflection key (a stable key
 * derived from a surfaced agent-feedback reflection). `annotation` is required
 * only for the `annotate` disposition.
 */
export interface FrictionDispositionRecord {
  target_id: string;
  disposition: FrictionDisposition;
  annotation?: string;
}

/** A captured item the host must dispose of, normalized across both sources. */
export interface TriageSubject {
  /** Stable key the disposition is recorded against. */
  id: string;
  /** Which source surfaced it — a mechanical event or an agent reflection. */
  source: 'event' | 'reflection';
  /** Human-readable summary for the triage prompt. */
  note: string;
}

/**
 * The mandatory blocking triage decision. `pending` means the close-out is NOT
 * satisfied — the host must record a disposition for every subject in `pending`
 * before the run can present complete. `action`:
 *  - "dispose"  → there are pending subjects; the run is BLOCKED on triage.
 *  - "disposed" → nothing pending (empty set, or all subjects disposed); the
 *    close-out is satisfied and the run proceeds. Fires at most once.
 */
export interface FrictionTriageDecision {
  action: 'dispose' | 'disposed';
  /** Subjects still awaiting a disposition (empty when `disposed`). */
  pending: TriageSubject[];
  /** The run_id-keyed friction record path (always set, for the handoff). */
  recordPath: string;
}

/** A stable key for a surfaced reflection (task_id + ordinal within the run). */
export function reflectionKey(reflection: AgentReflection, ordinal: number): string {
  return `reflection:${reflection.task_id}:${ordinal}`;
}

function summarizeReflection(reflection: AgentReflection): string {
  const parts: string[] = [`[${reflection.severity}] ${reflection.task_id}`];
  const detail = [
    ...(reflection.ambiguities ?? []),
    ...(reflection.tool_friction ?? []),
    ...(reflection.suggestions ?? []),
  ].filter((item) => item.trim().length > 0);
  if (detail.length > 0) parts.push(detail.join('; '));
  return parts.join(' — ');
}

function summarizeEvent(item: CapturedFrictionItem): string {
  const sev = item.severity ? `[${item.severity}] ` : '';
  return `${sev}${item.note}`;
}

/**
 * The per-run friction record the triage reads/writes. Extends the captured
 * artifact (mechanical events) with the host's `dispositions[]` — the tool owns
 * every field except the host-recorded disposition content.
 */
export interface TriagedFrictionArtifact
  extends Omit<FrictionCaptureArtifact, 'frictions'> {
  frictions: CapturedFrictionItem[];
  dispositions?: FrictionDispositionRecord[];
}

/** Where the friction append/triage lock lives (rides O2's withFileLock). */
export function frictionLockPath(artifactsDir: string, runId: string): string {
  return `${frictionCapturePath(artifactsDir, sanitizeRunId(runId))}.lock`;
}

async function readReflections(artifactsDir: string): Promise<AgentReflection[]> {
  const text = await readOptionalTextFile(
    `${artifactsDir}/${AGENT_FEEDBACK_FILENAME}`,
  );
  return text ? parseReflectionsNdjson(text) : [];
}

async function readRecord(
  artifactsDir: string,
  runId: string,
): Promise<TriagedFrictionArtifact | undefined> {
  return readOptionalJsonFile<TriagedFrictionArtifact>(
    frictionCapturePath(artifactsDir, sanitizeRunId(runId)),
  );
}

/**
 * Build the union triage-subject set for a run: every captured mechanical event
 * UNION every surfaced agent-feedback reflection. Deterministic — pure read off
 * the on-disk record + the reflections file, never host discretion.
 */
export async function collectTriageSubjects(
  artifactsDir: string,
  runId: string,
): Promise<TriageSubject[]> {
  const [record, reflections] = await Promise.all([
    readRecord(artifactsDir, runId),
    readReflections(artifactsDir),
  ]);

  const subjects: TriageSubject[] = [];
  for (const item of record?.frictions ?? []) {
    subjects.push({ id: item.id, source: 'event', note: summarizeEvent(item) });
  }
  reflections.forEach((reflection, index) => {
    subjects.push({
      id: reflectionKey(reflection, index),
      source: 'reflection',
      note: summarizeReflection(reflection),
    });
  });
  return subjects;
}

/**
 * The MANDATORY BLOCKING end-of-run triage close-out, single-sourced for both
 * orchestrators (caller passes its `tool`). Drops the former false-green: an
 * empty up-front record never satisfies — satisfaction is decided off the union
 * subject set vs. the recorded dispositions:
 *
 *  - empty set (zero events AND zero reflections) → "disposed" trivially, and a
 *    disposed record is persisted once so it never re-loops;
 *  - every subject disposed → "disposed";
 *  - any subject undisposed → "dispose" (the run is BLOCKED) with the pending
 *    subjects surfaced for the host to dispose of.
 *
 * Deterministic — keyed only off the on-disk record + reflections at
 * `(artifactsDir, runId)`. Never coupled to any repo's backlog doc. The persist
 * on the trivial-empty path rides O2's `withFileLock` so it cannot race a
 * concurrent friction append into the same record.
 */
export async function decideFrictionTriage(
  artifactsDir: string,
  runId: string,
  tool: FrictionCaptureArtifact['tool'],
): Promise<FrictionTriageDecision> {
  const recordPath = frictionCapturePath(artifactsDir, sanitizeRunId(runId));
  const subjects = await collectTriageSubjects(artifactsDir, runId);

  if (subjects.length === 0) {
    // Empty set: trivially disposed. Persist a disposed record once (under the
    // shared lock) so the close-out fires at most once and never re-loops.
    await appendFrictionUnderLock(
      artifactsDir,
      runId,
      (record) => ({
        ...record,
        tool: record.tool ?? tool,
        dispositions: record.dispositions ?? [],
      }),
      tool,
    );
    return { action: 'disposed', pending: [], recordPath };
  }

  const record = await readRecord(artifactsDir, runId);
  const disposed = new Set(
    (record?.dispositions ?? [])
      .filter((d) => isFrictionDisposition(d.disposition))
      .map((d) => d.target_id),
  );
  const pending = subjects.filter((subject) => !disposed.has(subject.id));

  return {
    action: pending.length === 0 ? 'disposed' : 'dispose',
    pending,
    recordPath,
  };
}

/**
 * Mutate the per-run friction record under O2's `withFileLock` so a friction
 * append (mechanical event OR host disposition) never races the locked critical
 * section. The mutator receives the current record (a fresh degrade-clean shell
 * when none exists) and returns the next record to persist atomically.
 */
export async function appendFrictionUnderLock(
  artifactsDir: string,
  runId: string,
  mutate: (record: TriagedFrictionArtifact) => Promise<TriagedFrictionArtifact> | TriagedFrictionArtifact,
  tool: FrictionCaptureArtifact['tool'] = 'remediate-code',
): Promise<TriagedFrictionArtifact> {
  const recordPath = frictionCapturePath(artifactsDir, sanitizeRunId(runId));
  return withFileLock(frictionLockPath(artifactsDir, runId), async () => {
    const existing = await readOptionalJsonFile<TriagedFrictionArtifact>(recordPath);
    const base: TriagedFrictionArtifact = existing ?? {
      schema_version: FRICTION_CAPTURE_SCHEMA_VERSION,
      tool,
      run_id: runId,
      captured_at: new Date().toISOString(),
      frictions: [],
      dispositions: [],
    };
    const next = await mutate(base);
    const persisted: TriagedFrictionArtifact = {
      ...next,
      captured_at: new Date().toISOString(),
    };
    await writeJsonFile(recordPath, persisted);
    return persisted;
  });
}

/**
 * Record one host disposition against a captured subject, under the shared lock.
 * Re-disposing the same `target_id` overwrites the prior verdict (idempotent on
 * the key). The `annotate` disposition carries the host annotation.
 */
export async function recordFrictionDisposition(
  artifactsDir: string,
  runId: string,
  disposition: FrictionDispositionRecord,
  tool: FrictionCaptureArtifact['tool'] = 'remediate-code',
): Promise<TriagedFrictionArtifact> {
  return appendFrictionUnderLock(
    artifactsDir,
    runId,
    (record) => {
      const dispositions = (record.dispositions ?? []).filter(
        (d) => d.target_id !== disposition.target_id,
      );
      dispositions.push(disposition);
      return { ...record, dispositions };
    },
    tool,
  );
}
