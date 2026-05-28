import { createWriteStream, type WriteStream } from "node:fs";
import { spawn } from "node:child_process";
import type {
  LaunchFreshSessionInput,
  LaunchFreshSessionResult,
} from "@audit-tools/shared";

const TERMINATION_SIGNAL: NodeJS.Signals = "SIGTERM";
const FORCE_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const FORCE_KILL_GRACE_MS = 1_000;

interface SpawnLoggedCommandOptions {
  createWriteStream?: typeof createWriteStream;
  spawn?: typeof spawn;
  killGraceMs?: number;
  opentoken?: boolean;
  opentokenCommand?: string;
}

function quoteCmdArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) return value;
  return `"${value.replace(/(["^&|<>%])/g, "^$1")}"`;
}

function applyOpenTokenWrap(
  command: string,
  args: string[],
  opentokenCommand: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    const inner = [command, ...args].map(quoteCmdArg).join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", `${opentokenCommand} wrap ${inner}`],
    };
  }
  return { command: opentokenCommand, args: ["wrap", command, ...args] };
}

function tee(write: Pick<WriteStream, "write">, chunk: Buffer | string): void {
  write.write(chunk);
}

// Encapsulates the mutable lifecycle state for a single spawned command.
// Makes cleanup ordering explicit and prevents settle/cleanup from racing.
class CommandSession {
  private settled = false;
  private timedOut = false;
  private child: ReturnType<typeof spawn> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private forceKillTimer: NodeJS.Timeout | undefined;
  private readonly stdoutLog: WriteStream;
  private readonly stderrLog: WriteStream;
  private readonly startedAt: number;

  constructor(stdoutLog: WriteStream, stderrLog: WriteStream) {
    this.stdoutLog = stdoutLog;
    this.stderrLog = stderrLog;
    this.startedAt = Date.now();
  }

  setChild(child: ReturnType<typeof spawn>): void {
    this.child = child;
  }

  setTimer(timer: NodeJS.Timeout): void {
    this.timer = timer;
  }

  setHeartbeat(heartbeat: NodeJS.Timeout): void {
    this.heartbeat = heartbeat;
  }

  stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  markTimedOut(): void {
    this.timedOut = true;
  }

  isTimedOut(): boolean {
    return this.timedOut;
  }

  isSettled(): boolean {
    return this.settled;
  }

  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  cleanup(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.stdoutLog.end();
    this.stderrLog.end();
  }

  settle(callback: () => void): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    callback();
  }

  fail(error: unknown, reject: (err: Error) => void): void {
    if (!this.settled && this.child && !this.child.killed) {
      this.child.kill(FORCE_KILL_SIGNAL);
    }
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    this.settle(() => reject(normalized));
  }

  scheduleForceKill(graceMs: number, child: ReturnType<typeof spawn>): void {
    this.forceKillTimer = setTimeout(() => {
      if (!this.settled) {
        child.kill(FORCE_KILL_SIGNAL);
      }
    }, graceMs);
  }
}

// On Windows `command` must be the resolved .cmd / .exe path because `spawn`
// does not consult PATH for executables without a shell. Callers should use
// `platformCommand()` from smoke scripts or similar helpers to
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

  if (options.opentoken) {
    const wrapped = applyOpenTokenWrap(
      command,
      args,
      options.opentokenCommand ?? "opentoken",
    );
    command = wrapped.command;
    args = wrapped.args;
  }

  return await new Promise((resolve, reject) => {
    const stdoutLog = openWriteStream(input.stdoutPath, { flags: "a" });
    const stderrLog = openWriteStream(input.stderrPath, { flags: "a" });
    const session = new CommandSession(stdoutLog, stderrLog);

    stdoutLog.on("error", (err) => session.fail(err, reject));
    stderrLog.on("error", (err) => session.fail(err, reject));

    let spawnedChild: ReturnType<typeof spawn>;
    try {
      spawnedChild = spawnProcess(command, args, {
        cwd: input.repoRoot,
        env: { ...process.env, ...env },
        stdio: [input.stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      session.setChild(spawnedChild);
    } catch (error) {
      session.fail(error, reject);
      return;
    }
    if (input.stdinText !== undefined) {
      if (!spawnedChild.stdin) {
        session.fail(
          new Error(
            `Fresh session spawn for run ${input.runId} did not provide pipe-backed stdin.`,
          ),
          reject,
        );
        return;
      }
      spawnedChild.stdin.end(input.stdinText);
    }
    if (!spawnedChild.stdout || !spawnedChild.stderr) {
      session.fail(
        new Error(
          `Fresh session spawn for run ${input.runId} did not provide pipe-backed stdout/stderr streams.`,
        ),
        reject,
      );
      return;
    }

    session.setTimer(
      setTimeout(() => {
        session.markTimedOut();
        session.stopHeartbeat();
        spawnedChild.kill(TERMINATION_SIGNAL);
        session.scheduleForceKill(killGraceMs, spawnedChild);
      }, input.timeoutMs),
    );

    session.setHeartbeat(
      setInterval(() => {
        const elapsedMs = session.elapsedMs();
        const message = `[provider] run ${input.runId} still running after ${elapsedMs}ms\n`;
        tee(stderrLog, message);
        if (input.uiMode === "visible") {
          process.stderr.write(message);
        }
        // Structured heartbeat for telemetry consumers
        process.stderr.write(
          JSON.stringify({
            type: "provider_heartbeat",
            runId: input.runId,
            elapsedMs,
          }) + "\n",
        );
        input.onProgress?.({
          type: "heartbeat",
          runId: input.runId,
          obligationId: input.obligationId,
          elapsedMs,
        });
      }, 30_000),
    );

    let stdoutLineBuf = "";
    spawnedChild.stdout.on("data", (chunk) => {
      tee(stdoutLog, chunk);
      if (input.uiMode === "visible") {
        process.stdout.write(chunk);
      }
      if (input.onProgress) {
        stdoutLineBuf += chunk.toString();
        const lines = stdoutLineBuf.split("\n");
        stdoutLineBuf = lines.pop()!;
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) {
            input.onProgress({
              type: "output",
              runId: input.runId,
              obligationId: input.obligationId,
              elapsedMs: session.elapsedMs(),
              message: trimmed,
            });
          }
        }
      }
    });
    spawnedChild.stderr.on("data", (chunk) => {
      tee(stderrLog, chunk);
      if (input.uiMode === "visible") {
        process.stderr.write(chunk);
      }
    });
    spawnedChild.on("error", (err) => session.fail(err, reject));
    spawnedChild.on("exit", (code, signal) => {
      if (session.isTimedOut()) {
        session.settle(() =>
          reject(
            new Error(
              `Fresh session timed out after ${input.timeoutMs}ms for run ${input.runId}.`,
            ),
          ),
        );
        return;
      }
      session.settle(() =>
        resolve({
          accepted: true,
          processId: spawnedChild.pid,
          exitCode: code,
          signal,
        }),
      );
    });
  });
}
