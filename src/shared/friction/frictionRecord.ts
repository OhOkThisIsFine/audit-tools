import { join } from "node:path";
import {
  type FrictionCaptureArtifact,
  type FrictionItem,
  type FrictionRunLinks,
  type FrictionRunLinkUpdate,
  FRICTION_CAPTURE_SCHEMA_VERSION,
  frictionCaptureDir,
  frictionCapturePath,
  listFrictionRecordFilenames,
  sanitizeRunId,
} from "../io/frictionCapture.js";
import { readOptionalJsonFile, writeJsonFile } from "../io/json.js";
import { withFileLock } from "../io/fileLock.js";

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

/**
 * The REQUIRED friction CATEGORIES — the coverage axis the blocking close-out
 * enforces EVERY run. The host must, for EACH category, either record ≥1
 * `open_observations[]` entry tagged with it OR an explicit
 * `category_attestations[]` "nothing to report". A category can never be skipped
 * by silence — that omission is exactly the failure the gate prevents.
 *
 * Single-sourced HERE in the substrate (not in `triage.ts`) so the mechanical
 * capture layer (`stepBoundaryCapture.ts`) can stamp a captured event with a REAL
 * category without importing the triage module — there is exactly ONE category
 * vocabulary shared by capture, triage, and the render, and it can never drift.
 */
export const FRICTION_CATEGORIES = [
  "ambiguous_direction", // direction/decision the tool or prompt left to the host that it should have resolved
  "tool_should_decide", // the host had to remember / notice / enforce something the tool should guarantee
  "inefficient_feeding", // redundant or wasteful work, poor context feeding, or a tool inefficiency
] as const;
export type FrictionCategory = (typeof FRICTION_CATEGORIES)[number];

/** Whether a value is one of the required friction categories (contract check). */
export function isFrictionCategory(value: unknown): value is FrictionCategory {
  return (
    typeof value === "string" &&
    (FRICTION_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * A single captured mechanical friction event: a `FrictionItem` plus a stable id
 * and the REAL friction category it belongs to (one of `FRICTION_CATEGORIES`).
 */
export interface CapturedFrictionItem extends FrictionItem {
  /** Stable distinct id; re-recording an event with this id is a no-op de-dup. */
  id: string;
  /**
   * The REAL close-out category (one of `FRICTION_CATEGORIES`) this mechanical
   * event belongs to — what the per-category friction walk keys on. Distinct
   * from the inherited `FrictionItem.category` (`bug|trap|suggestion`), which is
   * only a coarse origin hint and is NEVER a close-out category. Optional only
   * for back-compat with older records; a stamped event always carries it.
   */
  frictionCategory?: FrictionCategory;
  /**
   * Optional artifact/subject key this event concerns (e.g. the node id, the
   * contract id) — the aggregation axis that collapses N same-artifact events
   * into ONE derived observation. Falls back to `area` when unset.
   */
  artifact?: string;
  /**
   * Optional measured token cost this event incurred (best-effort — supplied only
   * when the seam has a real measure). Summed into the aggregate's `tokens` cost
   * signal; never fabricated when absent.
   */
  tokens?: number;
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

/** One end-of-run open observation, tagged with the friction CATEGORY it covers. */
export interface FrictionOpenObservation {
  /**
   * The friction category this observation covers (the required-coverage axis;
   * one of `FRICTION_CATEGORIES`). Optional only for back-compat with older
   * records — an untagged observation covers no category and does not satisfy
   * the per-category close-out.
   */
  category?: string;
  /** Optional finer "what happened" hint (one of `FRICTION_NAMED_DIMENSIONS`). */
  dimension?: string;
  /** The host's observation note. */
  note: string;
  /**
   * When set, the aggregation subject (artifact/node/contract key) this
   * observation summarizes. Present on TOOL-DERIVED observations (see `derived`)
   * so a re-run can idempotently replace the derived set keyed on
   * `(category, artifact)`; absent on host-authored observations.
   */
  artifact?: string;
  /**
   * True when the tool DERIVED this observation by aggregating mechanical
   * step-boundary events (pre-populating the host's category walk), vs. a
   * host-authored observation. The close-out counts a derived observation toward
   * category coverage exactly like a host one; the flag only lets the derive step
   * replace its own prior output without ever touching host-authored entries.
   */
  derived?: boolean;
}

/**
 * An explicit affirmation that a friction CATEGORY had nothing to report this
 * run. Distinct from silence: the host must actively attest "none" per category,
 * so a category can never be skipped by omission (the failure this gate exists to
 * prevent). Only valid when that category has no `open_observations[]` entry.
 */
export interface FrictionCategoryAttestation {
  /** The friction category being attested clean (one of `FRICTION_CATEGORIES`). */
  category: string;
  /** Optional context for why nothing was recorded in this category. */
  note?: string;
}

/**
 * The full per-run friction record on disk — the base capture artifact, the
 * accreted mechanical events, plus the host-owned triage overlay
 * (`dispositions[]` / `open_observations[]` / `category_attestations[]` /
 * `free_form_notes`). The base `frictions` field is narrowed to
 * `CapturedFrictionItem[]` (each carries an `id`).
 */
export interface TriagedFrictionArtifact extends FrictionCaptureArtifact {
  frictions: CapturedFrictionItem[];
  /** Host dispositions, keyed by `target_id` (latest verdict wins). */
  dispositions?: FrictionDispositionRecord[];
  /** Host open observations; every friction category must be covered by one of
   *  these OR an explicit `category_attestations[]` entry to satisfy the close-out. */
  open_observations?: FrictionOpenObservation[];
  /** Explicit per-category "nothing to report" affirmations (see the interface). */
  category_attestations?: FrictionCategoryAttestation[];
  /** Optional catch-all free-form notes for friction that fits no category. */
  free_form_notes?: string;
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
    // Materialization happens at whichever seam touches the record first, routinely
    // BEFORE either related run exists (semantics: `FrictionRunLinks`).
    step_run_ids: [],
    dispatch_run_ids: [],
    captured_at: new Date().toISOString(),
    frictions: [],
  };
}

/**
 * A stored reference array as read off disk: deduped and sorted in code-unit order of the
 * id, so the array is content-ordered rather than write-ordered. The value arrives through
 * an unchecked JSON cast, so anything that is not an array of strings (a record written
 * before the field existed) normalizes to empty instead of throwing.
 */
function normalizeRunRefs(stored: unknown): string[] {
  const refs = Array.isArray(stored)
    ? stored.filter((ref): ref is string => typeof ref === "string")
    : [];
  return [...new Set(refs)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** {@link normalizeRunRefs} of the stored array unioned with one newly-supplied id. */
function mergeRunRefs(stored: unknown, added: string | null | undefined): string[] {
  const existing = normalizeRunRefs(stored);
  return typeof added === "string" ? normalizeRunRefs([...existing, added]) : existing;
}

/**
 * Fold a run-link update into a record — the single chokepoint implementing the reference
 * semantics stated on `FrictionRunLinks` (src/shared/io/frictionCapture.ts).
 */
function mergeFrictionRunLinks(
  record: TriagedFrictionArtifact,
  links: FrictionRunLinkUpdate | undefined,
): TriagedFrictionArtifact {
  return {
    ...record,
    step_run_ids: mergeRunRefs(record.step_run_ids, links?.step_run_id),
    dispatch_run_ids: mergeRunRefs(record.dispatch_run_ids, links?.dispatch_run_id),
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
 *
 * `links` names the runs this write knows about (semantics: `FrictionRunLinks`). It is
 * folded in AROUND `mutate`, never inside it, because every caller's mutate has an early
 * return that yields the record unchanged (the per-event de-dup in `captureFrictionEvent`
 * most of all) — and a re-entrant pass is exactly when a newly-known id arrives.
 */
export async function appendFrictionUnderLock(
  artifactsDir: string,
  runId: string,
  mutate: (record: TriagedFrictionArtifact) => TriagedFrictionArtifact,
  tool: FrictionCaptureArtifact["tool"] = "remediate-code",
  links?: FrictionRunLinkUpdate,
): Promise<TriagedFrictionArtifact> {
  return withFileLock(frictionLockPath(artifactsDir, runId), async () => {
    const existing = await readOptionalJsonFile<TriagedFrictionArtifact>(
      frictionCapturePath(artifactsDir, runId),
    );
    const base = existing ?? emptyRecord(runId, tool);
    const next = mergeFrictionRunLinks(mutate(base), links);
    await writeJsonFile(frictionCapturePath(artifactsDir, runId), next);
    return next;
  });
}

/**
 * Record which step-envelope run and/or dispatch run this friction record relates to,
 * best-effort. The only writer seam whose whole purpose is the reference — every other
 * writer carries frictions and merely passes its links along.
 *
 * Call it at a seam that HOLDS the id (a dispatch prepare, a step publish), once per
 * round, passing only what is genuinely in scope (semantics: `FrictionRunLinks`). Never
 * throws: a failed link is diagnostic loss, never a broken obligation — the same
 * best-effort contract as the mechanical capture sink.
 *
 * ⚠ It MATERIALIZES the record when none exists (`appendFrictionUnderLock` creates on
 * miss), so a link write alone makes `frictionCaptured` — the never-re-loop gate keyed
 * on artifact existence — answer true for a run with no close-out. Harmless only while
 * that gate has no live consumer; re-wiring it means this seam must stop creating.
 */
export async function linkFrictionRunIds(
  artifactsDir: string,
  runId: string,
  links: FrictionRunLinkUpdate,
  tool: FrictionCaptureArtifact["tool"] = "remediate-code",
): Promise<void> {
  try {
    await appendFrictionUnderLock(artifactsDir, runId, (record) => record, tool, links);
  } catch {
    // Best-effort: swallow every failure so linking never breaks the obligation.
  }
}

/** One friction record found by reference, with the references it carries. */
export interface FrictionRecordReference extends FrictionRunLinks {
  /** The record's own run key (the friction dir entry it is filed under). */
  run_id: string;
  /** Absolute path to the record. */
  path: string;
}

/**
 * Find every friction record under `artifactsDir` that REFERENCES the given run(s) —
 * the read side of the linkage. Without it a caller holding a dispatch run id can only
 * guess at the record's key, and a record filed under a different key is invisible.
 *
 * A record matches when ANY queried id is a MEMBER of the record's corresponding
 * reference array — so a record naming N rounds is found from any one of them, not just
 * the first, and a caller holding a whole round set joins in ONE scan. Querying no id
 * matches nothing (an empty query is not "everything"). Results are ordered by `run_id` —
 * a stable, content-derived key, never directory-read order.
 */
export async function findFrictionRecordsByRunLink(
  artifactsDir: string,
  link: Partial<FrictionRunLinks>,
): Promise<FrictionRecordReference[]> {
  const wantStep = normalizeRunRefs(link.step_run_ids);
  const wantDispatch = normalizeRunRefs(link.dispatch_run_ids);
  if (wantStep.length === 0 && wantDispatch.length === 0) return [];
  const dir = frictionCaptureDir(artifactsDir);
  const names = await listFrictionRecordFilenames(artifactsDir);
  const found: FrictionRecordReference[] = [];
  for (const name of names) {
    const path = join(dir, name);
    // Siblings are host-authorable (the triage block asks the host to write one), so an
    // unreadable record costs only its own visibility — never the caller's close-out.
    let record: TriagedFrictionArtifact | null | undefined;
    try {
      record = await readOptionalJsonFile<TriagedFrictionArtifact>(path);
    } catch {
      continue;
    }
    if (!record || typeof record.run_id !== "string") continue;
    const stepRunIds = normalizeRunRefs(record.step_run_ids);
    const dispatchRunIds = normalizeRunRefs(record.dispatch_run_ids);
    const matches =
      wantStep.some((id) => stepRunIds.includes(id)) ||
      wantDispatch.some((id) => dispatchRunIds.includes(id));
    if (!matches) continue;
    found.push({
      run_id: record.run_id,
      path,
      step_run_ids: stepRunIds,
      dispatch_run_ids: dispatchRunIds,
    });
  }
  // Code-unit order on the record's own key: stable, content-derived, locale-free.
  return found.sort((left, right) =>
    left.run_id < right.run_id ? -1 : left.run_id > right.run_id ? 1 : 0,
  );
}
