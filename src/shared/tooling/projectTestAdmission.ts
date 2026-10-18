// sites-pinned: tests/remediate/landing-gates-close.test.ts
//   The `landing-gate` role addition (admit a command only when discovery emits
//   it, same spawn path as test/e2e) is pinned by the landing-gate close suite,
//   which drives the leg through this runner.
import { beginOwnedProcessTermination, OWNED_PROCESS_DRAIN_GRACE_MS, spawnOwnedProcess } from "./ownedProcessLifecycle.js";
import { discoverProjectCommands } from "./testCommand.js";
import { discoverLandingGates } from "./landingGates.js";
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
 * Admit ONLY a command {@link discoverProjectCommands} /
 * {@link discoverLandingGates} would return right now for `root` — never a
 * static table, so the repository's own project files are the sole source of
 * truth for what is admitted. Pure and total: no spawn, no throw.
 *
 * `landing-gate` is the one role with MORE than one admitted command (a repo
 * declares up to five gate scripts), so it admits by SET MEMBERSHIP rather than
 * by matching one vector. The rule is otherwise identical, and it is why a gate
 * command is never shell-interpolated from a caller's string: only a command
 * discovery itself emitted can be spawned, so the admission surface is exactly
 * the repository's own declared script names.
 */
function isAdmittedProjectCommand(
  command: string[],
  root: string,
  role: "test" | "e2e" | "landing-gate",
): boolean {
  if (role === "landing-gate") {
    return discoverLandingGates(root).includes(command.join(" "));
  }
  const discovered = discoverProjectCommands(root)[role];
  if (!discovered || discovered.length === 0) return false;
  if (command.length !== discovered.length) return false;
  return command.every((token, index) => token === discovered[index]);
}

export function isAdmittedProjectTestCommand(command: string[], root: string): boolean {
  return isAdmittedProjectCommand(command, root, "test");
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
function runAdmittedProjectCommand(
  command: string[],
  root: string,
  options: {
    timeoutMs?: number;
    maxCapturedOutput?: number;
    sigkillGraceMs?: number;
  } = {},
  role: "test" | "e2e" | "landing-gate" = "test",
): Promise<ProjectTestAdmissionOutcome> {
  if (!isAdmittedProjectCommand(command, root, role)) {
    return Promise.resolve({
      admitted: false,
      refusal_reason: `\`${command.join(" ")}\` is not the ${role} command discoverProjectCommands() emits for this repository; refused.`,
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
    let owned: ReturnType<typeof spawnOwnedProcess>;
    try {
      owned = spawnOwnedProcess(resolveExecArgv(command), {
        cwd: root,
        env: stripAuditToolsControlEnv(),
        deadlineAt: Date.now() + timeoutMs,
      });
    } catch (error) {
      resolvePromise({ admitted: true, exit_code: null, timed_out: false,
        truncated: false, output: "", spawn_error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const child = owned.child;
    let output = "";
    let truncated = false;
    let settled = false;
    const capture = (chunk: unknown): void => {
      if (settled || truncated) return;
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
    let cancelTermination: (() => void) | undefined;
    const settle = (spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelTermination?.();
      // In particular, terminal fallback must not leave inherited capture pipes
      // or a Windows Job owner alive after its promise has resolved.
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      owned.release();
      const signal = owned.rootSignal();
      const error = spawnError ?? (timedOut
        ? `the command exceeded its ${String(timeoutMs)}ms deadline`
        : signal !== null ? `command terminated by signal ${signal}` : undefined);
      resolvePromise({ admitted: true, exit_code: owned.rootStatus(), timed_out: timedOut,
        truncated, output, ...(error ? { spawn_error: error } : {}) });
    };

    // Deadline cleanup owns the group/Job, including descendants after npm or
    // its shell exits. Keep referenced clocks through TERM grace and bounded
    // drain: neither root exit nor closed pipes proves the scope is empty.
    const timer = setTimeout(() => {
      timedOut = true;
      cancelTermination = beginOwnedProcessTermination(owned, () => {}, () => {
        settle(`the command exceeded its ${String(timeoutMs)}ms deadline; ` +
          `owned process cleanup reached its ${String(sigkillGraceMs)}ms SIGTERM grace ` +
          `and ${String(OWNED_PROCESS_DRAIN_GRACE_MS)}ms drain limit`);
      }, sigkillGraceMs);
      // A synchronous close/error during termination may already have settled.
      if (settled) cancelTermination();
    }, timeoutMs);
    child.on("error", (error) => {
      if (settled) return;
      if ((error as NodeJS.ErrnoException).code === "ETIMEDOUT") timedOut = true;
      owned.terminate("SIGKILL");
      settle(error.message);
    });
    child.on("close", () => {
      if (settled) return;
      if (timedOut && !owned.cleanup(false).cleanup_verified) return;
      // The Windows child's code is the Job helper's code, not the target's.
      // Missing root_exit must never turn an owner failure into a successful test.
      settle(owned.rootExited() ? undefined : "process owner closed without reporting the command exit");
    });
    child.stdin.on("error", () => { /* a command may close its input immediately */ });
    child.stdin.end();
  });
}

export function runAdmittedProjectTestCommand(
  command: string[],
  root: string,
  options: {
    timeoutMs?: number;
    maxCapturedOutput?: number;
    sigkillGraceMs?: number;
  } = {},
): Promise<ProjectTestAdmissionOutcome> {
  return runAdmittedProjectCommand(command, root, options, "test");
}

export function runAdmittedProjectE2eCommand(
  command: string[],
  root: string,
  options: {
    timeoutMs?: number;
    maxCapturedOutput?: number;
    sigkillGraceMs?: number;
  } = {},
): Promise<ProjectTestAdmissionOutcome> {
  return runAdmittedProjectCommand(command, root, options, "e2e");
}

/**
 * Run one of the repository's discovered LANDING GATES under the same gate.
 *
 * The landing-gate leg runs at the CLOSE, on the merged tree — see
 * `verifyLandingGates` in `src/remediate/phases/closeVerifyLandingGates.ts`. It
 * is a different role from test/e2e only in what discovery emits: one vector
 * for those, a set of up to five gate commands for this. The admission rule and
 * every spawn bound are the SAME, which is the point — a gate is a discovered
 * project command like any other, and adding a second spawn path for it would
 * be a second place for the shell-safety and output-cap rules to drift.
 */
export function runAdmittedProjectLandingGateCommand(
  command: string[],
  root: string,
  options: {
    timeoutMs?: number;
    maxCapturedOutput?: number;
    sigkillGraceMs?: number;
  } = {},
): Promise<ProjectTestAdmissionOutcome> {
  return runAdmittedProjectCommand(command, root, options, "landing-gate");
}
