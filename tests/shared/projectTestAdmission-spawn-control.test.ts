/**
 * projectTestAdmission-spawn-control.test.ts — deterministic (mocked
 * owned-process + fake timers) coverage of runAdmittedProjectTestCommand's
 * suite-sized timeout/SIGTERM/SIGKILL escalation (CDC-019) and its truncation
 * (never silent-drop) behavior at the output-capture cap. Kept separate from
 * projectTestAdmission.test.ts, which needs REAL spawns for its happy-path
 * assertions — the ownership mock is file-scoped.
 */
import { test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnCalls: Array<{ command: string; args: string[] }> = [];
let currentChild: any = null;

function makeControllableChild(): any {
  const child: any = new EventEmitter();
  child.pid = 7331;
  const killCalls: string[] = [];
  child.__killCalls = killCalls;
  child.kill = (signal?: string) => {
    killCalls.push(signal ?? "SIGTERM");
    return true;
  };
  for (const stream of ["stdin", "stdout", "stderr"]) {
    child[stream] = new EventEmitter();
    child[stream].destroy = vi.fn();
  }
  child.stdin.end = vi.fn();
  child.__rootExited = false;
  child.__rootStatus = null;
  child.__rootSignal = null;
  child.__empty = true;
  child.__release = vi.fn();
  child.on("exit", (code: number | null, signal: string | null = null) => {
    child.__rootExited = true;
    child.__rootStatus = code;
    child.__rootSignal = signal;
  });
  return child;
}

// Mock ownership itself: a fake PID must NEVER reach process.kill(-pid).
vi.mock("../../src/shared/tooling/ownedProcessLifecycle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/shared/tooling/ownedProcessLifecycle.js")>(),
  spawnOwnedProcess: ([command, ...args]: string[]) => {
    spawnCalls.push({ command: command!, args });
    const child = currentChild = makeControllableChild();
    return { child, terminate: child.kill, release: child.__release,
      cleanup: () => ({ cleanup_verified: child.__empty }),
      rootExited: () => child.__rootExited,
      rootStatus: () => child.__rootStatus,
      rootSignal: () => child.__rootSignal };
  },
}));

const {
  runAdmittedProjectTestCommand,
  PROJECT_TEST_MAX_CAPTURED_OUTPUT,
} = await import("../../src/shared/tooling/projectTestAdmission.js");

beforeEach(() => {
  spawnCalls.length = 0;
  currentChild = null;
});

function makeDiscoverableDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "audit-tools-testadmit-spawn-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
  return dir;
}

// ── suite-sized SIGTERM → SIGKILL escalation ────────────────────────────────

test("a hung admitted suite is SIGTERM'd at timeoutMs then SIGKILL'd after sigkillGraceMs, with timed_out:true", async () => {
  const dir = makeDiscoverableDir();
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  try {
    const timeoutMs = 10_000;
    const sigkillGraceMs = 3_000;
    const promise = runAdmittedProjectTestCommand(["npm", "test"], dir, {
      timeoutMs,
      sigkillGraceMs,
    });
    await Promise.resolve();
    expect(spawnCalls.length, "an admitted command must reach spawn").toBe(1);
    const child = currentChild;

    vi.advanceTimersByTime(timeoutMs - 1);
    expect(child.__killCalls).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(child.__killCalls).toEqual(["SIGTERM"]);

    vi.advanceTimersByTime(sigkillGraceMs - 1);
    expect(child.__killCalls).toEqual(["SIGTERM"]);

    vi.advanceTimersByTime(1);
    expect(child.__killCalls).toEqual(["SIGTERM", "SIGKILL"]);

    child.emit("exit", null, "SIGKILL");
    child.emit("close", null);
    const outcome = await promise;
    expect(outcome.admitted).toBe(true);
    expect(outcome.timed_out).toBe(true);
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a suite that closes before the timeout is never killed", async () => {
  const dir = makeDiscoverableDir();
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  try {
    const promise = runAdmittedProjectTestCommand(["npm", "test"], dir, { timeoutMs: 10_000 });
    await Promise.resolve();
    const child = currentChild;
    child.emit("exit", 0);
    child.emit("close", 0);
    const outcome = await promise;
    expect(outcome.timed_out).toBe(false);
    expect(child.__killCalls).toEqual([]);
    expect(outcome.exit_code).toBe(0);
  } finally {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── suite-sized output cap: TRUNCATED, never silently dropped ──────────────

test("output beyond PROJECT_TEST_MAX_CAPTURED_OUTPUT is truncated:true, not silently dropped", async () => {
  const dir = makeDiscoverableDir();
  const promise = runAdmittedProjectTestCommand(["npm", "test"], dir, { timeoutMs: 60_000 });
  await Promise.resolve();
  const child = currentChild;

  // First chunk fills the cap exactly; a second chunk goes entirely over.
  const filler = "a".repeat(PROJECT_TEST_MAX_CAPTURED_OUTPUT);
  child.stdout.emit("data", Buffer.from(filler));
  child.stdout.emit("data", Buffer.from("overflow"));
  expect(child.__killCalls).toEqual([]);
  child.emit("exit", 0);
  child.emit("close", 0);

  const outcome = await promise;
  expect(outcome.truncated, "output past the cap must be marked truncated, not merely stopped").toBe(true);
  expect(outcome.output.length).toBe(PROJECT_TEST_MAX_CAPTURED_OUTPUT);
  expect(outcome.output.includes("overflow"), "overflow bytes must not appear in captured output").toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("output within the cap is captured in full with truncated:false", async () => {
  const dir = makeDiscoverableDir();
  const promise = runAdmittedProjectTestCommand(["npm", "test"], dir, { timeoutMs: 60_000 });
  await Promise.resolve();
  const child = currentChild;
  child.stdout.emit("data", Buffer.from("all good\n"));
  child.emit("exit", 0);
  child.emit("close", 0);
  const outcome = await promise;
  expect(outcome.truncated).toBe(false);
  expect(outcome.output).toBe("all good\n");
  rmSync(dir, { recursive: true, force: true });
});


test("closed pipes do not cancel owned escalation; terminal drain destroys streams and releases ownership", async () => {
  const dir = makeDiscoverableDir();
  vi.useFakeTimers();
  try {
    const promise = runAdmittedProjectTestCommand(["npm", "test"], dir, { timeoutMs: 100, sigkillGraceMs: 300 });
    const child = currentChild;
    child.__empty = false;
    expect(child.stdin.end).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(100);
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null);
    vi.advanceTimersByTime(300);
    expect(child.__killCalls).toEqual(["SIGTERM", "SIGKILL"]);
    expect(child.__release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    const outcome = await promise;
    expect(outcome.timed_out).toBe(true);
    expect(outcome.spawn_error).toContain("drain limit");
    for (const stream of ["stdin", "stdout", "stderr"]) expect(child[stream].destroy).toHaveBeenCalledOnce();
    expect(child.__release).toHaveBeenCalledOnce();
    child.emit("close", 0);
    expect(child.__release).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

test("reports owned root status rather than the Windows helper close code", async () => {
  const dir = makeDiscoverableDir();
  try {
    const promise = runAdmittedProjectTestCommand(["npm", "test"], dir);
    currentChild.emit("exit", 7);
    currentChild.emit("close", 0);
    expect((await promise).exit_code).toBe(7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an owner close without root status cannot report success", async () => {
  const dir = makeDiscoverableDir();
  try {
    const promise = runAdmittedProjectTestCommand(["npm", "test"], dir);
    currentChild.emit("close", 0);
    expect(await promise).toMatchObject({ exit_code: null, spawn_error: "process owner closed without reporting the command exit" });
    expect(currentChild.__release).toHaveBeenCalledOnce();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("owner errors kill the owned scope and release all pipes", async () => {
  const dir = makeDiscoverableDir();
  try {
    const promise = runAdmittedProjectTestCommand(["npm", "test"], dir);
    currentChild.emit("error", new Error("owner failed"));
    expect((await promise).spawn_error).toBe("owner failed");
    expect(currentChild.__killCalls).toEqual(["SIGKILL"]);
    expect(currentChild.__release).toHaveBeenCalledOnce();
    for (const stream of ["stdin", "stdout", "stderr"]) expect(currentChild[stream].destroy).toHaveBeenCalledOnce();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("a Windows owner startup deadline error is a timeout even before the parent clock fires", async () => {
  const dir = makeDiscoverableDir();
  try {
    const promise = runAdmittedProjectTestCommand(["npm", "test"], dir, { timeoutMs: 60000 });
    currentChild.emit("error", Object.assign(new Error("deadline before target start"), { code: "ETIMEDOUT" }));
    expect(await promise).toMatchObject({ timed_out: true, exit_code: null, spawn_error: "deadline before target start" });
    expect(currentChild.__killCalls).toEqual(["SIGKILL"]);
    expect(currentChild.__release).toHaveBeenCalledOnce();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("owned root signal survives a successful Windows helper close", async () => {
  const dir = makeDiscoverableDir();
  try {
    const promise = runAdmittedProjectTestCommand(["npm", "test"], dir);
    currentChild.emit("exit", null, "SIGTERM");
    currentChild.emit("close", 0);
    expect(await promise).toMatchObject({ exit_code: null, timed_out: false, spawn_error: "command terminated by signal SIGTERM" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
