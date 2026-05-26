import { createWriteStream, type WriteStream } from "node:fs";
import { spawn } from "node:child_process";
import type {
  LaunchFreshSessionInput,
  LaunchFreshSessionResult,
} from "./types.js";

const TERMINATION_SIGNAL: NodeJS.Signals = "SIGTERM";
const FORCE_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const FORCE_KILL_GRACE_MS = 1_000;

interface SpawnLoggedCommandOptions {
  createWriteStream?: typeof createWriteStream;
  spawn?: typeof spawn;
  killGraceMs?: number;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

// On Windows `command` must be the resolved .cmd / .exe path because `spawn`
// does not consult PATH for executables without a shell. Callers should use
// `platformCommand()` (scripts/smoke-packaged-audit-code.mjs) or similar to
// supply the correct command form for the host OS.
export async function spawnLoggedCommand(
  command: string,
  args: string[],
  input: LaunchFreshSessionInput,
  env?: Record<string, string>,
  options: SpawnLoggedCommandOptions = {},
): Promise<LaunchFreshSessionResult> {
  const openWriteStream = options.createWriteStream ?? createWriteStream;
  const spawnProcess = options.spawn ?? spawn;
  const killGraceMs = options.killGraceMs ?? FORCE_KILL_GRACE_MS;

  return await new Promise((resolve, reject) => {
    const stdoutLog = openWriteStream(input.stdoutPath, { flags: "a" });
    const stderrLog = openWriteStream(input.stderrPath, { flags: "a" });
    const startedAt = Date.now();
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let pendingLogWrites = 0;
    let childClosed = false;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let logsEnded = false;

    const clearTimers = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      if (heartbeat) {
        clearInterval(heartbeat);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
    };

    const endLogs = (callback: () => void): void => {
      if (logsEnded) {
        callback();
        return;
      }
      logsEnded = true;
      let remaining = 2;
      const done = (): void => {
        remaining -= 1;
        if (remaining === 0) {
          callback();
        }
      };
      stdoutLog.end(done);
      stderrLog.end(done);
    };

    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimers();
      endLogs(callback);
    };

    const fail = (error: unknown): void => {
      if (child && !child.killed) {
        child.kill(FORCE_KILL_SIGNAL);
      }
      const normalized = error instanceof Error ? error : new Error(String(error));
      settle(() => reject(normalized));
    };

    const writeLog = (write: WriteStream, chunk: Buffer | string): void => {
      pendingLogWrites += 1;
      write.write(chunk, () => {
        pendingLogWrites -= 1;
        maybeSettleFromClose();
      });
    };

    const maybeSettleFromClose = (): void => {
      if (!childClosed || pendingLogWrites > 0 || settled) {
        return;
      }
      if (timedOut) {
        settle(() =>
          reject(
            new Error(
              `Fresh session timed out after ${input.timeoutMs}ms for run ${input.runId}.`,
            ),
          ),
        );
        return;
      }
      settle(() =>
        resolve({
          accepted: closeCode === 0 && closeSignal === null,
          processId: spawnedChild.pid,
          exitCode: closeCode,
          signal: closeSignal,
          command: formatCommand(command, args),
          args,
          stdoutPath: input.stdoutPath,
          stderrPath: input.stderrPath,
          error:
            closeCode === 0 && closeSignal === null
              ? undefined
              : closeSignal
                ? `Provider command exited with signal ${closeSignal}.`
                : `Provider command exited with code ${closeCode}.`,
        }),
      );
    };

    stdoutLog.on("error", fail);
    stderrLog.on("error", fail);

    let spawnedChild: ReturnType<typeof spawn>;
    try {
      spawnedChild = spawnProcess(command, args, {
        cwd: input.repoRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = spawnedChild;
    } catch (error) {
      fail(error);
      return;
    }
    if (!spawnedChild.stdout || !spawnedChild.stderr) {
      fail(
        new Error(
          `Fresh session spawn for run ${input.runId} did not provide pipe-backed stdout/stderr streams.`,
        ),
      );
      return;
    }

    timer = setTimeout(() => {
      timedOut = true;
      spawnedChild.kill(TERMINATION_SIGNAL);
      forceKillTimer = setTimeout(() => {
        if (!settled) {
          spawnedChild.kill(FORCE_KILL_SIGNAL);
        }
      }, killGraceMs);
    }, input.timeoutMs);
    heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const message =
        `[provider] run ${input.runId} still running after ${elapsedMs}ms\n`;
      writeLog(stderrLog, message);
      if (input.uiMode === "visible") {
        process.stderr.write(message);
      }
    }, 30_000);

    spawnedChild.stdout.on("data", (chunk) => {
      writeLog(stdoutLog, chunk);
      if (input.uiMode === "visible") {
        process.stdout.write(chunk);
      }
    });
    spawnedChild.stderr.on("data", (chunk) => {
      writeLog(stderrLog, chunk);
      if (input.uiMode === "visible") {
        process.stderr.write(chunk);
      }
    });
    spawnedChild.on("error", fail);
    spawnedChild.on("exit", (code, signal) => {
      closeCode = code;
      closeSignal = signal;
    });
    spawnedChild.on("close", (code, signal) => {
      childClosed = true;
      closeCode = code;
      closeSignal = signal;
      maybeSettleFromClose();
    });
  });
}
