/**
 * The expected-submission set: what a step emission OWES, stated by name.
 *
 * A fan-out emission used to be implicit — it wrote N lane prompts and, on the
 * next turn, simply looked to see which result files happened to be there. An
 * absent lane was a `continue`, so a lane that was never delivered was
 * indistinguishable from a lane that was merely slow, and the run reported
 * neither the shortfall nor its cause. Recording the set at emit turns that
 * into "expected 3, accepted 2, lane `revealed` is missing".
 *
 * The set is a COHERENCE grouping, never a fit claim: a member is a
 * content-coherent lane, and the diff counts lanes. Nothing here describes a
 * backend, a window, or a partition sized to one — that is the host's business
 * and this package does not own it.
 *
 * Storage-neutral by construction (one core, two draws): the core says what the
 * set IS; the audit draw persists it as a file beside the submissions, the
 * remediate draw carries its equivalent inside `RemediationState`.
 */
import type {
  SubmissionIssue,
  SubmissionReadOutcome,
} from "./submissionClassifier.js";
import { classifyRead } from "./submissionClassifier.js";
import type { SubmissionRoots } from "./submissionIdentity.js";
import { submissionPathFor } from "./submissionIdentity.js";

export const EXPECTED_SET_CONTRACT_VERSION =
  "submission-expected-set/v1alpha1" as const;

export interface ExpectedSubmission {
  readonly submission_id: string;
  /** The content-coherent lane this member answers. */
  readonly lane: string;
  /** Digest of the prompt the lane was given — binds the answer to the ask. */
  readonly prompt_sha256: string;
  /** The tool-computed bound path, repository-relative and forward-slashed. */
  readonly submission_path: string;
}

export interface ExpectedSubmissionSet {
  readonly contract_version: typeof EXPECTED_SET_CONTRACT_VERSION;
  readonly run_id: string;
  readonly entries: readonly ExpectedSubmission[];
}

/** One lane's declaration, as the emitter knows it. */
export interface ExpectedSubmissionLane {
  readonly lane: string;
  readonly submissionId: string;
  readonly promptSha256: string;
  /**
   * False for a lane whose submission the TOOL never reads — a host-side
   * intermediate another lane consumes (the conceptual perspectives, which only
   * the judge reads). Declared so the builder below can REFUSE one rather than
   * mint an expectation that can never be satisfied or dropped. Absent/true is
   * the ordinary lane.
   */
  readonly expected?: boolean;
}

/** Per-member verdict of a diff. */
export type SubmissionClassification =
  | { readonly status: "accepted"; readonly submission_id: string }
  | {
      readonly status: "issue";
      readonly submission_id: string;
      readonly issue: SubmissionIssue;
    };

export interface ExpectedSetDiff {
  /** How many lanes were owed. */
  readonly expected: number;
  /** How many of them arrived. */
  readonly accepted: number;
  readonly members: readonly SubmissionClassification[];
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Build the set one emission owes. Entries are ordered by `submission_id` — a
 * content-derived key, never emission or filesystem order, so re-recording an
 * unchanged set produces byte-identical content.
 *
 * A lane declaring `expected: false` is REFUSED here, at the ONE seam every
 * emitter builds its set through: the tool never reads that lane's submission,
 * so an expectation recorded against it can never be satisfied or dropped —
 * it would accumulate as a permanent, false shortfall the run reports forever.
 * Throwing (not filtering) is the fail-closed shape: a caller that routes its
 * un-expected lanes through this builder anyway has misstated what it owes,
 * and a silently narrowed set would hide exactly that. The audit draw's
 * materializer filters at its own boundary first; this is the backstop that
 * makes the filter's omission non-optional.
 */
export function buildExpectedSubmissionSet(params: {
  readonly runId: string;
  readonly paths: SubmissionRoots;
  readonly lanes: readonly ExpectedSubmissionLane[];
}): ExpectedSubmissionSet {
  const unexpected = params.lanes.filter((lane) => lane.expected === false);
  if (unexpected.length > 0) {
    throw new Error(
      `buildExpectedSubmissionSet refused ${unexpected.length} un-expected lane(s): ` +
        `${unexpected.map((lane) => `'${lane.lane}'`).join(", ")}. The tool never reads ` +
        "a lane whose submission another lane consumes, so recording one would mint an " +
        "expectation no submission can ever satisfy — filter it out before building the set.",
    );
  }
  const entries = params.lanes.map((lane) => ({
    submission_id: lane.submissionId,
    lane: lane.lane,
    prompt_sha256: lane.promptSha256,
    submission_path: submissionPathFor(params.paths, lane.submissionId),
  }));
  return {
    contract_version: EXPECTED_SET_CONTRACT_VERSION,
    run_id: params.runId,
    entries: entries.sort((left, right) =>
      compareIds(left.submission_id, right.submission_id),
    ),
  };
}

/**
 * Merge `additional` into `base`, keyed by `submission_id`. A re-emitted lane
 * re-declares the identical member (the id is deterministic), and a step that
 * materializes several lane groups accumulates them into one statement of what
 * is currently owed. Returns the merged set plus the ids that are NEW, so a
 * caller records an `expected` event once per lane rather than on every
 * re-emission.
 */
export function mergeExpectedSets(
  base: ExpectedSubmissionSet | undefined,
  additional: ExpectedSubmissionSet,
): { readonly set: ExpectedSubmissionSet; readonly addedIds: readonly string[] } {
  const merged = new Map<string, ExpectedSubmission>();
  for (const entry of base?.entries ?? []) merged.set(entry.submission_id, entry);
  const addedIds: string[] = [];
  for (const entry of additional.entries) {
    if (!merged.has(entry.submission_id)) addedIds.push(entry.submission_id);
    merged.set(entry.submission_id, entry);
  }
  return {
    set: {
      contract_version: EXPECTED_SET_CONTRACT_VERSION,
      run_id: additional.run_id,
      entries: [...merged.values()].sort((left, right) =>
        compareIds(left.submission_id, right.submission_id),
      ),
    },
    addedIds: addedIds.sort(compareIds),
  };
}

/** Drop members that are no longer owed (they were accepted and applied). */
export function withoutExpectedSubmissions(
  set: ExpectedSubmissionSet,
  submissionIds: readonly string[],
): ExpectedSubmissionSet {
  const dropped = new Set(submissionIds);
  return {
    contract_version: EXPECTED_SET_CONTRACT_VERSION,
    run_id: set.run_id,
    entries: set.entries.filter((entry) => !dropped.has(entry.submission_id)),
  };
}

/**
 * Diff what was owed against what is on disk. Every member is classified by its
 * own id: arrived, or named with the reason it did not.
 */
export function diffExpectedSet(
  set: ExpectedSubmissionSet,
  observed: ReadonlyMap<string, SubmissionReadOutcome>,
): ExpectedSetDiff {
  const members: SubmissionClassification[] = [];
  let accepted = 0;
  for (const entry of set.entries) {
    const outcome = observed.get(entry.submission_id) ?? { kind: "missing" as const };
    const issue = classifyRead(outcome, {
      submissionId: entry.submission_id,
      lane: entry.lane,
      submissionPath: entry.submission_path,
    });
    if (issue === null) {
      accepted += 1;
      members.push({ status: "accepted", submission_id: entry.submission_id });
      continue;
    }
    members.push({ status: "issue", submission_id: entry.submission_id, issue });
  }
  return { expected: set.entries.length, accepted, members };
}
