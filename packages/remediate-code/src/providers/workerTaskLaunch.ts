import type { LaunchFreshSessionInput } from "./types.js";
import type { WorkerTask } from "../types/workerSession.js";
import { resolveWorkerTaskTimeoutMs } from "../types/workerSession.js";

export function applyWorkerTaskLaunchSettings(
  input: LaunchFreshSessionInput,
  task: Pick<WorkerTask, "timeout_ms">,
): LaunchFreshSessionInput {
  return {
    ...input,
    timeoutMs: resolveWorkerTaskTimeoutMs(task, input.timeoutMs),
  };
}
