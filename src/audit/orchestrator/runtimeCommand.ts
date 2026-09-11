import { spawn } from "node:child_process";
import {
  quoteForShellInterpreterCmd,
  stripAuditToolsControlEnv,
} from "audit-tools/shared";

// Deterministic runtime-validation command execution: resolve a command to a
// platform-correct spawn invocation (Windows package-manager shims need a
// cmd.exe wrapper) and run it capturing a confirmed/not_confirmed/inconclusive
// outcome. Hoisted out of internalExecutors.ts as a shared, side-effect-only
// helper module.
//
// The cmd.exe quoting for the package-manager batch path reuses the canonical
// exec.ts helpers so the safe-character set stays unified.

// Wrapper-only control-variable stripping is owned by the shared execution
// substrate so runtime validation never inherits driver lifecycle authority.
// This strips the host-signaling env vars so a runtime-validation command sees a
// clean environment — a suite that branches on CLAUDECODE would otherwise be graded
// against the host's interactive-session state, marking healthy code "not_confirmed".

/**
 * The bounded wait every runtime-validation command runs under.
 *
 * Stated ONCE and exported so no call site writes its own number: a bound
 * hard-coded per caller is how two callers end up disagreeing about how long
 * "too long" is, and the drain's progress guarantee then depends on which one
 * you happened to read. Generous, because a validation command is host-authored
 * and may legitimately be a whole suite — what matters is that it is FINITE.
 */
export const RUNTIME_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Grace between the polite stop and the unignorable one. SIGTERM is a request a
 * child may ignore; without the escalation the "bound" would be advisory.
 */
const KILL_ESCALATION_GRACE_MS = 2_000;

/**
 * How many trailing lines a command's evidence can ever show. The number is
 * stated once because the BUFFER is sized from it: the accumulator keeps only
 * what a reader can see, so the two cannot disagree about how much is kept.
 */
export const EVIDENCE_TAIL_LINES = 10;

/**
 * Character ceiling on the retained tail. The line budget alone does not bound
 * a command whose output is one enormous line (a `--json` dump, a minified
 * bundle, a progress bar with no newline): only the character cap does.
 */
export const EVIDENCE_TAIL_MAX_CHARS = 64 * 1024;

/**
 * Character ceiling on a SINGLE retained line, so the tail budget cannot be
 * spent by one line and leave the evidence empty of anything readable.
 */
export const EVIDENCE_TAIL_MAX_LINE_CHARS = 8 * 1024;

/**
 * A bounded tail of a child's output: the last {@link EVIDENCE_TAIL_LINES}
 * lines, plus the counts needed to describe what was dropped.
 *
 * This exists because the runner used to accumulate `stdout += String(chunk)`
 * for the WHOLE stream and slice the last ten lines only at the end — so the
 * memory a validation command could cost was whatever the command chose to
 * print, and a sufficiently chatty one aborted the whole `advanceAudit` drain
 * with a string-length `RangeError` from inside the runner. A drain that dies
 * of its own evidence buffer is the bound-in-name-only failure this module
 * already refuses for time, so the same rule is applied to bytes: keep the
 * evidence contract's window, count the rest.
 *
 * The counts are what make the bound honest rather than lossy — the marker
 * still reports the TRUE total line count of the full stream, so a reader
 * cannot mistake ten retained lines for ten produced ones.
 */
export class BoundedOutputTail {
  /**
   * Segments between newlines. The LAST element is the in-progress line, so the
   * array never needs a separate partial-line buffer. Invariant: after every
   * push, `segments.length <= EVIDENCE_TAIL_LINES + 1` and every segment is at
   * most {@link EVIDENCE_TAIL_MAX_LINE_CHARS} characters.
   */
  private segments: string[] = [""];
  /** Lines dropped off the front — newlines this tail no longer represents. */
  private droppedLines = 0;
  /** Characters clipped from the head of a retained line (giant-line case). */
  private clippedChars = 0;

  push(chunk: string): void {
    if (chunk.length === 0) return;
    const parts = chunk.split("\n");
    const last = this.segments.length - 1;
    this.segments[last] += parts[0];
    for (let index = 1; index < parts.length; index += 1) {
      this.segments.push(parts[index]!);
    }
    this.trim();
  }

  /**
   * Enforce both ceilings, in the order that keeps each one decidable: the line
   * window first (cutting at a newline, never mid-line, so a retained line is a
   * LINE rather than a fragment), then the per-line cap, then the total.
   *
   * The per-line cap applies to EVERY retained segment, the live one included.
   * Clipping only the head was not a bound on the tail at all: a chunk that
   * extends the in-progress line is appended to the LAST segment, so a command
   * printing one newline-free blast had it buffered whole — and it was not even
   * droppable, because the front-drop below never removes the live segment —
   * until the next push happened to arrive and re-run this.
   */
  private trim(): void {
    const excess = this.segments.length - (EVIDENCE_TAIL_LINES + 1);
    if (excess > 0) {
      this.segments.splice(0, excess);
      // Each dropped segment was terminated by a newline this tail no longer
      // holds, so exactly that many lines left the front.
      this.droppedLines += excess;
    }
    this.segments = this.segments.map((segment) => {
      if (segment.length <= EVIDENCE_TAIL_MAX_LINE_CHARS) return segment;
      const cut = segment.length - EVIDENCE_TAIL_MAX_LINE_CHARS;
      this.clippedChars += cut;
      return segment.slice(cut);
    });
    // A tail of many max-length lines still has to fit the character budget:
    // drop whole leading lines until it does. What is measured is the length
    // `read()` will actually join — segments PLUS the separators between them —
    // because the ceiling is on the retained text, and a bound that excluded
    // the separators would be a bound on something nobody reads.
    let total = this.retainedLength();
    while (total > EVIDENCE_TAIL_MAX_CHARS && this.segments.length > 1) {
      const dropped = this.segments.shift()!;
      total -= dropped.length + 1;
      this.droppedLines += 1;
    }
  }

  /** The character length of what {@link read} will return. */
  private retainedLength(): number {
    let total = 0;
    for (const segment of this.segments) {
      total += segment.length;
    }
    return total + Math.max(0, this.segments.length - 1);
  }

  /**
   * The retained text and the true totals of the stream it came from. A trailing
   * empty segment is the artifact of output ending in a newline, not a line.
   */
  read(): { text: string; totalLines: number; clippedChars: number } {
    const segments = [...this.segments];
    if (segments.length > 1 && segments[segments.length - 1] === "") {
      segments.pop();
    }
    if (segments.length === 1 && segments[0] === "") {
      return { text: "", totalLines: 0, clippedChars: this.clippedChars };
    }
    return {
      text: segments.join("\n"),
      totalLines: this.droppedLines + segments.length,
      clippedChars: this.clippedChars,
    };
  }
}

/**
 * The evidence array for a finished (or failed) command, from the two bounded
 * tails. Kept as one function because both the `error` and the `close` handler
 * build it, and two copies drifting is how a failure path starts reporting a
 * different window than the success path.
 *
 * The TOTAL is the sum of the two tails' own counts, never a count taken over
 * the composed text. Composing first and counting the result means counting a
 * STRING, and every string operation that touches it is a chance to change what
 * the number means: the previous version called `.trim()` on the composition,
 * which deletes a whitespace-only line at either boundary — so a stream whose
 * first line was blank reported one line fewer than it printed, in the very
 * marker whose only job is to state the true count. Each tail already knows how
 * many lines IT held ({@link BoundedOutputTail.read}), and the two streams meet
 * at exactly one boundary, so their sum is the composed count with nothing to
 * trim and nothing to get wrong.
 */
function commandEvidence(
  stdout: BoundedOutputTail,
  stderr: BoundedOutputTail,
): string[] {
  const out = stdout.read();
  const err = stderr.read();
  // The separator belongs BETWEEN two non-empty tails and nowhere else: an
  // absent stream contributes no line, and a leading or trailing empty string
  // in the composition would otherwise be a line the command never printed.
  const lines = [out.text, err.text]
    .filter((text) => text.length > 0)
    .flatMap((text) => text.split(/\r?\n/));
  const totalLines = out.totalLines + err.totalLines;
  const shown = lines.slice(-EVIDENCE_TAIL_LINES);
  if (totalLines <= shown.length && out.clippedChars === 0 && err.clippedChars === 0) {
    return lines;
  }
  const clipped = out.clippedChars + err.clippedChars;
  return [
    `[... truncated: showing last ${shown.length} of ${totalLines} lines` +
      (clipped > 0
        ? `, ${clipped} character(s) clipped from the retained text`
        : "") +
      " ...]",
    ...shown,
  ];
}

/**
 * Terminate a timed-out child, INCLUDING anything it spawned.
 *
 * On win32 this runner wraps package-manager shims in `cmd.exe /d /s /c` (see
 * `resolveRuntimeValidationSpawnCommand`), so the process we hold a handle to is
 * the shell, not the tool: `child.kill()` reaps the wrapper and leaves the npm →
 * node grandchildren running, which is the orphan case the bound exists to
 * prevent. `taskkill /T` walks the tree instead. Everywhere else the executable
 * is spawned DIRECTLY — no wrapper, so no tree of our making — and the signal
 * pair is the whole story. A command that itself forks a daemon on POSIX is
 * beyond what this can promise without a process group, and is left stated
 * rather than silently assumed.
 *
 * `platform` is a parameter so both branches are reachable from a test on either
 * OS; the taskkill spawn failing (absent, denied) falls back to SIGKILL rather
 * than leaving the child alive.
 */
export function killRuntimeCommandTree(
  child: { pid?: number; kill: (signal?: NodeJS.Signals) => boolean },
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32" && child.pid !== undefined) {
    const reaper = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    reaper.on("error", () => {
      child.kill("SIGKILL");
    });
    return;
  }
  child.kill("SIGTERM");
}

export async function runCommand(
  command: string[],
  cwd: string,
  timeoutMs: number = RUNTIME_COMMAND_TIMEOUT_MS,
): Promise<{
  status: "confirmed" | "not_confirmed" | "inconclusive";
  summary: string;
  evidence: string[];
}> {
  // COR-4a8d9779: fast-fail before spawn so an empty command array produces a
  // descriptive error instead of an ENOENT from spawn("", ...).
  if (command.length === 0 || !command[0]) {
    return {
      status: "inconclusive",
      summary: "Runtime validation command is empty — no command to execute",
      evidence: [],
    };
  }
  const spawnCommand = resolveRuntimeValidationSpawnCommand(command);
  const displayCommand = command.join(" ");
  return await new Promise((resolve) => {
    const child = spawn(spawnCommand.command, spawnCommand.args, {
      cwd,
      env: stripAuditToolsControlEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // Bounded from the first byte: the accumulator keeps only the evidence
    // window, so no command can make this runner's memory its own choice.
    const stdout = new BoundedOutputTail();
    const stderr = new BoundedOutputTail();
    child.stdout.on("data", (chunk) => {
      stdout.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(String(chunk));
    });
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    // Set when THIS runner's bound fired, so `close` can report a timeout rather
    // than reporting the kill it caused as an ordinary signal death.
    let timedOut = false;
    let escalation: NodeJS.Timeout | null = null;
    const deadline: NodeJS.Timeout | null =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killRuntimeCommandTree(child);
            // SIGTERM is a request; a child that installs a handler and ignores
            // it would never emit `close`, and the bound would be a bound in
            // name only. `unref` so a child that does exit promptly never holds
            // the event loop open waiting for this.
            escalation = setTimeout(() => {
              child.kill("SIGKILL");
            }, KILL_ESCALATION_GRACE_MS);
            escalation.unref?.();
          }, timeoutMs)
        : null;
    /**
     * Clear BOTH timers on every resolution path. A deadline left armed after an
     * early exit is a leaked handle that can hold the process open past the work
     * it was watching — the reason this is one function rather than a line
     * repeated in each branch.
     */
    const clearTimers = (): void => {
      if (deadline) clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
    };
    child.on("error", (error) => {
      clearTimers();
      resolve({
        status: "inconclusive",
        summary: `Failed to execute ${displayCommand}: ${error.message}`,
        evidence: commandEvidence(stdout, stderr),
      });
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", () => {
      clearTimers();
      const evidence = commandEvidence(stdout, stderr);
      const succeeded = exitCode === 0 && !timedOut;
      let summary: string;
      if (timedOut) {
        // NAMED as a timeout, ahead of the exit-code branches: the child died of
        // the kill this runner sent, so its code/signal describe our own bound,
        // not the command's verdict. Reporting "terminated by SIGKILL" here
        // would attribute the runner's action to the code under validation, and
        // a caller triaging the failure could not tell a hang from a crash.
        summary =
          `Deterministic runtime command timed out after ${String(timeoutMs)}ms and was killed: ` +
          `${displayCommand}`;
      } else if (succeeded) {
        summary = `Deterministic runtime command succeeded: ${displayCommand}`;
      } else if (exitCode !== null) {
        summary = `Deterministic runtime command failed with exit code ${exitCode}: ${displayCommand}`;
      } else if (exitSignal !== null) {
        summary = `Deterministic runtime command terminated by signal ${exitSignal}: ${displayCommand}`;
      } else {
        summary = `Deterministic runtime command exited with unknown status: ${displayCommand}`;
      }
      resolve({
        status: succeeded ? "confirmed" : "not_confirmed",
        summary,
        evidence,
      });
    });
  });
}

export function resolveRuntimeValidationSpawnCommand(
  command: string[],
  platform: NodeJS.Platform = process.platform,
  shellCommand = process.env.ComSpec ?? "cmd.exe",
): { command: string; args: string[] } {
  const [executable, ...args] = command;
  if (!executable) {
    return { command: "", args: [] };
  }
  if (platform !== "win32") {
    process.stderr.write(
      JSON.stringify({
        kind: "runtime_spawn_resolved",
        wrap: "none",
        executable,
        platform,
        ts: new Date().toISOString(),
      }) + "\n",
    );
    return { command: executable, args };
  }
  // Classify on the BASENAME, not the raw executable: an absolute/relative shim
  // path (e.g. "C:\\tools\\npm.cmd" or "./node_modules/.bin/npm.cmd") must still be
  // recognized as a package-manager shim so it is wrapped through cmd.exe. Splitting
  // the directory off first prevents the path prefix from defeating the includes()
  // membership test below.
  const basename = executable.split(/[\\/]/).pop() ?? executable;
  const packageManager = basename.replace(/\.(cmd|bat)$/i, "").toLowerCase();
  if (["npm", "npx", "pnpm", "yarn"].includes(packageManager)) {
    process.stderr.write(
      JSON.stringify({
        kind: "runtime_spawn_resolved",
        wrap: "cmd.exe",
        executable,
        shell_command: shellCommand,
        platform,
        ts: new Date().toISOString(),
      }) + "\n",
    );
    return {
      command: shellCommand,
      args: ["/d", "/s", "/c", command.map(quoteForShellInterpreterCmd).join(" ")],
    };
  }
  process.stderr.write(
    JSON.stringify({
      kind: "runtime_spawn_resolved",
      wrap: "none",
      executable,
      platform,
      ts: new Date().toISOString(),
    }) + "\n",
  );
  return { command: executable, args };
}
