// sites-pinned: tests/shared/exec-owned-bounds.test.ts, tests/shared/exec-utf8-capture.test.ts, tests/shared/allowlisted-exec-runner-internals.test.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isOwnedJobMessage } from "./windowsOwnedJob.js";

export interface OwnedProcessCleanup {
  scope: "process_group" | "windows_job";
  root_exit_observed: boolean;
  stdio_incomplete: boolean;
  cleanup_verified: boolean;
  termination_error?: string;
}

/** One bound's TERM grace plus a finite hard-kill/capture-drain window. */
export const OWNED_PROCESS_DRAIN_GRACE_MS = 1_000;
export const OWNED_PROCESS_TERM_GRACE_MS = 2_000;

/** Shared referenced cleanup clock; callers retain their own error/capture contract. */
export function beginOwnedProcessTermination(
  owned: { terminate(signal: NodeJS.Signals): void },
  onEscalate: () => void,
  onDrainLimit: () => void,
  termGraceMs = OWNED_PROCESS_TERM_GRACE_MS,
): () => void {
  const escalation = setTimeout(() => { onEscalate(); owned.terminate("SIGKILL"); }, termGraceMs);
  const drain = setTimeout(() => { owned.terminate("SIGKILL"); onDrainLimit(); }, termGraceMs + OWNED_PROCESS_DRAIN_GRACE_MS);
  owned.terminate("SIGTERM");
  return () => { clearTimeout(escalation); clearTimeout(drain); };
}

/** Ordinary descendant ownership; neither process groups nor Jobs are a sandbox. */
export function spawnOwnedProcess(
  argv: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; deadlineAt?: number },
) {
  const windows = process.platform === "win32";
  let stopped = false;
  let rootExited = false;
  let rootStatus: number | null = null;
  let rootSignal: string | null = null;
  let emptyObserved = false;
  let terminationError: string | undefined;
  // Both src and dist tooling live three levels beneath the package root.
  // The normal build publishes this executable helper in dist/**.
  const helper = fileURLToPath(new URL("../../../dist/shared/tooling/windowsOwnedJob.js", import.meta.url));
  const child = (windows
    ? spawn(process.execPath, [helper], { cwd: options.cwd, env: { ...options.env, NODE_OPTIONS: undefined }, stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true, shell: false })
    : spawn(argv[0]!, argv.slice(1), { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false, detached: true })) as ChildProcessWithoutNullStreams;
  if (windows) {
    child.on("message", (message: unknown) => {
      if (!isOwnedJobMessage(message)) return;
      switch (message.type) {
        case "ready":
          if (!stopped && child.connected && (options.deadlineAt === undefined || Date.now() < options.deadlineAt)) child.send({ argv, env: options.env, deadlineAt: options.deadlineAt }, (error) => { if (error && !stopped) child.emit("error", error); });
          break;
        case "root_exit": rootExited = true; rootStatus = message.code; rootSignal = message.signal; break;
        case "empty": emptyObserved = true; break;
        case "error": child.emit("error", Object.assign(new Error(message.message), { code: message.code })); break;
        case "started": break;
      }
    });
  } else {
    child.once("exit", (code, signal) => { rootExited = true; rootStatus = code; rootSignal = signal; });
  }
  const terminate = (signal: NodeJS.Signals): void => {
    stopped = true;
    try {
      if (windows) {
        if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) terminationError = "owner termination not confirmed";
      }
      else if (child.pid !== undefined && child.pid > 0 && child.pid !== process.pid) process.kill(-child.pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") terminationError = code ?? "owned process termination failed";
    }
  };
  const cleanup = (stdioIncomplete: boolean): OwnedProcessCleanup => {
    if (!windows && child.pid !== undefined) {
      try { process.kill(-child.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") emptyObserved = true; }
    }
    return { scope: windows ? "windows_job" : "process_group", root_exit_observed: rootExited, stdio_incomplete: stdioIncomplete, cleanup_verified: emptyObserved, ...(terminationError ? { termination_error: terminationError } : {}) };
  };
  const release = (): void => {
    stopped = true;
    // A still-live Windows helper must not survive a terminal fallback/error.
    // Its disconnect handler closes the sole Job handle through process exit.
    if (windows && child.connected) { try { child.disconnect(); } catch { /* already disconnected */ } }
  };
  return { child, terminate, cleanup, release, rootExited: () => rootExited, rootStatus: () => rootStatus, rootSignal: () => rootSignal };
}
