// sites-pinned: tests/audit/semantic-review-step.test.ts
// (the draw's own two remedies decide which section `workload_stale` and
// `result_validation_failed` render under)
/**
 * The audit ingest's issue vocabulary: the SHARED submission codes plus this
 * draw's own domain corroboration codes.
 *
 * The submission half is imported, never restated — a submission that is
 * missing, unparseable, contract-invalid, or a duplicate identity means exactly
 * the same thing on both sides of the pipeline. The audit-results validation
 * half stays here: the per-result content rules (evidence present, line spans
 * inside the file, line counts matching disk) are single-draw corroboration,
 * and the classifier doc names this extend-on-the-draw's-side direction — see
 * `RemediationIssueCode`, the remediate twin of exactly this pattern.
 */
import {
  SUBMISSION_ISSUE_CODES,
  SUBMISSION_ISSUE_REMEDY,
  type IssueRemedy,
  type SubmissionIssue,
} from "audit-tools/shared";

export const AUDIT_INGEST_ISSUE_CODES = [
  ...SUBMISSION_ISSUE_CODES,
  /**
   * Well-formed and identity-bound, but refused by the per-result validator
   * that runs BEFORE acceptance (the audit-results content rules: evidence
   * present, line spans inside the file, line counts matching disk). Distinct
   * from `submission_contract_invalid`, which is the envelope/schema contract:
   * a host repairing this one must fix the CONTENT of a finding or its
   * coverage, not the shape of the envelope.
   */
  "result_validation_failed",
  /**
   * The persisted host workload was issued under a contract version this build
   * no longer mints, so it cannot be re-derived and no submission can be
   * accepted against it. Distinct from every other workload refusal because it
   * is RECOVERABLE BY EXACTLY ONE ACTION — re-prepare, which publishes a
   * current workload — and because the host holding a bound result path from
   * the stale document needs to be told that, not told its bytes are wrong.
   *
   * The trigger is a contract-version bump that changed the work item's SHAPE
   * (v1alpha1 `{complexity, risk}` metadata → v1alpha2's shared `demand`
   * ranking). Without this code the class collapsed into a bare shape refusal
   * naming neither the version nor the repair.
   */
  "workload_stale",
] as const;

export type AuditIngestIssueCode = (typeof AUDIT_INGEST_ISSUE_CODES)[number];

/** One classified failure on the audit ingest lane. */
export type AuditHostIngestIssue = SubmissionIssue<AuditIngestIssueCode>;

/**
 * What the host must DO about each audit ingest code — the shared remedies plus
 * this draw's two.
 *
 * The `Record` over the whole union is the enforcement: a code added above with
 * no remedy here is a type error, so it cannot default into whichever rendered
 * section a filter leaves it in. Read {@link SUBMISSION_ISSUE_REMEDY} for what
 * the three remedies mean and why the third one exists.
 */
const AUDIT_INGEST_ISSUE_REMEDY: Readonly<
  Record<AuditIngestIssueCode, IssueRemedy>
> = {
  ...SUBMISSION_ISSUE_REMEDY,
  // The envelope was fine and the CONTENT was refused — a repair of the finding
  // or its coverage, written again at the same bound path.
  result_validation_failed: "repair",
  // Not about any one result: the run's own persisted workload or binding set
  // carries a contract version this build no longer mints. The ingest returns it
  // as an issue precisely so the fold walks on to the re-prepare in the SAME
  // call, which rewrites the document. Nothing is asked of the host.
  workload_stale: "none",
};

/** The remedy for one classified audit ingest failure. */
export function auditIngestRemedy(issue: AuditHostIngestIssue): IssueRemedy {
  return AUDIT_INGEST_ISSUE_REMEDY[issue.code];
}
