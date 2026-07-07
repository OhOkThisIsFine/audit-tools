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
  type FrictionCategory,
  type FrictionCategoryAttestation,
  type FrictionDisposition,
  type FrictionDispositionRecord,
  type FrictionOpenObservation,
  type TriagedFrictionArtifact,
  FRICTION_CATEGORIES,
  appendFrictionUnderLock,
  frictionLockPath,
  isFrictionCategory,
} from './frictionRecord.js';

export type {
  CapturedFrictionItem,
  FrictionCategory,
  FrictionCategoryAttestation,
  FrictionDisposition,
  FrictionDispositionRecord,
  FrictionOpenObservation,
  TriagedFrictionArtifact,
} from './frictionRecord.js';
export {
  FRICTION_CATEGORIES,
  appendFrictionUnderLock,
  frictionLockPath,
  isFrictionCategory,
} from './frictionRecord.js';

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

/** One-line human labels for each category, shown in the triage prompt. */
export const FRICTION_CATEGORY_LABELS: Record<FrictionCategory, string> = {
  ambiguous_direction:
    'ambiguous-direction — a decision the tool/prompt left to you that it should have resolved',
  tool_should_decide:
    'tool-should-decide — something you had to remember/notice/enforce that the tool should guarantee',
  inefficient_feeding:
    'inefficient-feeding — redundant/wasteful work, poor context feeding, or a tool inefficiency',
};

/**
 * Cost signals measured across an aggregate of same-category (and, where
 * applicable, same-artifact) mechanical events. These are what let the walk say
 * "this was expensive re-work" quantitatively, not just "something happened".
 */
export interface FrictionCostSignals {
  /**
   * Round-trips: the number of aggregated mechanical events. Each backend
   * step-boundary fact is one avoidable round-trip (a re-emit, a repair round, a
   * re-derive, …), so the event count IS the round-trip count.
   */
  round_trips: number;
  /**
   * Verbatim re-authors: aggregated events whose subject artifact was touched by
   * MORE THAN ONE event — i.e. the same artifact was re-worked repeatedly. This
   * is the "we re-authored the same thing again" signal.
   */
  verbatim_re_authors: number;
  /**
   * Summed token cost across the aggregated events, when the events carried a
   * `tokens` measure (0 when none did — token accounting stays best-effort and
   * never fabricated).
   */
  tokens: number;
}

/**
 * The threshold an aggregate must reach to SURFACE as a pre-populated,
 * auto-covering observation. Below it, the aggregate is still reported (so the
 * host sees it) but does NOT auto-cover its category — the host still walks it.
 * "Below MUST NOT fire" is the contract: a single, cheap round-trip is noise, not
 * a surfaced friction observation.
 */
export const FRICTION_COST_SURFACE_THRESHOLD = 2;

/** Whether an aggregate's cost is at/above the surface threshold (fires). */
export function costSignalsSurface(signals: FrictionCostSignals): boolean {
  return signals.round_trips >= FRICTION_COST_SURFACE_THRESHOLD;
}

/**
 * ONE derived observation aggregated from N same-category mechanical events. This
 * is the pre-populated close-out entry: N same-artifact backend facts collapse
 * into a SINGLE `inefficient_feeding` (or other-category) observation with the
 * measured cost signals and the covered event ids.
 */
export interface DerivedFrictionObservation {
  /** The real close-out category this aggregate covers. */
  category: FrictionCategory;
  /** The aggregation subject (the shared artifact key, or "(mixed)" when several). */
  artifact: string;
  /** The ids of the mechanical events folded into this observation. */
  event_ids: string[];
  /** The measured cost across the folded events. */
  cost: FrictionCostSignals;
  /**
   * True when the aggregate's cost is at/above the surface threshold: only these
   * pre-populate/auto-cover the category. A below-threshold aggregate is still
   * listed for the host but never fires (never auto-covers).
   */
  surfaced: boolean;
  /** A ready-to-paste observation note summarizing the aggregate + cost. */
  note: string;
}

/**
 * The aggregation subject key for a mechanical event — the axis that collapses N
 * same-subject events into ONE observation. Prefer the explicit `artifact`, then
 * the coarse `area`, then the event id (per-instance, so an id-keyed event never
 * folds with another — it stays a round_trips=1 singleton, below threshold).
 */
function aggregationKey(item: CapturedFrictionItem): string {
  return item.artifact ?? item.area ?? item.id;
}

/**
 * Measure the cost signals across an aggregate of mechanical events. Pure and
 * deterministic — round_trips is the event count (each backend fact is one
 * avoidable round-trip), verbatim_re_authors fires only when the SAME subject was
 * touched by MORE THAN ONE event, and tokens sums the best-effort per-event
 * measure (never fabricated: a missing/non-finite `tokens` contributes 0).
 */
export function measureFrictionCost(
  items: readonly CapturedFrictionItem[],
): FrictionCostSignals {
  const round_trips = items.length;
  const verbatim_re_authors = round_trips > 1 ? round_trips : 0;
  const tokens = items.reduce(
    (sum, item) =>
      sum +
      (typeof item.tokens === "number" && Number.isFinite(item.tokens)
        ? item.tokens
        : 0),
    0,
  );
  return { round_trips, verbatim_re_authors, tokens };
}

function derivedObservationNote(
  agg: Omit<DerivedFrictionObservation, "note" | "surfaced">,
  sample: string,
): string {
  const tokenPart = agg.cost.tokens > 0 ? `, ~${agg.cost.tokens} tokens` : "";
  const repeat =
    agg.cost.verbatim_re_authors > 0
      ? `, ${agg.cost.verbatim_re_authors} repeat re-work`
      : "";
  return (
    `auto-captured: ${agg.cost.round_trips} mechanical ${agg.category} ` +
    `event(s) on \`${agg.artifact}\`${repeat}${tokenPart}. e.g. ${sample}`
  );
}

/**
 * Aggregate the run's mechanical events into ONE derived observation per
 * (real category, artifact) group — the pre-population source for the host's
 * category walk. Pure and deterministic:
 *
 *  - ONLY events carrying a REAL `frictionCategory` feed the walk; an untagged
 *    legacy event covers no category (it is a bare pending subject, not a walk
 *    contribution) so pre-population never invents coverage.
 *  - N same-artifact same-category events collapse to ONE observation carrying
 *    the measured cost (`measureFrictionCost`) and the covered event ids.
 *  - `surfaced` is the below/above threshold gate: a single cheap round-trip
 *    (round_trips < `FRICTION_COST_SURFACE_THRESHOLD`) is reported but does NOT
 *    fire (never auto-covers its category) — "below MUST NOT fire".
 *  - Output order is stable (canonical category order, then artifact) so a
 *    re-derive never churns the record.
 */
export function deriveFrictionObservations(
  frictions: readonly CapturedFrictionItem[],
): DerivedFrictionObservation[] {
  const groups = new Map<string, CapturedFrictionItem[]>();
  for (const item of frictions) {
    if (!isFrictionCategory(item.frictionCategory)) continue;
    const key = `${item.frictionCategory} ${aggregationKey(item)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  const derived: DerivedFrictionObservation[] = [];
  for (const [key, items] of groups) {
    const sep = key.indexOf(" ");
    const category = key.slice(0, sep) as FrictionCategory;
    const artifact = key.slice(sep + 1);
    const cost = measureFrictionCost(items);
    const base = { category, artifact, event_ids: items.map((i) => i.id), cost };
    derived.push({
      ...base,
      surfaced: costSignalsSurface(cost),
      note: derivedObservationNote(base, items[0].note),
    });
  }
  derived.sort(
    (a, b) =>
      FRICTION_CATEGORIES.indexOf(a.category) -
        FRICTION_CATEGORIES.indexOf(b.category) ||
      a.artifact.localeCompare(b.artifact),
  );
  return derived;
}

/**
 * The SURFACED derived observations mapped into the persisted
 * `open_observations[]` shape — the pre-populated entries the close-out gate (and
 * the Stop-hook backstop) read for category coverage. Only aggregates at/above
 * the surface threshold are emitted; below-threshold aggregates never fire.
 */
export function prepopulatedObservations(
  derived: readonly DerivedFrictionObservation[],
): FrictionOpenObservation[] {
  return derived
    .filter((d) => d.surfaced)
    .map((d) => ({
      category: d.category,
      dimension: "manual_interventions",
      note: d.note,
      artifact: d.artifact,
      derived: true,
    }));
}

/**
 * Merge tool-derived observations into a record, preserving host-authored ones.
 * The prior derived set (marked `derived`) is dropped and recomputed from the
 * current `frictions[]`, so a re-derive is idempotent and always up to date;
 * host-authored observations (no `derived` flag) are never touched. When nothing
 * survives, the field is omitted so an empty run never churns the record.
 */
function mergeDerivedObservations(
  record: TriagedFrictionArtifact,
): TriagedFrictionArtifact {
  const hostAuthored = (record.open_observations ?? []).filter((o) => !o.derived);
  const derived = prepopulatedObservations(
    deriveFrictionObservations(record.frictions ?? []),
  );
  const open_observations = [...hostAuthored, ...derived];
  if (open_observations.length === 0) {
    const { open_observations: _omit, ...rest } = record;
    return rest;
  }
  return { ...record, open_observations };
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

  // Materialize the record (so the host always appends to an existing file) AND
  // pre-populate the category walk in ONE locked merge: aggregate the run's
  // tool-tagged mechanical events into derived `open_observations[]` entries so a
  // category the backend already saw re-work in arrives pre-covered. The merge is
  // host-preserving (host-authored observations/dispositions survive) and
  // idempotent (the derived set is recomputed, never duplicated).
  const record = await appendFrictionUnderLock(
    artifactsDir,
    runId,
    (r) => mergeDerivedObservations({ ...r, tool: r.tool ?? tool }),
    tool,
  );

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
  // Categories the tool ALREADY pre-populated from aggregated mechanical events —
  // the host inherits these instead of walking them from scratch.
  const prepopulated = new Set<string>(
    triage.existing_observations
      .filter((o) => o.derived && isFrictionCategory(o.category))
      .map((o) => o.category as string),
  );
  const categoryLines = FRICTION_CATEGORIES.map((c) => {
    const status = covered(c)
      ? prepopulated.has(c)
        ? "✓ covered — pre-populated from mechanical events (review, don't re-walk)"
        : "✓ covered"
      : "✗ MISSING — owe an entry or attestation";
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
