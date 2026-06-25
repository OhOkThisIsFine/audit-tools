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
 * Named friction dimensions the host is prompted to reflect on. At least one
 * open observation (any dimension, including "other") is required every run.
 */
export const FRICTION_NAMED_DIMENSIONS = [
  'gate_reloops',               // obligations that re-fired after appearing done
  'integration_guard_failures', // lint / typecheck / build / test failures from real bugs
  'rescopes',                   // tasks that required narrowing or splitting
  'surprises',                  // unexpected tool or code behavior
  'manual_interventions',       // out-of-band actions outside normal flow
  'other',                      // anything not covered above
] as const;
export type FrictionDimension = (typeof FRICTION_NAMED_DIMENSIONS)[number] | string;

/**
 * One proactive friction observation the host records — distinct from a
 * mechanical-event disposition. Every run MUST carry ≥1 entry; "no friction
 * encountered this run" as `other` is a valid observation.
 */
export interface FrictionOpenObservation {
  dimension: string;
  note: string;
}

/**
 * The mandatory blocking triage decision. `pending` means the close-out is NOT
 * satisfied. `action`:
 *  - "dispose"  → run is BLOCKED (pending subjects and/or no open observations).
 *  - "disposed" → all subjects disposed AND ≥1 open observation written.
 */
export interface FrictionTriageDecision {
  action: 'dispose' | 'disposed';
  /** Subjects still awaiting a disposition (empty when all disposed). */
  pending: TriageSubject[];
  /** The run_id-keyed friction record path (always set). */
  recordPath: string;
  /** True when no open observations have been written yet. */
  needs_open_observations: boolean;
  /** Open observations already recorded (empty on first call). */
  existing_observations: FrictionOpenObservation[];
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
 * artifact (mechanical events) with the host's `dispositions[]` and the
 * host's open `open_observations[]` — the tool owns every field except the
 * host-recorded content.
 */
export interface TriagedFrictionArtifact
  extends Omit<FrictionCaptureArtifact, 'frictions'> {
  frictions: CapturedFrictionItem[];
  dispositions?: FrictionDispositionRecord[];
  open_observations?: FrictionOpenObservation[];
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
 * orchestrators (caller passes its `tool`). Two satisfaction requirements:
 *
 *  1. Every captured mechanical event AND every surfaced agent-feedback
 *     reflection carries a `keep|discard|annotate` disposition.
 *  2. The record carries ≥1 open observation (`open_observations[]`). Even
 *     "no friction encountered" as `other` satisfies this — the host must
 *     actively reflect, not auto-approve.
 *
 * The former trivial "empty set → disposed" path is intentionally dropped: a
 * run with zero mechanical events still requires the host to confirm that zero
 * friction occurred. The record file is materialized on first call so the host
 * always has an existing file to append to.
 *
 * Deterministic — keyed only off the on-disk record + reflections at
 * `(artifactsDir, runId)`. Never coupled to any repo's backlog doc.
 */
export async function decideFrictionTriage(
  artifactsDir: string,
  runId: string,
  tool: FrictionCaptureArtifact['tool'],
): Promise<FrictionTriageDecision> {
  const recordPath = frictionCapturePath(artifactsDir, sanitizeRunId(runId));
  const subjects = await collectTriageSubjects(artifactsDir, runId);

  // Materialize the record on first call so the host always appends to an
  // existing file rather than creating it from scratch.
  let record = await readRecord(artifactsDir, runId);
  if (!record) {
    record = await appendFrictionUnderLock(
      artifactsDir,
      runId,
      (r) => ({ ...r, tool: r.tool ?? tool }),
      tool,
    );
  }

  const existingObservations: FrictionOpenObservation[] = record.open_observations ?? [];
  const disposed = new Set(
    (record.dispositions ?? [])
      .filter((d) => isFrictionDisposition(d.disposition))
      .map((d) => d.target_id),
  );
  const pending = subjects.filter((subject) => !disposed.has(subject.id));
  const needs_open_observations = existingObservations.length === 0;

  return {
    action: pending.length === 0 && !needs_open_observations ? 'disposed' : 'dispose',
    pending,
    recordPath,
    needs_open_observations,
    existing_observations: existingObservations,
  };
}

/**
 * Render the friction-triage block for a `present_report` step prompt.
 * Single-sourced in shared so both orchestrators use the exact same prompt
 * shape — the host's obligation never drifts between audit and remediate.
 *
 * The block is MANDATORY and BLOCKING every run: the host must (1) dispose of
 * every mechanical event/reflection and (2) write ≥1 open observation before
 * the run may present complete.
 */
export function buildFrictionTriageBlock(triage: FrictionTriageDecision): string {
  const dimensionList = [
    "  gate_reloops               — obligations that re-fired after appearing done",
    "  integration_guard_failures — lint/typecheck/build/test failures from real bugs",
    "  rescopes                   — tasks that required narrowing or splitting",
    "  surprises                  — unexpected tool or code behavior",
    "  manual_interventions       — out-of-band actions outside normal flow",
    "  other                      — anything else (including 'no friction this run')",
  ].join("\n");

  const pendingSection =
    triage.pending.length > 0
      ? `\n### Pending dispositions (REQUIRED)\n\nFor each item, append to \`dispositions[]\`:\n` +
        '`{ "target_id": "<id>", "disposition": "keep|discard|annotate", "annotation": "..." }`\n\n' +
        triage.pending
          .map((s) => `- \`${s.id}\` (${s.source}) — ${s.note}`)
          .join("\n") +
        "\n"
      : "";

  const observationSection = triage.needs_open_observations
    ? `\n### Open observations (REQUIRED — ≥1 entry)\n\nReflect on what friction occurred, then append ≥1 entry to \`open_observations[]\`:\n` +
      '`{ "dimension": "<see below>", "note": "<your observation>" }`\n\n' +
      "Dimensions (pick the most relevant; 'other' covers anything not listed):\n" +
      dimensionList +
      "\n\nIf no friction occurred: `{ \"dimension\": \"other\", \"note\": \"No friction encountered this run.\" }`\n"
    : `\n### Open observations\n\nAlready recorded (${triage.existing_observations.length} entr${triage.existing_observations.length === 1 ? "y" : "ies"}).\n`;

  return `\n## Run friction triage (BLOCKING close-out)\n\nWrite to the friction record at:\n\`${triage.recordPath}\`${pendingSection}${observationSection}\nCall next-step again after writing.\n`;
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
