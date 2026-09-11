/**
 * The append-only record of what happened to each submission.
 *
 * A run that drifted and was repaired must stay distinguishable, after the
 * fact, from a run that was clean on the first try. Nothing in the pipeline
 * used to survive the call: an issue rode the returned summary into a prompt
 * string and was gone. So "the host got it right 9 times out of 10" was a fact
 * a human read off a transcript rather than one the artifacts could state.
 *
 * NDJSON, appended, never rewritten: ARRIVAL order is the file order and a
 * rejection stays on the record after the later acceptance lands. This is the
 * one place the stable-content-order rule deliberately does NOT apply — the
 * ledger is a faithful EVENT record, not a derived artifact, and re-sorting it
 * by timestamp or id would erase exactly the sequence it exists to preserve.
 * Any derived summary a reporter renders from it may sort; the file may not.
 */
import { join } from "node:path";

import { readFile } from "node:fs/promises";

import { appendNdjsonFile } from "../io/json.js";
import { siblingLockPath } from "../io/lockedJsonStore.js";
import { withFileLock } from "../io/fileLock.js";
import { discardOnSchemaVersionMismatch } from "../io/schemaVersion.js";
import { submissionsDir } from "../io/auditToolsPaths.js";
import type { MeasuredOutcome } from "../measurement/measuredOutcome.js";
import type { SubmissionIssueCode } from "./submissionClassifier.js";

export const SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION =
  "submission-ledger-event/v1alpha1" as const;

export const SUBMISSION_EVENT_KINDS = [
  /** The emission declared this lane owed a submission. */
  "expected",
  /** A valid submission arrived and was applied. */
  "accepted",
  /** A submission arrived and was refused (held, never discarded). */
  "rejected",
  /** An operator re-landed a submission by hand through the recovery lane. */
  "recovered_by_hand",
  /**
   * A submission was applied through a recovery verb that RELAXED one of the
   * normal lane's corroboration checks. Distinct from `recovered_by_hand`
   * (which re-lands a payload the normal validator still fully accepts) and
   * from `accepted`: the evidence bar that admitted this one was lower, so the
   * record must say so rather than let the run read as clean.
   */
  "accepted_via_recovery",
  /**
   * An operator-facing verb REMOVED an already-accepted submission (the
   * audit host-handoff's `unaccept-results`). Without this kind, a dropped
   * entry was indistinguishable from one never accepted — exactly the
   * clean-vs-repaired collapse the ledger exists to prevent, on the removal
   * side. A later re-acceptance of the same work item then reads as what it
   * is: a second event after a recorded withdrawal.
   */
  "removed_by_operator",
  /**
   * The tool WROTE this lane's prompt and declared its bound path — the lane
   * was dispatched.
   *
   * Deliberately disjoint from `expected`. *Expecting* an artifact is a claim
   * the tool will be owed something and will re-ask until it arrives;
   * *dispatching* is a fact about the past. The perspective lanes of a deep
   * conceptual pass are un-expected by design (P25: the tool never reads their
   * findings, so an expectation against one could never be satisfied or
   * dropped and accumulated as a permanent, false shortfall) — and were
   * therefore invisible, so a lane that exited 0 having written nothing left no
   * trace in any artifact. A dispatch row can never become a shortfall:
   * shortfall is a diff over the expected SET, a path that never reads ledger
   * events.
   */
  "dispatched",
  /**
   * What a dispatched lane actually delivered, observed once at the fold that
   * ingests its round's terminal submission. Carries `outcome`. A `dispatched`
   * row with no terminal row at all is the record of a lane that never
   * delivered — the absence IS the statement — so nothing here ever mints a
   * terminal row nobody observed.
   */
  "lane_outcome",
] as const;

export type SubmissionEventKind = (typeof SUBMISSION_EVENT_KINDS)[number];

// <!-- comment-symbol-exempt: names deliberately-retired symbols; this block records that history -->
/**
 * Which kinds mean "the TOOL ingested this submission and decided about it".
 *
 * Exhaustive by construction, so a new kind must be classified rather than
 * defaulting into either answer. This exists because several readers asked the
 * question as `kind !== "expected"` — a partition that silently absorbed every
 * future kind. Under it, a `dispatched` row appended when a refused lane is
 * re-materialized would have become that submission's trailing event, deleting
 * the refusal from `lastRefusals` (so a host whose submission was received and
 * REJECTED is told it "submitted nothing") and making the report claim the
 * refusal "was later accepted or re-landed by hand" when nothing had been.
 */
const EVENT_KIND_IS_INGEST: Record<SubmissionEventKind, boolean> = {
  // A declaration, not an ingest.
  expected: false,
  // Facts about dispatch and delivery; the tool consumed nothing.
  dispatched: false,
  lane_outcome: false,
  accepted: true,
  rejected: true,
  recovered_by_hand: true,
  accepted_via_recovery: true,
  // A withdrawal is a decision ABOUT an ingested submission, and it ends a
  // refusal's trailing state exactly as an acceptance does.
  removed_by_operator: true,
};

/** The kinds {@link isIngestEvent} admits, in declaration order. */
export const INGEST_EVENT_KINDS: readonly SubmissionEventKind[] =
  SUBMISSION_EVENT_KINDS.filter((kind) => EVENT_KIND_IS_INGEST[kind]);

/**
 * True when this kind records the tool having ingested something. The ONE home
 * for "which events change a submission's trailing state": every
 * last-event-per-submission reader asks it here rather than re-spelling an
 * exclusion list that the next new kind would fall through.
 */
export function isIngestEvent(kind: SubmissionEventKind): boolean {
  return EVENT_KIND_IS_INGEST[kind];
}

/**
 * One ledger event. Generic over the DRAW's issue-code vocabulary: the base
 * parameterization carries the shared submission codes, and a draw extending
 * the vocabulary on its own side (`RemediationIssueCode`,
 * `AuditIngestIssueCode`) parameterizes rather than widening the shared union
 * — the same direction {@link SubmissionIssue} takes.
 */
export interface SubmissionLedgerEvent<
  TIssueCode extends string = SubmissionIssueCode,
> {
  readonly contract_version: typeof SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION;
  readonly run_id: string;
  readonly submission_id: string;
  readonly lane: string;
  readonly kind: SubmissionEventKind;
  readonly issue_code?: TIssueCode;
  readonly message?: string;
  /**
   * What a `lane_outcome` row observed at the bound path. Absent on every other
   * kind — an ingest event's decision is its `kind`.
   */
  readonly outcome?: MeasuredOutcome;
  /**
   * The ROUND a `dispatched` (and its matching `lane_outcome`) row belongs to,
   * when the emitter has one. Carried as DATA rather than parsed back out of a
   * lane id, so a delivery rate is reported per round and a superseded round's
   * lanes never drag the current round's rate down. Absent for lane families
   * with no round of their own.
   */
  readonly round_id?: string;
  /**
   * The landed commit an `accepted_via_recovery` row is ABOUT, when the emitter
   * has one — the structured twin of the fact the message narrates.
   *
   * Why a field rather than "read the sha out of the message". A recovery mark's
   * identity is (run, submission, LANDED COMMIT): an item re-opened and later
   * re-accepted from a DIFFERENT landing is a different relaxed acceptance and
   * earns its own record, while a retry of the SAME landing is a duplicate. The
   * writer matched that fact by searching the free-text `message` for a 40-hex
   * token it had itself interpolated — a value that cannot be read back out of
   * prose, because prose is exactly what a later message rewording changes. An
   * event carries its own identity as data.
   *
   * Written by the remediation ingest's recovery-acceptance path. Absent on
   * every other kind, and absent on rows written before this field existed —
   * a reader that needs the identity treats a missing value as "not this
   * commit", which is the same answer an unrelated landing gives (see
   * `recoveryMarkMatches`).
   */
  readonly landed_commit?: string;
  /** ISO-8601. A faithful event record is allowed to say when. */
  readonly recorded_at: string;
}

/** `<artifactsDir>/submissions/submission-ledger.jsonl`. */
export function submissionLedgerPath(artifactsDir: string): string {
  return join(submissionsDir(artifactsDir), "submission-ledger.jsonl");
}

/**
 * The ONE identity question for a recovery mark: is this already-recorded
 * `accepted_via_recovery` row the mark about THIS (run, submission, landed
 * commit)?
 *
 * A recovery mark's identity is (run, submission, landed commit) rather than
 * just (run, submission): an item re-opened and later re-accepted from a
 * DIFFERENT landing is a different relaxed acceptance and earns its own record,
 * while a retry of the SAME landing is a duplicate. The writer used to answer
 * this by searching the free-text `message` for a sha it had itself
 * interpolated — see {@link SubmissionLedgerEvent.landed_commit} for why the
 * fact belongs in a field.
 *
 * An event with no `landed_commit` never matches. That is the whole read policy
 * for rows written before the field existed: an old row's absence is not
 * evidence of a different landing, and the two possible readings ("same commit"
 * / "no commit recorded") have opposite consequences — matching would suppress
 * a mark the run genuinely owed, so the fail-safe direction is NOT to match.
 * The cost is one duplicate row on a re-entry that spans the upgrade, which is
 * a faithful record of two acceptances rather than a lost one.
 */
export function recoveryMarkMatches(
  event: SubmissionLedgerEvent,
  submissionId: string,
  landedCommit: string,
): boolean {
  return (
    event.kind === "accepted_via_recovery" &&
    event.submission_id === submissionId &&
    event.landed_commit !== undefined &&
    event.landed_commit === landedCommit
  );
}

// ── The event schema ──────────────────────────────────────────────────────────

/**
 * The fields every event carries whatever its kind. `contract_version` is NOT
 * here: it is the version gate's own key, and `discardOnSchemaVersionMismatch`
 * owns that question (an event that fails it is classified
 * `schema_version_mismatch`, never `shape_invalid` — the two are different
 * facts about a line and the drop reason says which).
 */
const SUBMISSION_LEDGER_EVENT_REQUIRED_FIELDS = [
  "run_id",
  "submission_id",
  "lane",
  "recorded_at",
] as const;

const SUBMISSION_LEDGER_EVENT_STRING_FIELDS = [
  ...SUBMISSION_LEDGER_EVENT_REQUIRED_FIELDS,
  "issue_code",
  "message",
  "round_id",
  "landed_commit",
  "outcome",
] as const;

/**
 * Validate a parsed line as a ledger event, past the version gate.
 *
 * Why this is a schema and not a cast. The reader is a REPORTING surface whose
 * callers read `kind` to decide whether a lane is outstanding, and read
 * `submission_id` to attribute a refusal — so a line that parsed as JSON but is
 * not an event was being reinterpreted under THIS contract's field semantics.
 * A `kind` outside the vocabulary flowed into every `Record<SubmissionEventKind,
 * …>` lookup as an absent key; an event with no `submission_id` joined no
 * caller's map; and both read exactly like a ledger that had never recorded
 * anything, which is the one thing the ledger exists to prevent.
 *
 * Deliberately structural and hand-written rather than a zod schema: this
 * module is in `src/shared`'s submission area and already owns its own event
 * vocabulary as a const tuple, so the membership test derives from
 * {@link SUBMISSION_EVENT_KINDS} (one home, no second list) exactly as the
 * version gate derives from {@link SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION}.
 */
export function validateSubmissionLedgerEvent(
  value: unknown,
): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "the line is not a JSON object" };
  }
  const record = value as Record<string, unknown>;
  for (const field of SUBMISSION_LEDGER_EVENT_REQUIRED_FIELDS) {
    if (typeof record[field] !== "string" || (record[field] as string).length === 0) {
      return { ok: false, reason: `"${field}" is missing or not a non-empty string` };
    }
  }
  for (const field of SUBMISSION_LEDGER_EVENT_STRING_FIELDS) {
    const fieldValue = record[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      return { ok: false, reason: `"${field}" is present but is not a string` };
    }
  }
  if (!(SUBMISSION_EVENT_KINDS as readonly string[]).includes(record["kind"] as string)) {
    return {
      ok: false,
      reason: `"kind" is not one of: ${SUBMISSION_EVENT_KINDS.join(", ")}`,
    };
  }
  return { ok: true };
}

// Sibling lock serializing every append. Two concurrent appends used to be two
// independent open-append syscalls on one file: on Windows (and wherever O_APPEND
// is not what the runtime actually performs) they can interleave so one event's
// line lands INSIDE the other's, and both lines are then torn — the ledger
// silently loses an event, which is precisely the clean-vs-repaired collapse it
// exists to prevent. The name is the locked-JSON-store module's OWN derivation
// (`siblingLockPath`), so the ledger's lock is the same rule the stores use
// rather than a second spelling of it.
function ledgerLockPath(ledgerPath: string): string {
  return siblingLockPath(ledgerPath);
}

/**
 * Append one event under the shared file lock, so concurrent appends cannot
 * interleave mid-line. The parent directory is created on demand (the lock
 * acquire creates its own parent; `appendNdjsonFile` creates the ledger's).
 */
export async function appendSubmissionEvent<
  TIssueCode extends string = SubmissionIssueCode,
>(artifactsDir: string, event: SubmissionLedgerEvent<TIssueCode>): Promise<void> {
  const ledgerPath = submissionLedgerPath(artifactsDir);
  await withFileLock(
    ledgerLockPath(ledgerPath),
    async () => {
      await appendNdjsonFile(ledgerPath, event);
    },
  );
}

/** Why one ledger line did not become an event. */
export type SubmissionLedgerDropReason =
  /** The line is not JSON — a torn write, typically a crash mid-append. */
  | "unparsable"
  /** The line parsed but carries another release's contract version. */
  | "schema_version_mismatch"
  /**
   * The line parsed, IS the current version, and is still not an event — an
   * unknown `kind`, a missing `submission_id`, a field of the wrong type. A
   * distinct reason from `schema_version_mismatch` because it is a distinct
   * fact: the version gate says "another release wrote this", the shape gate
   * says "this release's writer emitted something this release cannot read".
   */
  | "shape_invalid";

/** One line the reader skipped, with enough to find it in the file. */
export interface SubmissionLedgerDrop {
  /** 1-based physical line number in the ledger file. */
  readonly line: number;
  readonly reason: SubmissionLedgerDropReason;
  /**
   * Why the shape gate refused it, for `shape_invalid` lines only. The line
   * number alone sends a reader to the right place but says nothing about what
   * is wrong there; the discriminated union keeps this off the other reasons
   * rather than leaving an always-undefined field for them to ignore.
   */
  readonly detail?: string;
}

/**
 * What {@link readSubmissionLedger} returns: the events AND what it could not
 * read.
 *
 * SHAPE, and why it is this shape. The contract calls for a record carrying
 * both `events` and `dropped`. It is also still the events ARRAY, because the
 * consumers that adapt to the record — the audit bundle's `submission_ledger`,
 * promotion-time archiving, the remediate ingest's recovery-mark scan — adapt
 * in their OWN nodes, not this one, and a bare `{events, dropped}` would break
 * every one of them at once. So `events` and `dropped` are non-enumerable
 * properties on the array itself: `result.events` and `result.dropped` read as
 * the contract names them, while `for…of`, `.filter`, `.map` and a deep-equal
 * against a plain array keep working unchanged for a caller that has not been
 * updated yet. Non-enumerable specifically so `toEqual([])` still holds — a
 * drop signal must not change what an unrelated assertion sees.
 */
export type SubmissionLedgerRead = readonly SubmissionLedgerEvent[] & {
  readonly events: readonly SubmissionLedgerEvent[];
  readonly dropped: readonly SubmissionLedgerDrop[];
};

function ledgerRead(
  events: SubmissionLedgerEvent[],
  dropped: SubmissionLedgerDrop[],
): SubmissionLedgerRead {
  Object.defineProperty(events, "events", {
    value: events,
    enumerable: false,
  });
  Object.defineProperty(events, "dropped", {
    value: dropped,
    enumerable: false,
  });
  // Through `unknown`: the two properties are installed by `defineProperty`,
  // which the type system cannot follow, so this is the one place the shape is
  // asserted rather than inferred. It is asserted immediately after the
  // properties are set, in the only function that builds this value.
  return events as unknown as SubmissionLedgerRead;
}

/**
 * Read the ledger in arrival order. An absent ledger reads as empty — a run
 * that never drifted has nothing to say — and a partially-written tail is
 * skipped rather than thrown, because a bookkeeping record must never be able
 * to fail the call it is recording.
 *
 * An event stamped with another release's contract version is skipped EXACTLY
 * like a torn line, per event. The FILE stays a faithful historical record —
 * nothing is rewritten or dropped from disk — but this function is a REPORTING
 * surface, and its callers read `kind`, `issue_code` and `message` to decide
 * whether a lane is outstanding because it was refused, and to dedupe against
 * the last recorded event. Reinterpreting a foreign contract's event under
 * those field semantics is how a run gets MISreported; skipping it degrades to
 * the same shape as a ledger that had not recorded that event yet. The skip is
 * per line, so the current release's events on either side of it still load.
 *
 * EVERY SKIP IS REPORTED. Skipping used to be silent — no counter, no warning,
 * nothing in the return value — which made a `rejected` or `recovered_by_hand`
 * event that was dropped indistinguishable from one that was never recorded at
 * all, defeating the single thing the ledger exists to guarantee: that a
 * drifted-and-repaired run stays distinguishable after the fact. Each skipped
 * line now lands in `dropped` with its 1-based line number and a classified
 * reason, so no caller can be handed a ledger cleaner than the run actually
 * was.
 *
 * A current-version line is then parsed against the event schema and skipped
 * (`shape_invalid`) when it is not an event at all — see
 * {@link validateSubmissionLedgerEvent}.
 */
export async function readSubmissionLedger(
  artifactsDir: string,
): Promise<SubmissionLedgerRead> {
  let content: string;
  try {
    content = await readFile(submissionLedgerPath(artifactsDir), "utf8");
  } catch {
    return ledgerRead([], []);
  }
  const events: SubmissionLedgerEvent[] = [];
  const dropped: SubmissionLedgerDrop[] = [];
  // Physical, 1-based, counting blank lines: the number has to send a reader to
  // the right line of the actual file, so it cannot be an index over the
  // non-blank subset.
  let lineNumber = 0;
  for (const line of content.split(/\r?\n/u)) {
    lineNumber += 1;
    if (line.trim().length === 0) continue;
    let parsed: SubmissionLedgerEvent;
    try {
      const value: unknown = JSON.parse(line);
      // A line that is valid JSON but not an OBJECT is still not an event: the
      // version check below reads properties off it (`in`), which throws on a
      // primitive or array and broke this function's documented never-throw
      // guarantee — one stray line failed the whole call that records drift.
      // Classified exactly like a torn line instead.
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        dropped.push({ line: lineNumber, reason: "unparsable" });
        continue;
      }
      parsed = value as SubmissionLedgerEvent;
    } catch {
      dropped.push({ line: lineNumber, reason: "unparsable" });
      continue;
    }
    const event = discardOnSchemaVersionMismatch(
      parsed,
      SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
    );
    if (event === undefined) {
      dropped.push({ line: lineNumber, reason: "schema_version_mismatch" });
      continue;
    }
    // Past the version gate the event is still untrusted: the version says
    // WHICH contract wrote it, never that the bytes satisfy it. See
    // `validateSubmissionLedgerEvent` for why a cast here was unsound.
    const shape = validateSubmissionLedgerEvent(event);
    if (!shape.ok) {
      dropped.push({
        line: lineNumber,
        reason: "shape_invalid",
        detail: shape.reason,
      });
      continue;
    }
    events.push(event);
  }
  return ledgerRead(events, dropped);
}
