import { spawn } from "node:child_process";
import { discoverProjectCommands } from "./testCommand.js";
import { resolveExecArgv, stripAuditToolsControlEnv } from "./exec.js";

/**
 * The project-test admission gate (CP-NODE-4 obligation 3 / seam_adjustments[2]).
 *
 * `runtimeCommand.ts`'s deterministic runtime-validation spawn is a DIFFERENT
 * trust surface from the model-authored anchor commands `allowlistedExec.ts`
 * gates: the command here is never model-authored — it is PRODUCED by
 * {@link discoverProjectCommands} from the repository's own project files
 * (package.json / go.mod / pyproject.toml). So admission is anchored to
 * discovery itself, not to a static per-executable flag table: a command is
 * admitted iff it is EXACTLY the `.test` vector `discoverProjectCommands(root)`
 * emits for `root` right now (`['npm','test']` / `['go','test','./...']` /
 * `['python','-m','pytest']`). Anything discovery did not emit is refused —
 * including a superficially similar command carrying extra flags.
 *
 * This is a SECOND, separately-owned admission mechanism (invariants[0] in
 * allowlistedExec.ts stays intact): it shares no table with `ARG_POLICIES` /
 * `isAllowedAnchorCommand`, and it is never an extension of that allowlist.
 * Its timeout/output-capture bounds are sized for a real test suite rather
 * than the anchor runner's 60s / 256 KiB inspection bounds (CDC-019) — a
 * suite-sized command run through the anchor runner's bounds would SIGTERM a
 * healthy suite and misreport it as `timed_out` rather than validated.
 *
 * This module PRODUCES the gate; CP-NODE-7 is the consumer that routes
 * `runtimeCommand.ts`'s spawn through it.
 */

/**
 * Suite-sized wall-clock budget (CDC-019 derivation rule: an order of
 * magnitude above the anchor runner's 60s inspection budget). A real project
 * test suite (install + build + full unit/integration run) routinely takes
 * minutes, not seconds; ten minutes gives a healthy suite generous headroom
 * while still bounding a truly hung process so a dispatch node can't block on
 * it forever.
 */
export const PROJECT_TEST_TIMEOUT_MS = 10 * 60_000;

/** Grace before a timed-out suite is escalated from SIGTERM to SIGKILL. */
export const PROJECT_TEST_SIGKILL_GRACE_MS = 5_000;

/**
 * Suite-sized output cap (CDC-019 derivation rule: an order of magnitude above
 * the anchor runner's 256 KiB inspection cap). A verbose test runner's
 * combined stdout+stderr can be far larger than a short inspection command's;
 * 4 MiB is generous enough that a normal suite is captured in full while still
 * bounding memory against a truly runaway process. Output beyond the cap is
 * TRUNCATED (`truncated: true`, never silently dropped) — see
 * {@link ProjectTestAdmissionOutcome.truncated}.
 */
export const PROJECT_TEST_MAX_CAPTURED_OUTPUT = 4 * 1024 * 1024;

export interface ProjectTestAdmissionOutcome {
  /** False when `command` is not the exact vector discovery emits for `root` — nothing was spawned. */
  admitted: boolean;
  /** Populated only when `admitted` is false. */
  refusal_reason?: string;
  exit_code: number | null;
  timed_out: boolean;
  /**
   * True when captured output hit {@link PROJECT_TEST_MAX_CAPTURED_OUTPUT} and
   * further output was truncated. Distinct from silently stopping capture: a
   * caller can tell "the suite said more than we kept" apart from "the suite
   * said exactly this much."
   */
  truncated: boolean;
  spawn_error?: string;
  /** Full combined stdout+stderr, bounded by the capture cap (see `truncated`). */
  output: string;
}

/**
 * Admit ONLY the exact test command {@link discoverProjectCommands} would
 * return right now for `root` — never a static table, so the repository's own
 * project files are the sole source of truth for what is admitted. Pure and
 * total: no spawn, no throw.
 */
export function isAdmittedProjectTestCommand(command: string[], root: string): boolean {
  const discovered = discoverProjectCommands(root).test;
  if (!discovered || discovered.length === 0) return false;
  if (command.length !== discovered.length) return false;
  return command.every((token, index) => token === discovered[index]);
}

/**
 * Run the repository's discovered test command under the gate. Refuses
 * anything discovery did not emit for `root` (never spawns a refused
 * command); for an admitted command, spawns argv-only (never a shell) with
 * wrapper-only control env stripped (`stripAuditToolsControlEnv`), platform-resolved
 * via the shared `resolveExecArgv`, under suite-sized timeout/capture bounds,
 * killing a hung suite (SIGTERM→SIGKILL) and truncating — never silently
 * dropping — output beyond the capture cap.
 */
export function runAdmittedProjectTestCommand(
  command: string[],
  root: string,
  options: {
    timeoutMs?: number;
    maxCapturedOutput?: number;
    sigkillGraceMs?: number;
  } = {},
): Promise<ProjectTestAdmissionOutcome> {
  if (!isAdmittedProjectTestCommand(command, root)) {
    return Promise.resolve({
      admitted: false,
      refusal_reason: `\`${command.join(" ")}\` is not the test command discoverProjectCommands() emits for this repository; refused.`,
      exit_code: null,
      timed_out: false,
      truncated: false,
      output: "",
    });
  }
  const timeoutMs = options.timeoutMs ?? PROJECT_TEST_TIMEOUT_MS;
  const maxCapturedOutput = options.maxCapturedOutput ?? PROJECT_TEST_MAX_CAPTURED_OUTPUT;
  const sigkillGraceMs = options.sigkillGraceMs ?? PROJECT_TEST_SIGKILL_GRACE_MS;

  return new Promise((resolvePromise) => {
    const [resolvedCommand, ...resolvedArgs] = resolveExecArgv(command);
    const child = spawn(resolvedCommand, resolvedArgs, {
      cwd: root,
      env: stripAuditToolsControlEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let truncated = false;
    const capture = (chunk: unknown): void => {
      if (truncated) return;
      const text = String(chunk);
      const remaining = maxCapturedOutput - output.length;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (text.length > remaining) {
        output += text.slice(0, remaining);
        truncated = true;
      } else {
        output += text;
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const hardKill = setTimeout(() => child.kill("SIGKILL"), sigkillGraceMs);
      hardKill.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        admitted: true,
        exit_code: null,
        timed_out: timedOut,
        truncated,
        spawn_error: error.message,
        output,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ admitted: true, exit_code: code, timed_out: timedOut, truncated, output });
    });
  });
}
