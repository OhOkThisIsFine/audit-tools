export const WORKER_COMMAND_MODES = ["run", "deferred"] as const;
export type WorkerCommandMode = (typeof WORKER_COMMAND_MODES)[number];

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
  /**
   * Argv array passed directly to Node's spawn() as [command, ...args] with shell: false.
   * Shell injection is not possible because no shell is involved. In practice this field is
   * set to the compatibility worker bridge command when provider mode is used
   * (for example, ["remediate-code", "mcp"]).
   * and is never derived from user-controlled input.
   */
  worker_command: string[];
  audit_results_path?: string;
  pending_audit_tasks_path?: string;
  runtime_updates_path?: string;
  external_analyzer_results_path?: string;
  worker_command_mode?: WorkerCommandMode;
  /** @deprecated Prefer worker_command_mode: "deferred" for new task files. */
  skip_worker_command?: boolean;
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
}

export function resolveWorkerTaskTimeoutMs(
  task: Pick<WorkerTask, "timeout_ms">,
  fallbackMs: number,
): number {
  if (
    typeof task.timeout_ms === "number" &&
    Number.isFinite(task.timeout_ms) &&
    task.timeout_ms > 0
  ) {
    return Math.floor(task.timeout_ms);
  }
  return fallbackMs;
}

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

export function usesDeferredWorkerCommand(
  task: Pick<WorkerTask, "worker_command_mode" | "skip_worker_command">,
): boolean {
  return (
    task.worker_command_mode === "deferred" || task.skip_worker_command === true
  );
}
