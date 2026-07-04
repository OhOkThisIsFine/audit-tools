import {
  type FrictionCaptureArtifact,
  frictionCapturePath,
  sanitizeRunId,
} from '../io/frictionCapture.js';
import {
  type AgentReflection,
  AGENT_FEEDBACK_FILENAME,
  parseReflectionsNdjson,
} from '../agentReflections.js';
import { readOptionalJsonFile, readOptionalTextFile } from '../io/json.js';
import {
  type CapturedFrictionItem,
  type FrictionCategoryAttestation,
  type FrictionDisposition,
  type FrictionDispositionRecord,
  type FrictionOpenObservation,
  type TriagedFrictionArtifact,
  appendFrictionUnderLock,
  frictionLockPath,
} from './frictionRecord.js';

export type {
  CapturedFrictionItem,
  FrictionCategoryAttestation,
  FrictionDisposition,
  FrictionDispositionRecord,
  FrictionOpenObservation,
  TriagedFrictionArtifact,
} from './frictionRecord.js';
export { appendFrictionUnderLock, frictionLockPath } from './frictionRecord.js';

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
 * Named friction dimensions the host is prompted to reflect on — optional finer
 * "what happened" hints an observation MAY carry. The REQUIRED coverage axis is
 * `FRICTION_CATEGORIES` below, not these.
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
 * The REQUIRED friction CATEGORIES — the coverage axis the blocking close-out
 * enforces EVERY run. The host must, for EACH category, either record ≥1
 * `open_observations[]` entry tagged with it OR an explicit
 * `category_attestations[]` "nothing to report". A category can never be skipped
 * by silence — that omission is exactly the failure this gate prevents.
 */
export const FRICTION_CATEGORIES = [
  'ambiguous_direction',   // direction/decision the tool or prompt left to the host that it should have resolved
  'tool_should_decide',    // the host had to remember / notice / enforce something the tool should guarantee
  'inefficient_feeding',   // redundant or wasteful work, poor context feeding, or a tool inefficiency
] as const;
export type FrictionCategory = (typeof FRICTION_CATEGORIES)[number];

/** One-line human labels for each category, shown in the triage prompt. */
export const FRICTION_CATEGORY_LABELS: Record<FrictionCategory, string> = {
  ambiguous_direction:
    'ambiguous-direction — a decision the tool/prompt left to you that it should have resolved',
  tool_should_decide:
    'tool-should-decide — something you had to remember/notice/enforce that the tool should guarantee',
  inefficient_feeding:
    'inefficient-feeding — redundant/wasteful work, poor context feeding, or a tool inefficiency',
};

/** Whether a value is one of the required friction categories (contract check). */
export function isFrictionCategory(value: unknown): value is FrictionCategory {
  return (
    typeof value === 'string' &&
    (FRICTION_CATEGORIES as readonly string[]).includes(value)
  );
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
  /**
   * True while any required friction category is still uncovered (no observation
   * AND no attestation). Named `needs_open_observations` for continuity; it now
   * means "the host still owes a per-category disposition", i.e.
   * `missing_categories.length > 0`.
   */
  needs_open_observations: boolean;
  /** Categories still lacking BOTH an observation and an attestation. */
  missing_categories: FrictionCategory[];
  /** Open observations already recorded (empty on first call). */
  existing_observations: FrictionOpenObservation[];
  /** Per-category "nothing to report" attestations already recorded. */
  existing_attestations: FrictionCategoryAttestation[];
  /** Free-form notes already recorded (undefined when none). */
  free_form_notes?: string;
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
  const existingAttestations: FrictionCategoryAttestation[] = record.category_attestations ?? [];
  const disposed = new Set(
    (record.dispositions ?? [])
      .filter((d) => isFrictionDisposition(d.disposition))
      .map((d) => d.target_id),
  );
  const pending = subjects.filter((subject) => !disposed.has(subject.id));

  // A category is COVERED by ≥1 observation tagged with it OR an explicit
  // attestation. Every required category must be covered — silence never counts.
  const covered = new Set<FrictionCategory>();
  for (const obs of existingObservations) {
    if (isFrictionCategory(obs.category)) covered.add(obs.category);
  }
  for (const att of existingAttestations) {
    if (isFrictionCategory(att.category)) covered.add(att.category);
  }
  const missing_categories = FRICTION_CATEGORIES.filter((c) => !covered.has(c));
  const needs_open_observations = missing_categories.length > 0;

  return {
    action: pending.length === 0 && !needs_open_observations ? 'disposed' : 'dispose',
    pending,
    recordPath,
    needs_open_observations,
    missing_categories,
    existing_observations: existingObservations,
    existing_attestations: existingAttestations,
    free_form_notes: record.free_form_notes,
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
  const dimensionList = FRICTION_NAMED_DIMENSIONS.map(
    (d) => `\`${d}\``,
  ).join(", ");

  const pendingSection =
    triage.pending.length > 0
      ? `\n### Pending dispositions (REQUIRED)\n\nFor each item, append to \`dispositions[]\`:\n` +
        '`{ "target_id": "<id>", "disposition": "keep|discard|annotate", "annotation": "..." }`\n\n' +
        triage.pending
          .map((s) => `- \`${s.id}\` (${s.source}) — ${s.note}`)
          .join("\n") +
        "\n"
      : "";

  const covered = (c: FrictionCategory): boolean =>
    !triage.missing_categories.includes(c);
  const categoryLines = FRICTION_CATEGORIES.map((c) => {
    const status = covered(c) ? "✓ covered" : "✗ MISSING — owe an entry or attestation";
    return `- \`${c}\` — ${FRICTION_CATEGORY_LABELS[c]}\n    (${status})`;
  }).join("\n");

  const categorySection = triage.needs_open_observations
    ? `\n### Per-category friction walk (REQUIRED — every category)\n\n` +
      `Walk ALL three categories. For EACH, either record ≥1 observation OR explicitly attest none — ` +
      `a category may NEVER be left silent.\n\n` +
      categoryLines +
      `\n\nAppend an observation to \`open_observations[]\` (repeat per finding):\n` +
      '`{ "category": "<one of the three>", "dimension": "<optional hint>", "note": "<what happened>" }`\n\n' +
      `Or attest a category clean in \`category_attestations[]\`:\n` +
      '`{ "category": "<one of the three>", "note": "<optional: why nothing to report>" }`\n\n' +
      `Optional finer \`dimension\` hints: ${dimensionList}.\n`
    : `\n### Per-category friction walk\n\nAll three categories covered ` +
      `(${triage.existing_observations.length} observation(s), ${triage.existing_attestations.length} attestation(s)).\n`;

  const freeFormSection =
    `\n### Free-form notes (optional)\n\nAnything that fits no category — set \`free_form_notes\` (a string) on the record.` +
    (triage.free_form_notes ? " Already recorded." : "") +
    "\n";

  return `\n## Run friction triage (BLOCKING close-out)\n\nWrite to the friction record at:\n\`${triage.recordPath}\`${pendingSection}${categorySection}${freeFormSection}\nCall next-step again after writing.\n`;
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
