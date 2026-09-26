// sites-pinned: tests/remediate/host-handoff-corroboration.test.ts
import { parseCommandString, runTrackedAsync } from "audit-tools/shared";
import type {
  RemediationHostIngestIssue,
  RemediationHostWorkItem,
} from "./internal.js";

/**
 * Pre-computed required-test verdicts, keyed by `root` + command: `null` =
 * green, a string = the failure detail.
 *
 * This is the recovery path's ANSWER TABLE, not a lazy cache. A required-test
 * rerun is a `spawnSync`, which blocks the event loop for its whole duration —
 * so running one inside the state lock would starve the lock's own heartbeat
 * timer and let a second acquirer reclaim the lock as stale mid-hold. The
 * recovery verb therefore runs every distinct command ONCE, up front and
 * unlocked, and hands the finished table to the locked phase, which only ever READS it.
 *
 * Two consequences are deliberate. A command absent from the table is treated
 * as FAILED, never spawned — fail-closed is the only answer that keeps the
 * no-spawn-under-the-lock property mechanical rather than remembered. And the
 * table is recovery-only: a `targeted_command` is host-authored and need not be
 * idempotent (one that appends to a log, bumps a counter, or is flaky produces
 * a genuinely different second run), so collapsing spawns is a behavior change.
 * The normal lane passes `null` and stays byte-identical to the pre-recovery
 * behavior — every command spawns once per work item, exactly as before.
 */
export type RemediationRequiredTestVerdicts = ReadonlyMap<
  string,
  RequiredTestFailure | null
>;

/**
 * A required-test rerun that did not pass, CLASSIFIED.
 *
 * `outcome` is the whole point. A suite that exceeded its deadline, a suite that
 * outran the capture buffer, and a suite that returned non-zero are different
 * facts — the first two are environment signals, only the last is the work being
 * wrong — and they used to arrive as one joined string (`"<cmd> (exit 1)"` /
 * `"<cmd> (ETIMEDOUT)"`) that a caller could only tell apart by parsing prose.
 * Output was not captured at all (`stdio: "ignore"`), so an operator staring at
 * a red ingest had nothing to read.
 *
 * `output_overflow` is separate from `timed_out` because node kills BOTH an
 * over-deadline and an over-`maxBuffer` child with a signal: a discriminator
 * that read `signal !== null` as "the deadline fired" reported a command that
 * was running fine and merely verbose as a hang. `output_overflow` does
 * NOT claim the tests were fine — see {@link describeRequiredTestFailure}; the
 * verdict is simply unknown, because a child killed mid-stream may equally have
 * been on its way to exit 3.
 */
export interface RequiredTestFailure {
  readonly command: string;
  readonly outcome: "failed" | "timed_out" | "output_overflow" | "spawn_error";
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * The signal that killed the child, when one did and the runner's own caps did
   * not (an operator `kill`, an OOM reaper). Absent on every other outcome —
   * there is no signal to report — which is why it is optional rather than
   * `string | null`: a caller that reads it gets a name or nothing, never a
   * placeholder to special-case.
   */
  readonly signal?: string;
}

/**
 * Per-command deadline. A required test is host-authored and may legitimately be
 * a full suite, so the bound is generous; what changed is that hitting it is now
 * a NAMED outcome instead of an unlabelled failure string.
 */
export const REQUIRED_TEST_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Captured output is bounded and TAIL-biased: a failing suite's verdict is at
 * the end, and an unbounded capture would put a whole test log into state and
 * into every rendered issue.
 */
export const CAPTURED_OUTPUT_LIMIT = 4_000;

/**
 * The bound on the MESSAGE a required-test failure produces.
 *
 * `CAPTURED_OUTPUT_LIMIT` bounds one STREAM; the message is a different thing —
 * `requiredTestIssue` joins every failing command, and a work item may bind any
 * number of them, so the rendered message grew with the number of failures. A
 * message is a HOST-FACING delivery (it is rendered into the step prompt an
 * operator reads), so its size cannot be a function of how many commands
 * happened to fail.
 *
 * The bound TRUNCATES the excerpt and says so; it never drops the verdict. What
 * survives at the front is the part that identifies the failure — the command
 * and its outcome — and the marker tells the operator the rest was elided and
 * where to look instead.
 */
export const REQUIRED_TEST_MESSAGE_LIMIT = 8_000;

/** The marker that names an elided excerpt, so truncation is never silent. */
export const REQUIRED_TEST_TRUNCATION_MARKER =
  "… [excerpt truncated — re-run the command to see the full output]";

/**
 * The spawn's raw capture buffer. Exceeding it does not truncate — node KILLS
 * the child — so the cap is a named constant the `output_overflow` message can
 * quote, rather than a literal buried in the spawn options.
 */
export const REQUIRED_TEST_MAX_BUFFER_BYTES = 8 * 1_024 * 1_024;

export function tail(value: string | undefined): string {
  const text = value ?? "";
  return text.length <= CAPTURED_OUTPUT_LIMIT
    ? text
    : `…${text.slice(text.length - CAPTURED_OUTPUT_LIMIT)}`;
}

/**
 * Render one classified failure for a host-facing issue message.
 *
 * `output_overflow` says the verdict is UNKNOWN, not that the tests were fine: a
 * child killed at the buffer cap may have been heading for exit 0 or exit 3, and
 * the runner cannot tell which. Either way the item is refused — the honest
 * report is "we could not find out", and it fails closed.
 *
 * A signal-killed child renders the SIGNAL, not `exit null`: `exit_code` is null
 * for every non-exit outcome, so printing it there described nothing.
 */
export function describeRequiredTestFailure(failure: RequiredTestFailure): string {
  const head =
    failure.outcome === "timed_out"
      ? `${failure.command} (timed out)`
      : failure.outcome === "output_overflow"
        ? `${failure.command} (killed after exceeding the ${String(REQUIRED_TEST_MAX_BUFFER_BYTES)}-byte ` +
          "output buffer — the run ended at the capture cap, so whether the tests pass is UNKNOWN)"
        : failure.outcome === "spawn_error"
          ? `${failure.command} (could not be started)`
          : failure.exit_code === null
            ? `${failure.command} (terminated by ${failure.signal ?? "an unreported signal"})`
            : `${failure.command} (exit ${String(failure.exit_code)})`;
  const captured = [failure.stdout, failure.stderr]
    .filter((stream) => stream.trim().length > 0)
    .join("\n");
  return captured.length > 0 ? `${head}: ${captured}` : head;
}

/**
 * Length-prefixed so the root/command boundary is unambiguous for any path, and
 * printable so the source stays text (a raw separator byte would make the file
 * binary to git and invisible to grep). The root is part of the key because a
 * verdict is a fact about one command in one working tree, and nothing
 * guarantees a single process only ever ingests for one root.
 */
export function requiredTestVerdictKey(root: string, command: string): string {
  return `${String(root.length)}:${root}:${command}`;
}

/**
 * The ONE place a required-test command is spawned.
 *
 * `timeoutMs` is a parameter so the deadline is exercisable: a hang is a
 * first-class outcome of this function, and an outcome that can only be reached
 * by waiting ten real minutes is an outcome nothing ever tests.
 */
export async function runRequiredTest(
  root: string,
  command: string,
  timeoutMs: number = REQUIRED_TEST_TIMEOUT_MS,
): Promise<RequiredTestFailure | null> {
  // AWAITED, never `spawnSync`: ingestion runs with the remediation state lock
  // held, and a synchronous child blocks the event loop for the whole suite —
  // starving the lock's mtime heartbeat until a LIVE lock is classified stale
  // and stolen mid-ingest.
  //
  // argv + `shell: false`, never a shell string. A required test is a workload
  // command that already cleared the declared-shape gate at the producer, so
  // splitting it is unambiguous, and dropping the shell removes the last place
  // an ingest hands a declared string to `sh`/`cmd.exe`. `resolveExecArgv`
  // inside the runner is what keeps the npm/npx shims resolvable on win32.
  const result = await runTrackedAsync(parseCommandString(command), {
    cwd: root,
    // Captured, not discarded: without it a red ingest reports that something
    // failed and nothing about why.
    encoding: "utf8",
    maxBuffer: REQUIRED_TEST_MAX_BUFFER_BYTES,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const stdout = tail(result.stdout);
  const stderr = tail(result.stderr);
  // The ERROR CODE discriminates, never `signal`. node kills an over-deadline
  // child AND an over-`maxBuffer` child, and an external `kill` sets `signal`
  // too — so `signal !== null` was true for three unrelated facts and reported
  // all of them as a hang, including a command killed purely for printing more
  // than the buffer holds.
  //
  // ASSUMPTION, stated: a deadline miss reports `ETIMEDOUT`. Verified on win32;
  // it is node's documented contract, not a platform quirk this code confirmed
  // everywhere. On a platform that killed a child at the deadline WITHOUT that
  // code, the case degrades to `spawn_error` — a less specific refusal, still a
  // refusal, so the fail direction holds and only the label is lost.
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") {
    return { command, outcome: "timed_out", exit_code: null, stdout, stderr };
  }
  if (code === "ENOBUFS") {
    return {
      command,
      outcome: "output_overflow",
      exit_code: null,
      stdout,
      stderr,
    };
  }
  if (result.error) {
    return {
      command,
      outcome: "spawn_error",
      exit_code: null,
      stdout,
      stderr: stderr.length > 0 ? stderr : result.error.message,
    };
  }
  // Killed by something outside this runner (an operator `kill`, an OOM reaper).
  // Reported as FAILED with the signal named: the command did not complete, and
  // calling it a deadline miss would attribute it to a bound this runner set.
  //
  // POSIX-ONLY IN PRACTICE, and UNTESTED for that reason: Windows has no signal
  // delivery to report here — a killed child surfaces as an ordinary non-zero
  // `status` with `signal` null — so this branch is unreachable on the platform
  // this repo runs its suites on, and no test exercises it. It is kept because
  // the runner is OS-agnostic by contract, not because it has been observed.
  if (result.signal !== null && result.signal !== undefined) {
    return {
      command,
      outcome: "failed",
      exit_code: null,
      stdout,
      stderr,
      signal: result.signal,
    };
  }
  if (result.status !== 0) {
    return {
      command,
      outcome: "failed",
      exit_code: result.status,
      stdout,
      stderr,
    };
  }
  return null;
}

export async function rerunRequiredTests(
  root: string,
  commands: readonly string[],
  /** `null` on the normal lane — see {@link RemediationRequiredTestVerdicts}. */
  verdicts: RemediationRequiredTestVerdicts | null,
): Promise<readonly RequiredTestFailure[]> {
  const failures: RequiredTestFailure[] = [];
  for (const command of commands) {
    if (verdicts) {
      const verdict = verdicts.get(requiredTestVerdictKey(root, command));
      if (verdict === undefined) {
        failures.push({
          command,
          outcome: "spawn_error",
          exit_code: null,
          stdout: "",
          stderr:
            "no pre-computed verdict — refusing to spawn a test while the state lock is held",
        });
      } else if (verdict !== null) {
        failures.push(verdict);
      }
      continue;
    }
    const failure = await runRequiredTest(root, command);
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

/**
 * The classified issue for a set of required-test failures. An ENVIRONMENT fact
 * anywhere in the set wins over a red sibling, timeout first: a hung or
 * buffer-killed suite is the fact that explains the ingest, and burying it under
 * a sibling's exit code is exactly the conflation the code split exists to end.
 * Only a set where every failure is a genuine non-zero exit reads as
 * `required_test_failed`.
 */
export function requiredTestIssue(
  workItem: RemediationHostWorkItem,
  failures: readonly RequiredTestFailure[],
): RemediationHostIngestIssue {
  // Bounded at the point the message is BUILT, not left to the caller: the
  // failure count is a property of the work item's bound commands, so bounding
  // anywhere downstream would still have carried an unbounded string through
  // state and into the ledger. See REQUIRED_TEST_MESSAGE_LIMIT.
  const body = `mechanical required-test rerun failed: ${failures
    .map(describeRequiredTestFailure)
    .join("; ")}`;
  return {
    code: failures.some((failure) => failure.outcome === "timed_out")
      ? "required_test_timed_out"
      : failures.some((failure) => failure.outcome === "output_overflow")
        ? "required_test_output_overflow"
        : "required_test_failed",
    check: "required_tests",
    work_item_id: workItem.id,
    result_path: workItem.result_path,
    message: boundRequiredTestMessage(body),
  };
}

/**
 * Truncate a required-test failure message to {@link REQUIRED_TEST_MESSAGE_LIMIT},
 * marking the elision. The head is kept because it is what identifies the
 * failure — the command and its classified outcome — and the marker replaces
 * the tail rather than being appended past the cap, so the result is bounded by
 * construction.
 */
export function boundRequiredTestMessage(message: string): string {
  if (message.length <= REQUIRED_TEST_MESSAGE_LIMIT) return message;
  const room = REQUIRED_TEST_MESSAGE_LIMIT - REQUIRED_TEST_TRUNCATION_MARKER.length;
  return `${message.slice(0, room)}${REQUIRED_TEST_TRUNCATION_MARKER}`;
}
