export type WorkerResultStatus =
  | "completed"
  | "blocked"
  | "failed"
  | "no_progress";

export interface WorkerResult {
  contract_version: "audit-code-worker-result/v1alpha1";
  run_id: string;
  obligation_id: string | null;
  status: WorkerResultStatus;
  progress_made: boolean;
  selected_executor: string | null;
  artifacts_written: string[];
  summary: string;
  next_likely_step: string | null;
  errors: string[];
}
