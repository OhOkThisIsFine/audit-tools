import type { LaunchFreshSessionInput } from "./types.js";

/** Minimal worker-task shape needed to resolve a per-task launch timeout. */
export interface WorkerTaskTimeout {
  timeout_ms?: number;
}

/**
 * Minimal worker-task shape the shared provider classes need: a `worker_command`
 * argv plus an optional per-task `timeout_ms`. Both orchestrators' richer
 * `WorkerTask` types structurally satisfy this, so the shared providers depend on
 * this narrow interface rather than importing either package's full task type.
 */
export interface WorkerTaskWithCommand extends WorkerTaskTimeout {
  worker_command: string[];
}

/**
 * Resolve the effective subprocess timeout for a worker task: the task's own
 * `timeout_ms` when it is a positive, finite number, otherwise the caller's
 * fallback. Centralized so both orchestrators honor per-task timeouts
 * identically rather than each provider applying its own (or no) policy.
 */
export function resolveWorkerTaskTimeoutMs(
  task: WorkerTaskTimeout,
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

/**
 * Return a launch input with its `timeoutMs` overridden by the worker task's
 * per-task `timeout_ms` when present. Providers call this on the input before
 * spawning so a task can carry a tighter (or looser) timeout than the session
 * default.
 */
export function applyWorkerTaskLaunchSettings(
  input: LaunchFreshSessionInput,
  task: WorkerTaskTimeout,
): LaunchFreshSessionInput {
  return {
    ...input,
    timeoutMs: resolveWorkerTaskTimeoutMs(task, input.timeoutMs),
  };
}
