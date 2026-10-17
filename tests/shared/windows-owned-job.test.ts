import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { runWindowsOwnedJob, type OwnedJobMessage, type WindowsJobRuntime } from "../../src/shared/tooling/windowsOwnedJob.js";

function fixture() {
  const child = new EventEmitter() as ChildProcess;
  let start: (payload: unknown) => void = () => { throw new Error("not ready"); };
  let disconnect = () => {};
  const messages: OwnedJobMessage[] = [];
  const spawn = vi.fn(() => child);
  const exit = vi.fn();
  const closeInheritedStdio = vi.fn();
  const runtime: WindowsJobRuntime = {
    platform: "win32",
    send(message, done) { messages.push(message); done?.(); },
    onStart(handler) { start = handler; },
    onDisconnect(handler) { disconnect = handler; },
    spawn, exit, closeInheritedStdio,
  };
  const activeCount = vi.fn(() => 1);
  const releaseEmpty = vi.fn();
  return { runtime, messages, spawn, exit, child, activeCount, releaseEmpty, closeInheritedStdio,
    start: (payload: unknown) => start(payload), disconnect: () => disconnect() };
}

afterEach(() => { vi.useRealTimers(); });

test("ownership setup must finish before ready or target launch", async () => {
  const f = fixture();
  await expect(runWindowsOwnedJob(f.runtime, async () => { throw new Error("assignment denied"); })).rejects.toThrow("assignment denied");
  expect(f.messages).toEqual([]);
  expect(f.spawn).not.toHaveBeenCalled();
});

test("an expired start never launches user code", async () => {
  const f = fixture();
  await runWindowsOwnedJob(f.runtime, async () => f);
  f.start({ argv: ["fixture"], env: {}, deadlineAt: Date.now() - 1 });
  expect(f.spawn).not.toHaveBeenCalled();
  expect(f.messages).toEqual([{ type: "ready" }, expect.objectContaining({ type: "error", code: "ETIMEDOUT" }), { type: "empty" }]);
  expect(f.releaseEmpty).toHaveBeenCalledOnce();
});

test("root exit retains ownership until accounting observes only the helper", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.activeCount.mockReturnValue(2);
  await runWindowsOwnedJob(f.runtime, async () => f);
  const env = { FIXTURE: "value" };
  f.start({ argv: ["fixture", "space argument"], env });
  expect(f.spawn).toHaveBeenCalledWith(["fixture", "space argument"], env);
  f.child.emit("spawn");
  expect(f.closeInheritedStdio).toHaveBeenCalledOnce();
  f.child.emit("exit", 7, null);
  vi.advanceTimersByTime(30);
  expect(f.releaseEmpty).not.toHaveBeenCalled();
  expect(f.exit).not.toHaveBeenCalled();
  expect(f.messages).toContainEqual({ type: "root_exit", code: 7, signal: null });
  f.activeCount.mockReturnValue(1);
  vi.advanceTimersByTime(10);
  expect(f.releaseEmpty).toHaveBeenCalledOnce();
  expect(f.messages.at(-1)).toEqual({ type: "empty" });
  expect(f.exit).toHaveBeenCalledWith(7);
  expect(vi.getTimerCount()).toBe(0);
});

test("accounting failure exits with ownership intact and no empty claim", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.activeCount.mockImplementation(() => { throw new Error("query denied"); });
  await runWindowsOwnedJob(f.runtime, async () => f);
  f.start({ argv: ["fixture"], env: {} });
  f.child.emit("exit", 0, null);
  vi.advanceTimersByTime(10);
  expect(f.releaseEmpty).not.toHaveBeenCalled();
  expect(f.messages).toContainEqual({ type: "error", code: "EOWNERSHIP", message: "query denied" });
  expect(f.messages).not.toContainEqual({ type: "empty" });
  expect(f.exit).toHaveBeenCalledWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("owner disconnect cancels polling without releasing a live job", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.activeCount.mockReturnValue(2);
  await runWindowsOwnedJob(f.runtime, async () => f);
  f.start({ argv: ["fixture"], env: {} });
  f.child.emit("exit", 0, null);
  f.disconnect();
  expect(f.exit).toHaveBeenCalledWith(1);
  expect(f.releaseEmpty).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
