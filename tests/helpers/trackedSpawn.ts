/**
 * The suite's ASYNC spawn surface, with every child recorded until it exits.
 *
 * WHY A LEDGER. A test that spawns a child and neither awaits nor kills it
 * leaves the child running past its own test, past the suite, and past vitest's
 * exit — a straggler that then writes into the checkout minutes later, when
 * nothing is watching and every clean-tree check has already passed. The
 * observed artifacts are empty files named from repo text (`o.testId)`, `60s`),
 * which look like a suite defect and are not attributable to any test by the
 * time anyone sees them.
 *
 * The ledger closes that attribution gap at the only moment the information
 * still exists: each async spawn writes `<run-root>/spawned-children/<pid>`
 * holding its command, and deletes it on `exit`. Whatever is still there — and
 * still ALIVE — when the run ends is a child that outlived it, named.
 *
 * REACH, stated: only spawns that go through this module are recorded, which is
 * the whole test tree by INV-WH (`tests/shared/shared-tests-invariants.test.mjs`
 * fails a test file that imports a raw `node:child_process` entry point). SYNC
 * spawns are deliberately untracked — `spawnSync` has already reaped its child
 * before it returns, so it cannot produce a straggler. What it CAN leave is a
 * grandchild it never owned: `shell: true` on win32 makes `cmd.exe` the child,
 * and killing cmd.exe does not kill what cmd.exe started.
 *
 * PID REUSE, stated: liveness is `process.kill(pid, 0)`, the same probe
 * `suiteLock.ts` uses for lock holders, and it cannot tell a recycled pid from
 * the original. A stale entry is cleaned the first time it reads as dead, so
 * the window is small, but a report is a lead to read, not a proof.
 */
import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileOptions,
  type SpawnOptions,
} from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  spawnHidden as spawnHiddenUntracked,
  spawnSyncHidden as spawnSyncHiddenUntracked,
} from "../../src/shared/tooling/exec.js";
import { TEST_RUN_ROOT_ENV } from "./scratch.js";
import { processAlive } from "./suiteLock.js";

/** One file per live child, under the per-invocation run root. */
const LEDGER_DIR_NAME = "spawned-children";

/**
 * The BLOCKING-BUDGET ledger: one JSON line per synchronous spawn, under the
 * per-invocation run root.
 *
 * A sync spawn blocks this worker's event loop for its whole run. Vitest's
 * worker RPC, the pool's heartbeats and every `setTimeout` in the worker are all
 * starved for that window — the mechanism behind the "vitest worker RPC
 * starvation" entry, whose false-RED exit the gate already tolerates but whose
 * >60s blocking worker was never located. A stack sample was never available;
 * the DURATION is, and it is the actual quantity of interest.
 *
 * So the assertion is derived from measurement instead of a review: every sync
 * spawn records (file, command, ms), and a contract test fails when any single
 * one blocks for ≥ {@link SYNC_BLOCK_BUDGET_MS}. That is the *Durable traps are
 * MECHANICALLY enforced* shape — the property is a fact about the tree's
 * runtime, so a test is what binds it, and no future contributor has to
 * remember that some checker got slow.
 *
 * Best-effort by construction, exactly like the child ledger: a write that fails
 * must never fail the spawn it is describing.
 */
const SYNC_LEDGER_FILE_NAME = "sync-spawns.ndjson";

/**
 * The ceiling a single synchronous spawn may block its worker for.
 *
 * 60s is the number the tracking entry already states as the threshold of
 * interest, so the gate and the claim agree. It is far above every measured
 * value — the slowest synchronous checker in this tree is a doc gate at under a
 * second — so it fires on a REGRESSION (a checker that acquired a network call
 * or a full-tree walk), never on ordinary variance under load.
 */
export const SYNC_BLOCK_BUDGET_MS = 60_000;

/** One recorded synchronous spawn. */
export interface SyncSpawnRecord {
  file: string;
  command: string;
  ms: number;
}

/**
 * The ledger's home, or `null` when this process is not inside a run (a helper
 * imported by a script, or a worker started before globalSetup published the
 * root). No run root means no ledger and no tracking — never an invented one.
 */
function ledgerDir(): string | null {
  const runRoot = process.env[TEST_RUN_ROOT_ENV];
  return runRoot ? join(runRoot, LEDGER_DIR_NAME) : null;
}

function renderCommand(command: string, args?: readonly string[]): string {
  return [command, ...(args ?? [])].join(" ");
}

/**
 * Record `child` until it exits. Best-effort by construction: a ledger write
 * that fails must never fail the spawn it is describing.
 */
export function trackChild(child: ChildProcess, command: string): void {
  const dir = ledgerDir();
  if (dir === null || typeof child.pid !== "number") return;
  const entry = join(dir, String(child.pid));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(entry, command, "utf8");
  } catch {
    return;
  }
  const clear = (): void => {
    try {
      rmSync(entry, { force: true });
    } catch {
      // The run root is removed wholesale at teardown; a failed unlink here
      // costs a liveness probe, not correctness.
    }
  };
  child.once("exit", clear);
  child.once("error", clear);
}

/** A child that was still running when someone asked. */
export interface LiveChild {
  pid: number;
  command: string;
}

/** Where the sync-spawn ledger lives, or `null` outside a run. */
function syncLedgerPath(): string | null {
  const runRoot = process.env[TEST_RUN_ROOT_ENV];
  return runRoot ? join(runRoot, SYNC_LEDGER_FILE_NAME) : null;
}

/**
 * A `.test.*` path appearing in a stack line, normalized to forward slashes and
 * stripped of the trailing `:line:col`.
 *
 * Two shapes have to survive: `at fn (C:\…\tests\shared\x.test.ts:12:3)` and the
 * bare `at C:/…/tests/shared/x.test.ts:12:3`. The drive letter is optional and
 * both separators are admitted, because this runs on every platform the suite
 * does.
 */
const TEST_FILE_FRAME = /((?:[A-Za-z]:)?[^()\s]*[\\/]tests[\\/][^()\s]*\.test\.(?:ts|mjs))(?::\d+:\d+)?/u;

/**
 * Which test file reached this helper.
 *
 * Read from the CALL STACK rather than from a test framework's global state.
 * `expect.getState()` would be vitest's own answer, but `globals` is not enabled
 * in this repo's vitest config, so the global is absent — and importing vitest
 * into this module would make a general spawn helper depend on the test runner
 * that happens to be loading it. The stack is the one attribution source every
 * host of this module already has.
 *
 * The fallback NAMES the miss instead of inventing a file, so a row that could
 * not be attributed reads as unattributed rather than as some other test's.
 */
export function currentTestFile(stack?: string): string {
  let text = stack;
  if (text === undefined) {
    const previous = Error.stackTraceLimit;
    // Six frames is enough to clear this module and the wrapped helper; an
    // unbounded capture in a hot path is its own cost.
    Error.stackTraceLimit = 6;
    text = new Error().stack ?? "";
    Error.stackTraceLimit = previous;
  }
  for (const line of text.split("\n")) {
    const match = TEST_FILE_FRAME.exec(line);
    if (match) return match[1]!.replace(/\\/g, "/");
  }
  return "(unknown test file)";
}

/** Record one synchronous spawn's blocking duration. Never throws. */
function recordSyncSpawn(command: string, args: readonly string[] | undefined, ms: number): void {
  const path = syncLedgerPath();
  if (path === null) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ file: currentTestFile(), command: renderCommand(command, args), ms })}\n`,
      "utf8",
    );
  } catch {
    // The run root is removed wholesale at teardown; a failed append costs one
    // measurement, never the spawn it was measuring.
  }
}

/** Every synchronous spawn this run recorded, in the order it recorded them. */
export function readSyncSpawns(): SyncSpawnRecord[] {
  const path = syncLedgerPath();
  if (path === null) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const records: SyncSpawnRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as SyncSpawnRecord;
      if (typeof parsed?.ms === "number") records.push(parsed);
    } catch {
      // A torn final line from a worker killed mid-append: skip it, never throw.
    }
  }
  return records;
}

/**
 * The synchronous spawns that exceeded {@link SYNC_BLOCK_BUDGET_MS}, worst first.
 *
 * Exported so the contract test and the teardown report read the same predicate
 * — a second threshold spelled at a second site is how a budget stops being one.
 */
export function syncSpawnsOverBudget(
  records: readonly SyncSpawnRecord[] = readSyncSpawns(),
  budgetMs: number = SYNC_BLOCK_BUDGET_MS,
): SyncSpawnRecord[] {
  return records.filter((record) => record.ms >= budgetMs).sort((a, b) => b.ms - a.ms);
}

/**
 * The tracked children still alive, cleaning out the entries that are not.
 *
 * Reads the ledger rather than a process table: "did THIS run spawn it" is a
 * question only the ledger can answer, and a straggler's parent is usually a
 * worker that has already exited, so no ancestry walk reaches it.
 */
export function liveTrackedChildren(): LiveChild[] {
  const dir = ledgerDir();
  if (dir === null) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const live: LiveChild[] = [];
  for (const entry of entries) {
    const pid = Number(entry);
    const path = join(dir, entry);
    if (!Number.isInteger(pid) || !processAlive(pid)) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Nothing to do; the entry reads as dead on the next pass too.
      }
      continue;
    }
    let command = "";
    try {
      command = readFileSync(path, "utf8");
    } catch {
      command = "(command unrecorded)";
    }
    live.push({ pid, command });
  }
  return live.sort((a, b) => a.pid - b.pid);
}

/**
 * Poll until no tracked child is alive, or the deadline passes.
 *
 * The grace window exists because a child killed in the last moments of a test
 * is still in the process table for a few milliseconds, and a guard that reads
 * that as a leak is a false RED — as corrosive as a false green, and far more
 * likely to get the guard disabled. Paid only when something is actually alive.
 */
export async function settleTrackedChildren(deadlineMs = 2_000): Promise<LiveChild[]> {
  const started = Date.now();
  let live = liveTrackedChildren();
  while (live.length > 0 && Date.now() - started < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    live = liveTrackedChildren();
  }
  return live;
}

// The base helpers, seen through ONE plain signature each. Both are declared
// with node's full overload set, and a wrapper cannot re-satisfy an overload set
// it forwards through — so each is narrowed here and the wrapper is republished
// with the original type, exactly as `src/shared/tooling/exec.ts` does.
const spawnBase = spawnHiddenUntracked as unknown as (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

const execFileBase = execFile as unknown as (
  command: string,
  args?: readonly string[],
  options?: ExecFileOptions,
  callback?: unknown,
) => ChildProcess;

/**
 * `spawnHidden` (the windowless spawn every test uses) with the child recorded.
 * Signature and overload set are the base helper's; see `tests/helpers/spawn.mjs`
 * for the INV-WH rationale behind routing every test spawn through one place.
 */
export const spawnHidden = ((
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
) => {
  const child = spawnBase(command, args, options);
  trackChild(child, renderCommand(command, args));
  return child;
}) as unknown as typeof spawn;

const spawnSyncBase = spawnSyncHiddenUntracked as unknown as (
  command: string,
  args?: readonly string[],
  options?: Record<string, unknown>,
) => { status: number | null; signal: string | null; error?: Error };

/**
 * `spawnSyncHidden` (the windowless SYNC spawn) with its blocking duration
 * recorded in the run's ledger.
 *
 * The measurement is the whole point: a sync spawn holds this worker's event
 * loop for its entire run, and the failure it produces downstream — a starved
 * worker RPC, a `setTimeout` that never fires, a test that reads as "flaky" —
 * names none of that. Recording `(file, command, ms)` at the call turns "some
 * worker blocked somewhere for a long time" into a row naming the command.
 * `tests/shared/sync-spawn-budget.test.ts` is the gate over the record.
 *
 * Signature and overload set are the base helper's, republished exactly as
 * `spawnHidden` above does.
 */
export const spawnSyncHidden = ((
  command: string,
  args?: readonly string[],
  options?: Record<string, unknown>,
) => {
  const started = Date.now();
  try {
    return spawnSyncBase(command, args, options);
  } finally {
    // In `finally` so a spawn that THROWS still records: a command that blocks
    // for a minute and then fails is exactly the case worth naming.
    recordSyncSpawn(command, args, Date.now() - started);
  }
}) as unknown as typeof spawnSyncHiddenUntracked;

/**
 * `child_process.execFile` with `windowsHide` forced on and the child recorded.
 * Arity matches the `(file, args, options, callback)` form so
 * `promisify(execFileHidden)` works.
 */
export const execFileHidden = ((
  command: string,
  args?: readonly string[],
  options?: ExecFileOptions,
  callback?: unknown,
) => {
  const child = execFileBase(command, args, { ...(options ?? {}), windowsHide: true }, callback);
  trackChild(child, renderCommand(command, args));
  return child;
}) as unknown as typeof execFile;

/**
 * Per-CLI-call deadline for an orchestration test driving the real wrapper.
 *
 * The CI orchestration shard's failure mode is a `next-step` that WEDGES — the
 * 300s test ceiling fires on a different test each run, and what it leaves
 * behind is a still-running `audit-code` child. Vitest aborting a test does not
 * kill that child, so the run's own teardown is what names it, long after the
 * test report stopped saying anything useful.
 *
 * One formulation, exported, so no call site types its own number and every
 * walk shares the same bound. It sits far below the 300s test ceiling so the
 * CALL fails first, naming the command and the pause it was in — the test
 * ceiling can then only be reached by a walk that is genuinely doing work.
 */
export const CLI_CALL_DEADLINE_MS = 120_000;

export interface BoundedRunResult {
  stdout: string;
  stderr: string;
}

export interface BoundedRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Overrides {@link CLI_CALL_DEADLINE_MS}; tests that prove the bound pass a small one. */
  timeoutMs?: number;
  /** Deadline for the SIGTERM→SIGKILL escalation before the report is written. */
  killGraceMs?: number;
}

/**
 * Spawn `command`, collect its output, and fail at a DEADLINE that names what
 * was waited on.
 *
 * `runTrackedAsync` in production already has this shape (`TRACKED_CHILD_DEADLINE_MS`,
 * SIGTERM→SIGKILL). The test tree did not: `runWrapper` resolved only from the
 * child's `exit` event, so a wedged CLI left the promise pending forever and the
 * failure surfaced as a test-ceiling abort with the child still alive — a red
 * that names the test, never the command, and leaks the process.
 *
 * The rejection is built to answer the question a reader actually has: WHICH
 * command, how long, and what it had said so far. That is the difference between
 * this and a bare test timeout.
 */
export function runBounded(
  command: string,
  args: readonly string[],
  options: BoundedRunOptions = {},
): Promise<BoundedRunResult> {
  const timeoutMs = options.timeoutMs ?? CLI_CALL_DEADLINE_MS;
  const killGraceMs = options.killGraceMs ?? 2_000;
  const rendered = renderCommand(command, args);
  return new Promise<BoundedRunResult>((resolve, reject) => {
    const child = spawnHidden(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation !== undefined) clearTimeout(escalation);
      if (error) reject(error);
      else resolve({ stdout, stderr });
    };

    const deadline = setTimeout(() => {
      // SIGTERM, then SIGKILL: an ordinary child flushes and exits, and one that
      // ignores SIGTERM cannot hold the run open past the grace window.
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      escalation.unref?.();
      finish(
        new Error(
          `\`${rendered}\` did not exit within ${String(timeoutMs)}ms — it was still running ` +
            `when the deadline fired (pid ${String(child.pid)}). SIGTERM sent, SIGKILL after ` +
            `${String(killGraceMs)}ms. This is the wedge, reported at the command that caused ` +
            `it rather than as a test-ceiling abort:\n` +
            `--- stderr so far ---\n${stderr}\n--- stdout so far ---\n${stdout}`,
        ),
      );
    }, timeoutMs);

    child.on("error", (error) =>
      finish(
        new Error(`\`${rendered}\` failed to spawn after ${String(timeoutMs)}ms bound: ${error.message}`),
      ),
    );
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        finish(null);
        return;
      }
      finish(
        new Error(
          `\`${rendered}\` exited ${code === null ? `on signal ${String(signal)}` : `with ${String(code)}`}:\n` +
            `${stderr || stdout}`,
        ),
      );
    });
  });
}
