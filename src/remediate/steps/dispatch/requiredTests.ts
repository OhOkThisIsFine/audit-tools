// sites-pinned: tests/remediate/host-handoff-corroboration-required-test-runner.test.ts, tests/remediate/host-handoff-corroboration-obligations.test.ts, tests/remediate/phase-triage.test.ts
import { remediationRequiredTestLogsDir } from "../../../shared/io/auditToolsPaths.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { parseCommandString, runTrackedAsync, writeJsonFile } from "audit-tools/shared";
import type { RemediationHostWorkItem, RemediationHostIngestIssue } from "./hostContracts.js";

/**
 * A required-test rerun that did not pass, CLASSIFIED.
 *
 * Output is diagnostic only: keep a bounded tail without ending a verbose
 * child early. The command's exit, deadline, or startup error decides the verdict.
 */
export interface RequiredTestFailure {
  readonly command: string;
  readonly outcome: "failed" | "timed_out" | "spawn_error";
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Bounded diagnostic tails captured before excerpting. */
  readonly output_log?: string;
  /**
   * The signal that killed the child, when one did and the runner's deadline did
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
const REQUIRED_TEST_TIMEOUT_MS = 10 * 60 * 1_000;

/**
 * Captured output is bounded and TAIL-biased: a failing suite's verdict is at
 * the end, and an unbounded capture would put a whole test log into state and
 * into every rendered issue.
 */
const CAPTURED_OUTPUT_LIMIT = 1_200;

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
const REQUIRED_TEST_TRUNCATION_MARKER =
  "… [excerpt truncated — see required_test_logs in the dispatch step]";

/** Bounded diagnostic retention per stream; unlike maxBuffer, never a kill trigger. */
const REQUIRED_TEST_LOG_TAIL_CHARS = 64 * 1_024;

function tail(value: string | undefined, clipped = false): string {
  const text = value ?? "";
  return text.length <= CAPTURED_OUTPUT_LIMIT
    ? (clipped ? "…" + text : text)
    : `…${text.slice(text.length - CAPTURED_OUTPUT_LIMIT)}`;
}

/**
 * Render one classified failure for a host-facing issue message.
 *
 * A signal-killed child renders the SIGNAL, not `exit null`: `exit_code` is null
 * for every non-exit outcome, so printing it there described nothing.
 */
function describeRequiredTestFailure(failure: RequiredTestFailure): string {
  const head =
    failure.outcome === "timed_out"
      ? `${failure.command} (timed out)`
      : failure.outcome === "spawn_error"
        ? `${failure.command} (could not be started)`
        : failure.exit_code === null
          ? `${failure.command} (terminated by ${failure.signal ?? "an unreported signal"})`
          : `${failure.command} (exit ${String(failure.exit_code)})`;
  const captured = [failure.stdout, failure.stderr]
    .filter((stream) => stream.trim().length > 0)
    .join("\n");
  const excerpt = captured.length > 0 ? `${head}: ${captured}` : head;
  const truncated = failure.stdout.startsWith("…") || failure.stderr.startsWith("…");
  return failure.output_log
    ? `${excerpt} [${truncated ? "excerpt truncated; " : ""}captured output: ${failure.output_log}]`
    : excerpt;
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
  paths: { readonly root: string; readonly artifactsDir: string },
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
    cwd: paths.root,
    // Captured, not discarded: without it a red ingest reports that something
    // failed and nothing about why.
    encoding: "utf8",
    diagnosticTailChars: REQUIRED_TEST_LOG_TAIL_CHARS,
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (!result.error && result.status === 0 && result.signal == null) return null;
  const output_log = join(remediationRequiredTestLogsDir(paths.artifactsDir), `${randomUUID()}.json`);
  // Persist everything the bounded runner captured BEFORE deriving prompt excerpts.
  await writeJsonFile(output_log, {
    command, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
    status: result.status, signal: result.signal ?? null,
    diagnostic_tail_chars: REQUIRED_TEST_LOG_TAIL_CHARS,
    stdout_truncated: result.outputTruncated?.stdout ?? false,
    stderr_truncated: result.outputTruncated?.stderr ?? false,
    error: result.error?.message ?? null,
  });
  const stdout = tail(result.stdout, result.outputTruncated?.stdout);
  const stderr = tail(result.stderr, result.outputTruncated?.stderr);
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT") {
    return { command, output_log, outcome: "timed_out", exit_code: null, stdout, stderr };
  }
  // Killed by something outside this runner (an operator `kill`, an OOM reaper).
  // Reported as FAILED with the signal named: the command did not complete, and
  // calling it a deadline miss would attribute it to a bound this runner set.
  //
  if (result.signal !== null && result.signal !== undefined) {
    return {
      command,
      output_log,
      outcome: "failed",
      exit_code: null,
      stdout,
      stderr,
      signal: result.signal,
    };
  }
  if (result.error) {
    return {
      command,
      output_log,
      outcome: "spawn_error",
      exit_code: null,
      stdout,
      stderr: stderr.length > 0 ? stderr : result.error.message,
    };
  }
  // Every other outcome returned above, so the status is non-zero here.
  return {
    command,
    output_log,
    outcome: "failed",
    exit_code: result.status,
    stdout,
    stderr,
  };
}

export async function rerunRequiredTests(
  paths: Parameters<typeof runRequiredTest>[0],
  commands: readonly string[],
  /** `null` on the normal lane — see {@link RemediationRequiredTestVerdicts}. */
  verdicts: RemediationRequiredTestVerdicts | null,
): Promise<readonly RequiredTestFailure[]> {
  const failures: RequiredTestFailure[] = [];
  for (const command of commands) {
    if (verdicts) {
      const verdict = verdicts.get(requiredTestVerdictKey(paths.root, command));
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
    const failure = await runRequiredTest(paths, command);
    if (failure !== null) failures.push(failure);
  }
  return failures;
}

/**
 * A timeout takes precedence over other failed required tests in the same batch.
 * Diagnostic clipping is not a failure and never changes this issue code.
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
function boundRequiredTestMessage(message: string): string {
  if (message.length <= REQUIRED_TEST_MESSAGE_LIMIT) return message;
  const room = REQUIRED_TEST_MESSAGE_LIMIT - REQUIRED_TEST_TRUNCATION_MARKER.length;
  return `${message.slice(0, room)}${REQUIRED_TEST_TRUNCATION_MARKER}`;
}

/**
 * Pre-computed required-test verdicts, keyed by `root` + command: `null` =
 * green, a {@link RequiredTestFailure} = the classified failure.
 *
 * This is the recovery path's ANSWER TABLE, not a lazy cache. The recovery verb
 * runs every distinct command ONCE, up front and unlocked
 * (`precomputeRecoveryTestVerdicts`), and hands the finished table to the
 * locked phase, which only ever READS it — no required test is spawned while
 * the state lock is held.
 *
 * Two consequences are deliberate. A command absent from the table is treated
 * as FAILED, never spawned — fail-closed is the only answer that keeps the
 * no-spawn-under-the-lock property mechanical rather than remembered. And the
 * table is recovery-only: a `targeted_command` is host-authored and need not be
 * idempotent (one that appends to a log, bumps a counter, or is flaky produces
 * a genuinely different second run), so collapsing spawns is a behavior change.
 * The normal lane passes `null` and every command spawns once per work item.
 */
export type RemediationRequiredTestVerdicts = ReadonlyMap<
  string,
  RequiredTestFailure | null
>;
