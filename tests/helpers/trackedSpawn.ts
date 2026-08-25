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
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnHidden as spawnHiddenUntracked } from "../../src/shared/tooling/exec.js";
import { TEST_RUN_ROOT_ENV } from "./scratch.js";
import { processAlive } from "./suiteLock.js";

/** One file per live child, under the per-invocation run root. */
const LEDGER_DIR_NAME = "spawned-children";

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
