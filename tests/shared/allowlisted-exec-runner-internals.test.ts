/**
 * allowlisted-exec-runner-internals.test.ts — the internal allowlist gate
 * (CP-NODE-4 obligation 1 / invariants[2]) and the runner's timeout/kill
 * escalation, exercised with a FULLY MOCKED `node:child_process` so:
 *   - a refused command's "no spawn occurred" claim is verifiable directly
 *     (the RED case, pre-fix, actually called `spawn`; the GREEN case never
 *     does), rather than inferred indirectly from timing or exit codes;
 *   - the SIGTERM→SIGKILL timeout escalation is deterministic (fake timers),
 *     not dependent on a real slow child process.
 *
 * This file is kept separate from allowlisted-exec.test.ts, which needs REAL
 * spawns for its other assertions — `vi.mock("node:child_process")` is
 * file-scoped, so a file that needs both would have to fake every spawn.
 */
import { test, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const spawnCalls: Array<{ command: string; args: string[] }> = [];
let currentChild: any = null;

function makeControllableChild(): any {
  const child: any = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  const killCalls: string[] = [];
  child.__killCalls = killCalls;
  child.kill = (signal?: string) => {
    killCalls.push(signal ?? "SIGTERM");
    child.killed = true;
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

const { runAllowlistedReadOnlyCommand, ALLOWLISTED_EXEC_TIMEOUT_MS } = await import(
  "../../src/shared/tooling/allowlistedExec.js"
);

beforeEach(() => {
  spawnCalls.length = 0;
  currentChild = null;
});

// ── CRIT: a refused command must NEVER reach spawn ─────────────────────────

test("CRIT internal gate: a refused ANCHOR argv with NO prior caller-side check resolves a structured refusal and NEVER spawns", async () => {
  // rg --pre is on the adversarial-refusal list (preprocessor exec) — this is
  // called DIRECTLY, with no isAllowedAnchorCommand() call first, unlike
  // anchorGrounding.ts's caller-gated path.
  const outcome = await runAllowlistedReadOnlyCommand(
    ["rg", "--pre", "x"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  expect(spawnCalls.length, "a refused command must never reach child_process.spawn").toBe(0);
  expect(outcome.refused).toBe(true);
  expect(outcome.exit_code).toBe(null);
  expect(outcome.timed_out).toBe(false);
  expect(outcome.spawn_error, "a refusal is not a spawn error").toBe(undefined);
});

test("CRIT internal gate: a non-allowlisted executable resolves a structured refusal and NEVER spawns", async () => {
  const outcome = await runAllowlistedReadOnlyCommand(
    ["node", "-e", "1"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  expect(spawnCalls.length).toBe(0);
  expect(outcome.refused).toBe(true);
});

test("an ALLOWED command still reaches spawn (the gate does not over-refuse)", async () => {
  const promise = runAllowlistedReadOnlyCommand(
    ["git", "log"],
    process.cwd(),
    ALLOWLISTED_EXEC_TIMEOUT_MS,
  );
  // Let the mocked spawn run synchronously, then settle the child cleanly.
  await Promise.resolve();
  expect(spawnCalls.length, "an allowed command must reach spawn").toBe(1);
  currentChild.emit("close", 0);
  const outcome = await promise;
  expect(outcome.refused).not.toBe(true);
  expect(outcome.exit_code).toBe(0);
});

// ── truncation signal (CP-NODE-8) ───────────────────────────────────────────
// MAX_CAPTURED_OUTPUT (allowlistedExec.ts) is 256 * 1024 and is not exported;
// mirrored here as a documented constant since these tests drive the cap via
// mocked stdout/stderr chunk sizes rather than importing it.
const MAX_CAPTURED_OUTPUT = 256 * 1024;

test("output past the cap sets truncated:true on close (a genuinely dropped chunk)", async () => {
  const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
  await Promise.resolve();
  expect(spawnCalls.length).toBe(1);
  const child = currentChild;

  // First chunk fills the cap exactly — nothing lost yet.
  child.stdout.emit("data", "a".repeat(MAX_CAPTURED_OUTPUT));
  // Second chunk arrives once the cap is already reached — genuinely dropped.
  child.stdout.emit("data", "overflow");
  child.emit("close", 0);

  const outcome = await promise;
  expect(outcome.output.length).toBe(MAX_CAPTURED_OUTPUT);
  expect(outcome.truncated).toBe(true);
});

test("output past the cap sets truncated:true on spawn_error too", async () => {
  const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
  await Promise.resolve();
  expect(spawnCalls.length).toBe(1);
  const child = currentChild;

  child.stdout.emit("data", "a".repeat(MAX_CAPTURED_OUTPUT));
  child.stdout.emit("data", "overflow");
  child.emit("error", new Error("spawn failed"));

  const outcome = await promise;
  expect(outcome.spawn_error).toBe("spawn failed");
  expect(outcome.truncated).toBe(true);
});

test("output under the cap leaves truncated falsy, including a single chunk that lands exactly on the cap", async () => {
  const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
  await Promise.resolve();
  expect(spawnCalls.length).toBe(1);
  const child = currentChild;

  // A single chunk that pushes output to exactly the cap in one shot loses
  // nothing — must NOT set truncated.
  child.stdout.emit("data", "a".repeat(MAX_CAPTURED_OUTPUT));
  child.emit("close", 0);

  const outcome = await promise;
  expect(outcome.output.length).toBe(MAX_CAPTURED_OUTPUT);
  expect(outcome.truncated).toBeFalsy();
});

test("small output well under the cap leaves truncated falsy", async () => {
  const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), ALLOWLISTED_EXEC_TIMEOUT_MS);
  await Promise.resolve();
  expect(spawnCalls.length).toBe(1);
  const child = currentChild;

  child.stdout.emit("data", "hello");
  child.stderr.emit("data", "world");
  child.emit("close", 0);

  const outcome = await promise;
  expect(outcome.output).toBe("helloworld");
  expect(outcome.truncated).toBeFalsy();
});

// ── SIGTERM → SIGKILL escalation at the documented offsets ─────────────────

test("a slow (admitted) child is SIGTERM'd at timeoutMs then SIGKILL'd after the grace period, with timed_out:true", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "Date"] });
  try {
    const timeoutMs = 5_000;
    const promise = runAllowlistedReadOnlyCommand(["git", "log"], process.cwd(), timeoutMs);
    // Let the mocked spawn run (it's called synchronously inside the executor).
    await Promise.resolve();
    expect(spawnCalls.length).toBe(1);
    const child = currentChild;

    // Not yet at the timeout: no kill signal sent.
    vi.advanceTimersByTime(timeoutMs - 1);
    expect(child.__killCalls).toEqual([]);

    // Exactly at the documented timeoutMs offset: SIGTERM fires.
    vi.advanceTimersByTime(1);
    expect(child.__killCalls).toEqual(["SIGTERM"]);

    // Documented SIGKILL_GRACE_MS offset (allowlistedExec.ts) is 2_000ms after
    // SIGTERM; short of it, no escalation yet.
    vi.advanceTimersByTime(1_999);
    expect(child.__killCalls).toEqual(["SIGTERM"]);

    // Exactly at the grace offset: SIGKILL escalation fires.
    vi.advanceTimersByTime(1);
    expect(child.__killCalls).toEqual(["SIGTERM", "SIGKILL"]);

    // The child eventually closes (as if SIGKILL took effect) — outcome
    // reports timed_out:true regardless of the reported exit code.
    child.emit("close", null);
    const outcome = await promise;
    expect(outcome.timed_out).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
