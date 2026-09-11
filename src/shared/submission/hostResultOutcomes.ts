/**
 * Shared recording and trailing-state diagnostics for host-result ingestion.
 *
 * The audit and remediation draws classify different domain failures, but the
 * host boundary has one durable story: a submission was refused, or a prior
 * refusal was subsequently accepted. This module owns that story and keeps
 * the ledger reader separate from each draw's message renderer.
 */
import {
  appendSubmissionEvent,
  isIngestEvent,
  readSubmissionLedger,
  SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
  type SubmissionEventKind,
  type SubmissionLedgerEvent,
} from "./submissionLedger.js";
import type { SubmissionIssue } from "./submissionClassifier.js";

/** The accepted/rejected pair supplied by either host-result boundary. */
export interface HostResultOutcomes<TIssueCode extends string = string> {
  readonly issues: readonly SubmissionIssue<TIssueCode>[];
  readonly acceptedIds: readonly string[];
}

/** A refusal whose ingest state has not subsequently been cleared. */
export type TrailingSubmissionRefusal = SubmissionLedgerEvent<string>;

/**
 * Read trailing refusals once for a batch. Non-ingest rows (`expected`,
 * `dispatched`, and `lane_outcome`) do not alter the answer; an acceptance,
 * recovery, or operator withdrawal clears a prior rejection.
 */
export async function readTrailingSubmissionRefusals(
  artifactsDir: string,
  submissionIds?: readonly string[],
  options?: { readonly runId?: string },
): Promise<ReadonlyMap<string, TrailingSubmissionRefusal>> {
  const wanted = submissionIds === undefined ? undefined : new Set(submissionIds);
  const last = new Map<string, TrailingSubmissionRefusal>();
  for (const event of await readSubmissionLedger(artifactsDir)) {
    if (wanted !== undefined && !wanted.has(event.submission_id)) continue;
    if (options?.runId !== undefined && event.run_id !== options.runId) continue;
    if (!isIngestEvent(event.kind)) continue;
    if (event.kind === "rejected") {
      // A repeated missing observation is not substantive history and must
      // never erase a prior malformed/contract/domain refusal.
      if (event.issue_code !== "submission_missing") {
        last.set(event.submission_id, event);
      }
    } else {
      last.delete(event.submission_id);
    }
  }
  return last;
}

/**
 * Add the prior substantive refusal to a currently missing issue.
 *
 * Historic codes stay in the message as evidence. The caller supplies the
 * current draw's shared `submission_rejected` replacement code, so an
 * untrusted ledger value is never asserted into a draw-specific enum.
 */
export function enrichMissingSubmissionIssues<TIssueCode extends string>(
  issues: readonly SubmissionIssue<TIssueCode>[],
  refusals: ReadonlyMap<string, TrailingSubmissionRefusal>,
  replacementCode: TIssueCode,
): SubmissionIssue<TIssueCode>[] {
  return issues.map((issue) => {
    if (issue.code !== "submission_missing") return issue;
    const submissionId = issue.work_item_id ?? issue.submission_id;
    if (submissionId === undefined) return issue;
    const refusal = refusals.get(submissionId);
    if (refusal === undefined) return issue;
    return {
      ...issue,
      message:
        `${issue.message}; the previous submission was refused` +
        ` (${refusal.issue_code ?? "unknown"})` +
        `${refusal.message ? `: ${refusal.message}` : ""}`,
      code: replacementCode,
    };
  });
}

/**
 * Content identity of one ledger event, across the two optional fields that
 * carry its detail. The ONE home for "is this the same event", shared by the
 * batch recorder below (dedupe against a submission's trailing row) and by the
 * audit draw's single-lane recorder (`recordLaneOutcome`), which needs the same
 * question answered for the same reason: an append that already landed must not
 * land twice when the caller re-enters.
 */
export function eventSignature(
  kind: SubmissionEventKind,
  issueCode: string | undefined,
  message: string | undefined,
): string {
  return [kind, issueCode ?? "", message ?? ""].join("|");
}

/**
 * Which submissions a ledger already records as ACCEPTED, from ONE read.
 *
 * The question is about HISTORY, not about the last row, and the ledger IS the
 * history. A recorder whose append must land AT MOST ONCE per submission
 * lifetime asks this: a submission whose acceptance is followed by a later
 * rejection (the host resubmitted at the bound path and the repair failed
 * again) has an accepted already recorded, so a "is the TRAILING row an
 * accepted?" test reads the rejection, concludes nothing landed, and appends a
 * second `accepted` for work the fold already consumed.
 *
 * Read once per BATCH — the fold commit records its whole staged register in a
 * loop, so a per-lane read is O(events) scans of the same growing file.
 */
export interface SubmissionIngestHistory {
  /**
   * Submissions with an `accepted` row behind them. The BINDING is readonly,
   * the SET is not: a recorder that appends an accepted adds its own id here,
   * so one ledger read serves a whole batch and the view stays consistent with
   * what this pass just recorded.
   */
  readonly accepted: Set<string>;
}

export async function readSubmissionIngestHistory(
  artifactsDir: string,
  options?: { readonly runId?: string },
): Promise<SubmissionIngestHistory> {
  const accepted = new Set<string>();
  for (const event of await readSubmissionLedger(artifactsDir)) {
    if (options?.runId !== undefined && event.run_id !== options.runId) continue;
    if (!isIngestEvent(event.kind)) continue;
    // `accepted` only, not `accepted_via_recovery`: the recovery verb is a
    // different, operator-driven act with its own record, and folding the two
    // would let one suppress the other's row.
    if (event.kind === "accepted") accepted.add(event.submission_id);
  }
  return { accepted };
}

/**
 * Record raw host-ingest outcomes. The caller must pass the un-enriched issue
 * list so a missing poll that carries an old diagnostic cannot recursively
 * rewrite that diagnostic into the ledger. History is read once per batch.
 */
export async function recordHostResultOutcomes<TIssueCode extends string = string>(
  artifactsDir: string,
  runId: string,
  outcomes: HostResultOutcomes<TIssueCode>,
  options?: { readonly scopeToRunId?: string },
): Promise<void> {
  if (outcomes.issues.length === 0 && outcomes.acceptedIds.length === 0) return;
  const last = new Map<string, SubmissionLedgerEvent<string>>();
  for (const event of await readSubmissionLedger(artifactsDir)) {
    if (
      options?.scopeToRunId !== undefined &&
      event.run_id !== options.scopeToRunId
    ) {
      continue;
    }
    if (isIngestEvent(event.kind)) last.set(event.submission_id, event);
  }
  const append = async (
    submissionId: string,
    event: Omit<
      SubmissionLedgerEvent<string>,
      "contract_version" | "run_id" | "submission_id" | "lane" | "recorded_at"
    >,
  ): Promise<void> => {
    const previous = last.get(submissionId);
    if (
      previous !== undefined &&
      eventSignature(previous.kind, previous.issue_code, previous.message) ===
        eventSignature(event.kind, event.issue_code, event.message)
    ) {
      return;
    }
    const recorded: SubmissionLedgerEvent<string> = {
      contract_version: SUBMISSION_LEDGER_EVENT_CONTRACT_VERSION,
      run_id: runId,
      submission_id: submissionId,
      lane: submissionId,
      ...event,
      recorded_at: new Date().toISOString(),
    };
    await appendSubmissionEvent(artifactsDir, recorded);
    last.set(submissionId, recorded);
  };

  for (const submissionId of outcomes.acceptedIds) {
    // A first-try acceptance has no drift to record. Rejection and withdrawal
    // need a new acceptance; an existing recovery must never be relabelled clean.
    const priorKind = last.get(submissionId)?.kind;
    if (priorKind !== "rejected" && priorKind !== "removed_by_operator") continue;
    await append(submissionId, { kind: "accepted" });
  }
  for (const issue of outcomes.issues) {
    const submissionId = issue.work_item_id ?? issue.submission_id;
    if (submissionId === undefined) continue;
    const prior = last.get(submissionId);
    // Missing is an observation, not a new substantive refusal. Preserve the
    // prior reason while the host has not yet rewritten the bound file.
    if (
      issue.code === "submission_missing" &&
      prior?.kind === "rejected" &&
      prior.issue_code !== "submission_missing"
    ) {
      continue;
    }
    await append(submissionId, {
      kind: "rejected",
      issue_code: issue.code,
      message: issue.message,
    });
  }
}
