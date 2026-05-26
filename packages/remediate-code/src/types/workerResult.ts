export type WorkerResultStatus =
  | "completed"
  | "blocked"
  | "failed"
  | "no_progress";

export const WORKER_RESULT_MAX_ERRORS = 20;
export const WORKER_RESULT_ERROR_MAX_LENGTH = 2_000;

export function normalizeWorkerResultErrors(
  errors: readonly string[] | undefined,
): string[] {
  return (errors ?? [])
    .slice(0, WORKER_RESULT_MAX_ERRORS)
    .map((error) => error.slice(0, WORKER_RESULT_ERROR_MAX_LENGTH));
}

export interface WorkerResult {
  contract_version: "remediate-code-worker-result/v1alpha1";
  run_id: string;
  obligation_id: string | null;
  status: WorkerResultStatus;
  progress_made: boolean;
  selected_executor: string | null;
  artifacts_written: string[];
  summary: string;
  next_likely_step: string | null;
  /**
   * Optional bounded diagnostics. Producers should use
   * normalizeWorkerResultErrors before serializing worker results.
   */
  errors?: string[];
}
