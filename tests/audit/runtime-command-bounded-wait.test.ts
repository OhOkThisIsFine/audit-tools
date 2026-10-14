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
import { spawnSyncHidden as spawnSync } from "../helpers/spawn.mjs";
import { fileURLToPath } from "node:url";
import {
  RUNTIME_COMMAND_TIMEOUT_MS,
  killRuntimeCommandTree,
  runCommand,
  type RuntimeCommandProcessControl,
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

test("fail-1: an early-exit fixture actually exits after its deadline is cleared", () => {
  const runtimeUrl = new URL("../../dist/audit/orchestrator/runtimeCommand.js", import.meta.url).href;
  const fixture = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { runCommand } from ${JSON.stringify(runtimeUrl)};
    const result = await runCommand([process.execPath, "-e", "0"], process.cwd(), 60_000);
    if (result.status !== "confirmed") throw new Error(JSON.stringify(result));
  `], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env },
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
  });
  // Observes this fixture process exiting, rather than undocumented timer
  // handles. This proves early-exit timer cleanup, not timeout tree cleanup.
  expect(fixture.error, "fixture process must exit before the external watchdog").toBeUndefined();
  expect(fixture.signal, fixture.stderr).toBeNull();
  expect(fixture.status, fixture.stderr).toBe(0);
});

test("fail-2: injected process control requests platform operations without OS lookup", () => {
  const identity = Symbol("synthetic-process-identity");
  const fake = {
    identity,
    kill: (): boolean => { throw new Error("synthetic identity reached native kill"); },
  };
  const operations: unknown[][] = [];
  const control: RuntimeCommandProcessControl = {
    terminateWindowsTree: child => { operations.push(["tree", child]); },
    signalChild: (child, signal) => { operations.push(["signal", child, signal]); },
  };
  expect("pid" in fake).toBe(false);
  killRuntimeCommandTree(fake, "linux", control);
  expect(operations).toEqual([["signal", fake, "SIGTERM"]]);
  expect(operations[0]?.[1]).toBe(fake);
  expect("pid" in fake).toBe(false);

  operations.length = 0;
  killRuntimeCommandTree(fake, "win32", control);
  expect(operations).toEqual([["tree", fake]]);
  expect(operations[0]?.[1]).toBe(fake);
  expect("pid" in fake).toBe(false);
  expect(fake.identity).toBe(identity);
});
