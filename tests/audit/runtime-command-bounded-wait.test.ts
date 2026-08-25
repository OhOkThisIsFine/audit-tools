/**
 * CP-NODE-14 (OBL-impl-block-148 inv-1..inv-3, fail-1, fail-2) — runCommand's
 * bounded wait.
 *
 * The defect: `runCommand` resolved only from the child's `error` or `close`
 * events, with no timeout, signal or kill anywhere, and its sole caller awaits
 * it sequentially. One validation command that never exits therefore wedged the
 * whole `advanceAudit` drain forever — not slowly, permanently.
 *
 * Every bound here is passed EXPLICITLY rather than waiting on the real
 * ten-minute default: an outcome reachable only by waiting ten real minutes is
 * an outcome nothing ever tests, which is how a deadline ends up being a
 * deadline in name only.
 */

import { test, expect } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import {
  RUNTIME_COMMAND_TIMEOUT_MS,
  killRuntimeCommandTree,
  runCommand,
} from "../../src/audit/orchestrator/runtimeCommand.js";

/** A command that never exits on its own — the wedge, reproduced. */
const NEVER_EXITS = [process.execPath, "-e", "setInterval(() => {}, 1000)"];

test("the bound is one exported formulation, not a per-call-site number", () => {
  // fail-3's shape: callers consume the stated bound instead of typing their own.
  expect(typeof RUNTIME_COMMAND_TIMEOUT_MS).toBe("number");
  expect(RUNTIME_COMMAND_TIMEOUT_MS > 0).toBe(true);
  expect(Number.isFinite(RUNTIME_COMMAND_TIMEOUT_MS)).toBe(true);
});

test("inv-1: a never-exiting command RESOLVES at the bound instead of pending forever", async () => {
  const started = Date.now();
  const result = await runCommand(NEVER_EXITS, process.cwd(), 1_500);
  const elapsed = Date.now() - started;

  // The assertion that matters is that we got here at all: before the fix this
  // promise never settled and the test would fail by timing out.
  expect(result.status).toBe("not_confirmed");
  expect(
    elapsed < 60_000,
    `resolution must happen at the bound, took ${String(elapsed)}ms`,
  ).toBe(true);
});

test("inv-3: a timeout is distinguishable from an ordinary non-zero exit", async () => {
  const timedOut = await runCommand(NEVER_EXITS, process.cwd(), 1_500);
  const exited = await runCommand(
    [process.execPath, "-e", "process.exit(3)"],
    process.cwd(),
  );

  expect(timedOut.summary).toMatch(/timed out/i);
  // The killed child's own exit code describes OUR kill, so it must not be the
  // reported cause — a caller triaging this must be able to tell a hang from a
  // crash without guessing.
  expect(timedOut.summary).not.toMatch(/exit code/i);

  expect(exited.status).toBe("not_confirmed");
  expect(exited.summary).toMatch(/exit code 3/);
  expect(
    exited.summary,
    "an ordinary failure must never be reported as a timeout",
  ).not.toMatch(/timed out/i);
});

test("inv-4: a successful command is unchanged by the bound", async () => {
  const result = await runCommand(
    [process.execPath, "-e", "console.log('ok')"],
    process.cwd(),
  );
  expect(result.status).toBe("confirmed");
  expect(result.summary).toMatch(/succeeded/);
  expect(result.evidence.join("\n")).toContain("ok");
});

test("fail-1: the deadline is cleared on early exit — no timer outlives the call", async () => {
  // A leaked deadline holds the event loop open past the work it was watching.
  // Measured directly: the count of live timer handles must not grow across a
  // call that finishes well inside its bound.
  const liveTimers = (): number =>
    (process as unknown as { _getActiveHandles: () => { constructor: { name: string } }[] })
      ._getActiveHandles()
      .filter((handle) => handle.constructor.name === "Timeout").length;

  const before = liveTimers();
  await runCommand([process.execPath, "-e", "0"], process.cwd(), 60_000);
  await delay(50);
  expect(
    liveTimers() - before,
    "a deadline left armed after an early exit is a leaked handle",
  ).toBeLessThanOrEqual(0);
});

test("fail-2: win32 reaps the process TREE, other platforms signal the child", () => {
  // The kill path is selected by PLATFORM, and both branches are reachable from
  // either OS so neither is untested on the machine that happens to run CI.
  const killed: (string | undefined)[] = [];
  const fake = {
    pid: 4242,
    kill: (signal?: NodeJS.Signals) => {
      killed.push(signal);
      return true;
    },
  };

  killRuntimeCommandTree(fake, "linux");
  expect(
    killed,
    "with no shell wrapper of our making, the direct signal is the whole story",
  ).toEqual(["SIGTERM"]);

  // On win32 the handle is the cmd.exe wrapper, so signalling it would reap the
  // shell and leave the npm -> node grandchildren alive. The tree reaper is
  // spawned instead, and the child is NOT signalled directly.
  killed.length = 0;
  killRuntimeCommandTree(fake, "win32");
  expect(
    killed,
    "win32 must go through the tree reaper, not a direct signal to the wrapper",
  ).toEqual([]);
});
