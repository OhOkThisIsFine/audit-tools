import { createWriteStream, type WriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { stripClaudeCodeEnv } from "../tooling/exec.js";
import type {
  LaunchFreshSessionInput,
  LaunchFreshSessionResult,
} from "./types.js";

const TERMINATION_SIGNAL: NodeJS.Signals = "SIGTERM";
const FORCE_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const FORCE_KILL_GRACE_MS = 1_000;
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface SpawnLoggedCommandOptions {
  createWriteStream?: typeof createWriteStream;
  spawn?: typeof spawn;
  killGraceMs?: number;
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

/**
 * Encapsulates one spawned provider run. The former single `new Promise`
 * closure held 13+ mutable locals and 6 inner functions; those are now fields
 * and methods here, so the lifecycle (start → log → settle) is readable without
 * a 200-line closure. Behavior is preserved exactly:
 *  - flush-before-settle: `settle` only fires on `close` after `pendingLogWrites`
 *    drains;
 *  - timeout → SIGTERM → grace → SIGKILL escalation;
 *  - OBS-101: the structured heartbeat JSON line is emitted on EVERY heartbeat,
 *    independent of `onProgress` (which stays consumer-gated).
 */
class SpawnRunController {
  private readonly stdoutLog: WriteStream;
  private readonly stderrLog: WriteStream;
  private readonly startedAt = Date.now();

  private timedOut = false;
  private settled = false;
  private child: ReturnType<typeof spawn> | null = null;
  private timer: NodeJS.Timeout | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private forceKillTimer: NodeJS.Timeout | undefined;
  private pendingLogWrites = 0;
  private childClosed = false;
  private closeCode: number | null = null;
  private closeSignal: NodeJS.Signals | null = null;
  private logsEnded = false;
  private stdoutLineBuf = "";
  private resolve!: (result: LaunchFreshSessionResult) => void;
  private reject!: (error: Error) => void;

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly input: LaunchFreshSessionInput,
    private readonly env: Record<string, string> | undefined,
    private readonly spawnProcess: typeof spawn,
    openWriteStream: typeof createWriteStream,
    private readonly killGraceMs: number,
  ) {
    this.stdoutLog = openWriteStream(input.stdoutPath, { flags: "a" });
    this.stderrLog = openWriteStream(input.stderrPath, { flags: "a" });
  }

  run(): Promise<LaunchFreshSessionResult> {
    return new Promise<LaunchFreshSessionResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.start();
    });
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
  }

  private endLogs(callback: () => void): void {
    if (this.logsEnded) {
      callback();
      return;
    }
    this.logsEnded = true;
    let remaining = 2;
    const done = (): void => {
      remaining -= 1;
      if (remaining === 0) {
        callback();
      }
    };
    this.stdoutLog.end(done);
    this.stderrLog.end(done);
  }

  private settle(callback: () => void): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.endLogs(callback);
  }

  private fail = (error: unknown): void => {
    if (this.child && !this.child.killed) {
      this.child.kill(FORCE_KILL_SIGNAL);
    }
    const normalized = error instanceof Error ? error : new Error(String(error));
    this.settle(() => this.reject(normalized));
  };

  /**
   * A failure on one of the per-run log WriteStreams (e.g. EACCES on the log
   * dir, disk full). OBS-46d448f2: previously this routed straight to `fail`
   * with the raw error, so a run that died purely because of log-file I/O was
   * indistinguishable from a provider crash. Annotate the error with which
   * stream/path failed so the rejection carries a durable, attributable signal.
   */
  private onLogStreamError = (
    stream: "stdout" | "stderr",
    path: string,
  ): ((error: unknown) => void) => {
    return (error: unknown): void => {
      const cause = error instanceof Error ? error : new Error(String(error));
      const annotated = new Error(
        `Provider run ${this.input.runId} failed writing the ${stream} log (${path}): ${cause.message}`,
        { cause },
      );
      if (this.input.uiMode === "visible") {
        process.stderr.write(`[provider] ${annotated.message}\n`);
      }
      this.fail(annotated);
    };
  };

  private writeLog(write: WriteStream, chunk: Buffer | string): void {
    this.pendingLogWrites += 1;
    write.write(chunk, () => {
      this.pendingLogWrites -= 1;
      this.maybeSettleFromClose();
    });
  }

  private maybeSettleFromClose(): void {
    if (!this.childClosed || this.pendingLogWrites > 0 || this.settled) {
      return;
    }
    if (this.timedOut) {
      this.settle(() =>
        this.reject(
          new Error(
            `Fresh session timed out after ${this.input.timeoutMs}ms for run ${this.input.runId}.`,
          ),
        ),
      );
      return;
    }
    this.settle(() =>
      this.resolve({
        accepted: this.closeCode === 0 && this.closeSignal === null,
        processId: this.child?.pid,
        exitCode: this.closeCode,
        signal: this.closeSignal,
        command: formatCommand(this.command, this.args),
        args: this.args,
        stdoutPath: this.input.stdoutPath,
        stderrPath: this.input.stderrPath,
        error:
          this.closeCode === 0 && this.closeSignal === null
            ? undefined
            : this.closeSignal
              ? `Provider command exited with signal ${this.closeSignal}.`
              : `Provider command exited with code ${this.closeCode}.`,
      }),
    );
  }

  private onHeartbeat = (): void => {
    const elapsedMs = Date.now() - this.startedAt;
    const message = `[provider] run ${this.input.runId} still running after ${elapsedMs}ms\n`;
    this.writeLog(this.stderrLog, message);
    if (this.input.uiMode === "visible") {
      process.stderr.write(message);
    }
    // Structured heartbeat telemetry is routed through the run log file so it
    // is correlated, machine-parseable, and durable. It is also echoed to
    // process.stderr when uiMode === 'visible' for console visibility.
    const structuredHeartbeat =
      JSON.stringify({
        type: "provider_heartbeat",
        runId: this.input.runId,
        elapsedMs,
      }) + "\n";
    this.writeLog(this.stderrLog, structuredHeartbeat);
    if (this.input.uiMode === "visible") {
      process.stderr.write(structuredHeartbeat);
    }
    // The onProgress callback stays consumer-gated: only fire it when wired.
    if (this.input.onProgress) {
      this.input.onProgress({
        type: "heartbeat",
        runId: this.input.runId,
        obligationId: this.input.obligationId,
        elapsedMs,
      });
    }
  };

  private emitOutputLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length > 0 && this.input.onProgress) {
      this.input.onProgress({
        type: "output",
        runId: this.input.runId,
        obligationId: this.input.obligationId,
        elapsedMs: Date.now() - this.startedAt,
        message: trimmed,
      });
    }
  }

  /**
   * Drain any trailing partial line (output with no terminating newline) as a
   * final 'output' progress event. Without this, a worker whose last line lacks
   * a trailing newline never surfaces that line (COR-64b4c9f5).
   */
  private flushStdoutLineBuf(): void {
    if (this.stdoutLineBuf.length === 0) return;
    const residual = this.stdoutLineBuf;
    this.stdoutLineBuf = "";
    this.emitOutputLine(residual);
  }

  private onStdout = (chunk: Buffer): void => {
    this.writeLog(this.stdoutLog, chunk);
    if (this.input.uiMode === "visible") {
      process.stdout.write(chunk);
    }
    if (this.input.onProgress) {
      this.stdoutLineBuf += chunk.toString();
      const lines = this.stdoutLineBuf.split("\n");
      this.stdoutLineBuf = lines.pop() ?? "";
      for (const line of lines) {
        this.emitOutputLine(line);
      }
    }
  };

  private onStderr = (chunk: Buffer): void => {
    this.writeLog(this.stderrLog, chunk);
    if (this.input.uiMode === "visible") {
      process.stderr.write(chunk);
    }
  };

  /** Spawn the child and wire timers, heartbeat, and stream handlers. */
  start(): void {
    this.stdoutLog.on("error", this.onLogStreamError("stdout", this.input.stdoutPath));
    this.stderrLog.on("error", this.onLogStreamError("stderr", this.input.stderrPath));

    let spawnedChild: ReturnType<typeof spawn>;
    try {
      spawnedChild = this.spawnProcess(this.command, this.args, {
        cwd: this.input.repoRoot,
        // ARC-6d068334: scrub the host's interactive-session markers
        // (CLAUDECODE / CLAUDE_CODE_*) from EVERY process the tool launches,
        // including a provider session spawn — otherwise a worker session (and
        // any test command it spawns) is graded against the host session state,
        // the exact contamination the deterministic-command paths already scrub.
        // Explicit per-run env overrides still win, then are scrubbed too so the
        // trust boundary is uniform rather than holding only where remembered.
        env: stripClaudeCodeEnv({ ...process.env, ...this.env }),
        stdio: [
          this.input.stdinText === undefined ? "ignore" : "pipe",
          "pipe",
          "pipe",
        ],
      });
      this.child = spawnedChild;
    } catch (error) {
      this.fail(error);
      return;
    }
    if (this.input.stdinText !== undefined) {
      if (!spawnedChild.stdin) {
        this.fail(
          new Error(
            `Fresh session spawn for run ${this.input.runId} did not provide pipe-backed stdin.`,
          ),
        );
        return;
      }
      spawnedChild.stdin.end(this.input.stdinText);
    }
    if (!spawnedChild.stdout || !spawnedChild.stderr) {
      this.fail(
        new Error(
          `Fresh session spawn for run ${this.input.runId} did not provide pipe-backed stdout/stderr streams.`,
        ),
      );
      return;
    }

    this.timer = setTimeout(() => {
      this.timedOut = true;
      spawnedChild.kill(TERMINATION_SIGNAL);
      this.forceKillTimer = setTimeout(() => {
        if (!this.settled) {
          spawnedChild.kill(FORCE_KILL_SIGNAL);
        }
      }, this.killGraceMs);
    }, this.input.timeoutMs);
    this.heartbeat = setInterval(this.onHeartbeat, HEARTBEAT_INTERVAL_MS);

    spawnedChild.stdout.on("data", this.onStdout);
    spawnedChild.stderr.on("data", this.onStderr);
    spawnedChild.on("error", this.fail);
    spawnedChild.on("exit", (code, signal) => {
      this.closeCode = code;
      this.closeSignal = signal;
    });
    spawnedChild.on("close", (code, signal) => {
      this.childClosed = true;
      this.closeCode = code;
      this.closeSignal = signal;
      // Emit the final partial stdout line (no trailing newline) before settling
      // so its 'output' progress event is not lost (COR-64b4c9f5).
      this.flushStdoutLineBuf();
      this.maybeSettleFromClose();
    });
  }
}

// Single source of truth for both orchestrators. Combines the auditor's
// flush-before-settle correctness (settle on "close" only after all buffered
// log writes have drained, and a computed `accepted`/rich result) with the
// remediator's stdin piping and optional structured progress telemetry.
//
// On Windows `command` must be the resolved .cmd / .exe path because `spawn`
// does not consult PATH for executables without a shell. Callers should use
// `platformCommand()` or similar to supply the correct command form per OS.
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

  const controller = new SpawnRunController(
    command,
    args,
    input,
    env,
    spawnProcess,
    openWriteStream,
    killGraceMs,
  );
  return controller.run();
}
