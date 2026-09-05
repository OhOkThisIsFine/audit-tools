/**
 * The ONE failure vocabulary for a host submission both orchestrators read.
 *
 * Before this module the two draws had drifted: remediate classified a failed
 * read into a named issue code, while the audit ingest collapsed a missing
 * file, unparseable bytes, a contract-invalid body and a failed conversion into
 * the same bare `null` — so a host that never wrote its submission and a host
 * that wrote garbage were indistinguishable to every caller. One union, two
 * thin draws.
 *
 * The vocabulary is deliberately narrow: it names what happened to a
 * SUBMISSION. Domain corroboration a single draw performs (git ancestry, write
 * scope, a required test rerun) extends this union on that draw's side rather
 * than pulling its vocabulary in here — see `RemediationIssueCode`.
 */
import { readFile } from "node:fs/promises";
import type { IngestionCheckId } from "./ingestionChecks.js";

export const SUBMISSION_ISSUE_CODES = [
  /** Nothing exists at the bound path. */
  "submission_missing",
  /** Something exists at the bound path but is not JSON. */
  "submission_malformed",
  /** Valid JSON that fails the lane's schema / binding contract. */
  "submission_contract_invalid",
  /** Well-formed and valid, but refused for a stated reason. */
  "submission_rejected",
  /** A second submission re-uses an identity already accepted this run. */
  "duplicate_submission_id",
] as const;

export type SubmissionIssueCode = (typeof SUBMISSION_ISSUE_CODES)[number];

/**
 * One classified failure. `TCode` widens for a draw that adds its own domain
 * codes; the base parameterization is the shared vocabulary above — see
 * `RemediationIssueCode` and the audit ingest's `AuditIngestIssueCode`, each of
 * which extends this union on its own side rather than pulling its vocabulary
 * in here.
 *
 * Two optional locators, because a submission is identified differently on the
 * two lanes it can arrive through: an expected-set member is named by
 * `submission_id` + `submission_path`, and a host work item by `work_item_id` +
 * `result_path` (the field name its own persisted contract already uses).
 */
export interface SubmissionIssue<TCode extends string = SubmissionIssueCode> {
  readonly code: TCode;
  readonly message: string;
  /**
   * The registered ingestion check this issue failed
   * (`INGESTION_CHECKS`, ./ingestionChecks.ts) — the structured twin of the
   * category the message opens with, so a host repairing the result does not
   * have to parse prose to learn which check to fix.
   */
  readonly check?: IngestionCheckId;
  readonly submission_id?: string;
  readonly submission_path?: string;
  readonly work_item_id?: string;
  readonly result_path?: string;
}

/** The three-way read every gate narrows on — never a throw out of one lane. */
export type SubmissionReadOutcome =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed"; readonly detail: string }
  | { readonly kind: "value"; readonly value: unknown };

/**
 * Read the bytes at a bound path and classify the outcome. A file that is not
 * there and a file that will not parse are DIFFERENT answers; every other IO
 * failure reads as malformed rather than escaping, so one unreadable lane can
 * never destroy a sibling lane's already-consumed work.
 */
export async function readSubmissionDocument(
  absolutePath: string,
): Promise<SubmissionReadOutcome> {
  let source: string;
  try {
    source = await readFile(absolutePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return {
      kind: "malformed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    return { kind: "value", value: JSON.parse(source) as unknown };
  } catch (error) {
    return {
      kind: "malformed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Where a classified read came from, for the issue's message and locators. */
export interface SubmissionReadContext {
  readonly submissionId: string;
  readonly lane: string;
  readonly submissionPath: string;
}

/**
 * Turn a non-`value` read into the issue that names it, or `null` when the
 * submission arrived. Lane vocabulary throughout: a member is a lane.
 */
export function classifyRead(
  outcome: SubmissionReadOutcome,
  context: SubmissionReadContext,
): SubmissionIssue | null {
  if (outcome.kind === "value") return null;
  const locators = {
    submission_id: context.submissionId,
    submission_path: context.submissionPath,
  } as const;
  if (outcome.kind === "missing") {
    return {
      code: "submission_missing",
      message: `lane '${context.lane}' submitted nothing at its bound path`,
      ...locators,
    };
  }
  return {
    code: "submission_malformed",
    message: `lane '${context.lane}' submitted bytes that are not JSON: ${outcome.detail}`,
    ...locators,
  };
}
