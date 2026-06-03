export interface RunPaths {
  runDir: string;
  taskPath: string;
  promptPath: string;
  resultPath: string;
  stdoutPath: string;
  stderrPath: string;
  statusPath: string;
}

export interface DispatchBatchRun {
  run_id: string;
  task_path: string;
  prompt_path: string;
  result_path: string;
  status_path: string;
  audit_results_path?: string;
  pending_audit_tasks_path?: string;
}
