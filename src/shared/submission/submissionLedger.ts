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
import { withFileLock } from "../io/fileLock.js";
import { discardOnSchemaVersionMismatch } from "../io/schemaVersion.js";
import { submissionsDir } from "../io/auditToolsPaths.js";
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
] as const;

export type SubmissionEventKind = (typeof SUBMISSION_EVENT_KINDS)[number];

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
  /** ISO-8601. A faithful event record is allowed to say when. */
  readonly recorded_at: string;
}

/** `<artifactsDir>/submissions/submission-ledger.jsonl`. */
export function submissionLedgerPath(artifactsDir: string): string {
  return join(submissionsDir(artifactsDir), "submission-ledger.jsonl");
}

// Sibling lock serializing every append. Two concurrent appends used to be two
// independent open-append syscalls on one file: on Windows (and wherever O_APPEND
// is not what the runtime actually performs) they can interleave so one event's
// line lands INSIDE the other's, and both lines are then torn — the ledger
// silently loses an event, which is precisely the clean-vs-repaired collapse it
// exists to prevent. Same sibling pattern the locked JSON stores use.
function ledgerLockPath(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
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
  | "schema_version_mismatch";

/** One line the reader skipped, with enough to find it in the file. */
export interface SubmissionLedgerDrop {
  /** 1-based physical line number in the ledger file. */
  readonly line: number;
  readonly reason: SubmissionLedgerDropReason;
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
    events.push(event);
  }
  return ledgerRead(events, dropped);
}
