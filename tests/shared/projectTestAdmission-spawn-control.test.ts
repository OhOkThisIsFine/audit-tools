/**
 * projectTestAdmission-spawn-control.test.ts — deterministic (mocked
 * child_process + fake timers) coverage of runAdmittedProjectTestCommand's
 * suite-sized timeout/SIGTERM/SIGKILL escalation (CDC-019) and its truncation
 * (never silent-drop) behavior at the output-capture cap. Kept separate from
 * projectTestAdmission.test.ts, which needs REAL spawns for its happy-path
 * assertions — vi.mock("node:child_process") is file-scoped.
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
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    currentChild = makeControllableChild();
    return currentChild;
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
  child.emit("close", 0);
  const outcome = await promise;
  expect(outcome.truncated).toBe(false);
  expect(outcome.output).toBe("all good\n");
  rmSync(dir, { recursive: true, force: true });
});
