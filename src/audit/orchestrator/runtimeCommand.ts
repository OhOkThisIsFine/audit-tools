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
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
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
      const output = `${stdout}\n${stderr}`.trim();
      const lines = output.length > 0 ? output.split(/\r?\n/) : [];
      const truncated = lines.length > 10;
      const evidence = truncated
        ? [`[... truncated: showing last 10 of ${lines.length} lines ...]`, ...lines.slice(-10)]
        : lines;
      resolve({
        status: "inconclusive",
        summary: `Failed to execute ${displayCommand}: ${error.message}`,
        evidence,
      });
    });
    child.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    child.on("close", () => {
      clearTimers();
      const output = `${stdout}\n${stderr}`.trim();
      const lines = output.length > 0 ? output.split(/\r?\n/) : [];
      const truncated = lines.length > 10;
      const evidence = truncated
        ? [`[... truncated: showing last 10 of ${lines.length} lines ...]`, ...lines.slice(-10)]
        : lines;
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
