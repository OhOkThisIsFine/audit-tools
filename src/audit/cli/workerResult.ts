import type { WorkerResult } from "../types/workerResult.js";
import { formatAuditResultIssues } from "../validation/auditResults.js";

export const WORKER_RESULT_CONTRACT_VERSION = "audit-code-worker-result/v1alpha1";

export function buildWorkerResult(params: {
  runId: string;
  obligationId: string | null;
  status: WorkerResult["status"];
  progressMade: boolean;
  selectedExecutor: string | null;
  artifactsWritten: string[];
  summary: string;
  nextLikelyStep: string | null;
  errors: string[];
}): WorkerResult {
  return {
    contract_version: WORKER_RESULT_CONTRACT_VERSION,
    run_id: params.runId,
    obligation_id: params.obligationId,
    status: params.status,
    progress_made: params.progressMade,
    selected_executor: params.selectedExecutor,
    artifacts_written: params.artifactsWritten,
    summary: params.summary,
    next_likely_step: params.nextLikelyStep,
    errors: params.errors,
  };
}

export function formatAuditResultValidationError(
  issues: ReturnType<typeof import("../validation/auditResults.js").validateAuditResults>,
): string {
  return (
    `audit-results validation failed with ${issues.length} error(s):\n` +
    formatAuditResultIssues(issues)
  );
}
