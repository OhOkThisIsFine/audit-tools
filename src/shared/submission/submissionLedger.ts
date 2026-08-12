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
] as const;

export type SubmissionEventKind = (typeof SUBMISSION_EVENT_KINDS)[number];

export interface SubmissionLedgerEvent {
  readonly contract_version: typeof SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION;
  readonly run_id: string;
  readonly submission_id: string;
  readonly lane: string;
  readonly kind: SubmissionEventKind;
  readonly issue_code?: SubmissionIssueCode;
  readonly message?: string;
  /** ISO-8601. A faithful event record is allowed to say when. */
  readonly recorded_at: string;
}

/** `<artifactsDir>/submissions/submission-ledger.jsonl`. */
export function submissionLedgerPath(artifactsDir: string): string {
  return join(submissionsDir(artifactsDir), "submission-ledger.jsonl");
}

/** Append one event. The parent directory is created on demand. */
export async function appendSubmissionEvent(
  artifactsDir: string,
  event: SubmissionLedgerEvent,
): Promise<void> {
  await appendNdjsonFile(submissionLedgerPath(artifactsDir), event);
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
 */
export async function readSubmissionLedger(
  artifactsDir: string,
): Promise<readonly SubmissionLedgerEvent[]> {
  let content: string;
  try {
    content = await readFile(submissionLedgerPath(artifactsDir), "utf8");
  } catch {
    return [];
  }
  const events: SubmissionLedgerEvent[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      const event = discardOnSchemaVersionMismatch(
        JSON.parse(line) as SubmissionLedgerEvent,
        SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      );
      if (event !== undefined) events.push(event);
    } catch {
      // A torn final line (crash mid-append) drops; every complete event before
      // it stays readable, which is the whole point of an append-only record.
    }
  }
  return events;
}
