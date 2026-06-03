import { writeJsonFile } from "@audit-tools/shared";
import type { WorkerResult } from "../types/workerResult.js";
import type { RunPaths } from "../io/runArtifactTypes.js";
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

export async function persistWorkerRunArtifacts(
  paths: RunPaths,
  workerResult: WorkerResult,
  executionMode: string,
): Promise<void> {
  await writeJsonFile(paths.resultPath, workerResult);
  await writeJsonFile(paths.statusPath, {
    run_id: workerResult.run_id,
    status: workerResult.status,
    execution_mode: executionMode,
    result_path: paths.resultPath,
  });
}

export function isWorkerResult(value: unknown): value is WorkerResult {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { contract_version?: unknown }).contract_version ===
      WORKER_RESULT_CONTRACT_VERSION
  );
}

export function buildWorkerFailureBlocker(workerResult: WorkerResult): string {
  const details = workerResult.errors.filter((error) => error.trim().length > 0);
  return details.length > 0
    ? `${workerResult.summary} ${details.join(" ")}`
    : workerResult.summary;
}

export function formatAuditResultValidationError(
  issues: ReturnType<typeof import("../validation/auditResults.js").validateAuditResults>,
): string {
  return (
    `audit-results validation failed with ${issues.length} error(s):\n` +
    formatAuditResultIssues(issues)
  );
}
