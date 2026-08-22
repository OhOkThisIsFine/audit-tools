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
] as const;

export type AuditIngestIssueCode = (typeof AUDIT_INGEST_ISSUE_CODES)[number];

/** One classified failure on the audit ingest lane. */
export type AuditHostIngestIssue = SubmissionIssue<AuditIngestIssueCode>;
