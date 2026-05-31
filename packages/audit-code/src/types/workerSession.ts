export const WORKER_COMMAND_MODES = ["run", "deferred"] as const;
export type WorkerCommandMode = (typeof WORKER_COMMAND_MODES)[number];

export interface AccessDeclaration {
  read_paths: string[];
  write_paths: string[];
  forbidden_patterns?: string[];
}

/**
 * Worker tasks serialize directly to task.json, so their persisted field names
 * intentionally stay snake_case for consistency across providers and bridges.
 */
export interface WorkerTask {
  contract_version: "audit-code-worker/v1alpha1";
  run_id: string;
  repo_root: string;
  artifacts_dir: string;
  obligation_id: string | null;
  preferred_executor: string;
  result_path: string;
  worker_command: string[];
  audit_results_path?: string;
  pending_audit_tasks_path?: string;
  runtime_updates_path?: string;
  external_analyzer_results_path?: string;
  worker_command_mode?: WorkerCommandMode;
  /** @deprecated Prefer worker_command_mode: "deferred" for new task files. */
  skip_worker_command?: boolean;
  timeout_ms?: number;
  max_retries?: number;
  access?: AccessDeclaration;
}

export function usesDeferredWorkerCommand(
  task: Pick<WorkerTask, "worker_command_mode" | "skip_worker_command">,
): boolean {
  return task.worker_command_mode === "deferred";
}
