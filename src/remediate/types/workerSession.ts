/**
 * Worker tasks serialize directly to task.json, so their persisted field names
 * intentionally stay snake_case for consistency across providers and bridges.
 */
export interface WorkerTask {
  contract_version: "remediation-worker/v1alpha1";
  run_id: string;
  repo_root: string;
  artifacts_dir: string;
  obligation_id: string | null;
  preferred_executor: string;
  result_path: string;
  audit_results_path?: string;
  pending_audit_tasks_path?: string;
  runtime_updates_path?: string;
  external_analyzer_results_path?: string;
  /**
   * Subprocess timeout in milliseconds. Must be > 0; values ≤ 0 cause immediate kills.
   * Recommended range: 30_000–600_000 (30 s – 10 min). Omit to inherit the provider default.
   */
  timeout_ms?: number;
  /**
   * Maximum number of retry attempts after a failed step. Must be ≥ 0.
   * Recommended maximum: 5. Omit to use the provider default (typically 0 = no retries).
   */
  max_retries?: number;
  /**
   * Command and arguments for the LocalSubprocessProvider to launch directly.
   * When present, LocalSubprocessProvider uses worker_command[0] as the executable
   * and worker_command.slice(1) as its arguments instead of throwing.
   */
  worker_command?: string[];
}

// Timeout resolution now lives in `audit-tools/shared` so both orchestrators
// honor per-task `timeout_ms` identically. Re-exported here to preserve the
// existing local import surface.
export { resolveWorkerTaskTimeoutMs } from "audit-tools/shared";

export function resolveWorkerTaskMaxRetries(
  task: Pick<WorkerTask, "max_retries">,
  fallbackRetries: number,
): number {
  if (
    typeof task.max_retries === "number" &&
    Number.isFinite(task.max_retries) &&
    task.max_retries >= 0
  ) {
    return Math.floor(task.max_retries);
  }
  return fallbackRetries;
}

