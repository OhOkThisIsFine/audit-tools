import type { OrchestratorOptions } from "../types/options.js";
import type { WorkerTask } from "../types/workerSession.js";
import { resolveWorkerTaskTimeoutMs } from "../types/workerSession.js";
import type { LaunchFreshSessionInput } from "@audit-tools/shared";
import { DEFAULT_WORKER_TIMEOUT_MS } from "./constants.js";

export interface CreateRemediationWorkerTaskInput {
  runId: string;
  options: OrchestratorOptions;
  obligationId: string | null;
  preferredExecutor: string;
  resultPath: string;
  timeoutMs?: number;
  maxRetries?: number;
  workerCommand?: string[];
}

export function createRemediationWorkerTask({
  runId,
  options,
  obligationId,
  preferredExecutor,
  resultPath,
  timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  maxRetries,
  workerCommand,
}: CreateRemediationWorkerTaskInput): WorkerTask {
  return {
    contract_version: "remediation-worker/v1alpha1",
    run_id: runId,
    repo_root: options.root,
    artifacts_dir: options.artifactsDir,
    obligation_id: obligationId,
    preferred_executor: preferredExecutor,
    result_path: resultPath,
    timeout_ms: timeoutMs,
    ...(maxRetries === undefined ? {} : { max_retries: maxRetries }),
    ...(workerCommand === undefined ? {} : { worker_command: workerCommand }),
  };
}

export function createLaunchInputForTask(
  options: OrchestratorOptions,
  task: WorkerTask,
  paths: {
    promptPath: string;
    taskPath: string;
    stdoutPath: string;
    stderrPath: string;
  },
): LaunchFreshSessionInput {
  return {
    repoRoot: options.root,
    runId: task.run_id,
    obligationId: task.obligation_id,
    promptPath: paths.promptPath,
    taskPath: paths.taskPath,
    resultPath: task.result_path,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    uiMode: "headless",
    timeoutMs: resolveWorkerTaskTimeoutMs(task, DEFAULT_WORKER_TIMEOUT_MS),
  };
}
