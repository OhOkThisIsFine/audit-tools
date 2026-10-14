/** Deterministic pipe chunks: real child writes do not imply data-event boundaries. */
import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { runTrackedAsync, type RunTrackedOptions } from "../../src/shared/tooling/exec.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock, spawnSync: vi.fn() }));

class MockChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
  exitCode = null;
  signalCode = null;
  kill = vi.fn((_signal?: string) => true);
}

function start(options: RunTrackedOptions = {}) {
  const child = new MockChild();
  spawnMock.mockReturnValueOnce(child);
  const promise = runTrackedAsync(["mock-child", "arg"], options);
  return { child, promise };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  spawnMock.mockReset();
});

for (const encoding of [undefined, "utf8", "utf-8"] as const) {
  for (const character of ["é", "€", "😀"]) {
    const bytes = Buffer.from(character);
    for (let split = 1; split < bytes.length; split++) {
      test(`${encoding ?? "default"}: preserves ${character} split at byte ${split} on both pipes`, async () => {
        const { child, promise } = start({ encoding });
        const chunks = [
          Buffer.concat([Buffer.from("path\0"), bytes.subarray(0, split)]),
          Buffer.concat([bytes.subarray(split), Buffer.from("\nnext\0")]),
        ];
        // Interleaving exposes an accidentally shared decoder too.
        child.stdout.emit("data", chunks[0]);
        child.stderr.emit("data", chunks[0]);
        child.stdout.emit("data", chunks[1]);
        child.stderr.emit("data", chunks[1]);
        child.emit("close", 0, null);
        const result = await promise;
        const expected = Buffer.concat(chunks).toString("utf8");
        expect(result.stdout).toBe(expected);
        expect(result.stderr).toBe(expected);
        expect(result.status).toBe(0);
        expect(result.error).toBeUndefined();
      });
    }
  }
}

test("UTF-8 streams keep independent partial characters across many chunks", async () => {
  const { child, promise } = start();
  const out = Buffer.from("aé\0€\n😀z");
  const err = Buffer.from("😀\n€\0éb");
  for (let i = 0; i < Math.max(out.length, err.length); i++) {
    if (i < out.length) child.stdout.emit("data", out.subarray(i, i + 1));
    if (i < err.length) child.stderr.emit("data", err.subarray(i, i + 1));
  }
  child.emit("close", 0, null);
  const result = await promise;
  expect(result.stdout).toBe(out.toString());
  expect(result.stderr).toBe(err.toString());
});

for (const terminal of ["close", "error"] as const) {
  test(`incomplete UTF-8 is flushed exactly once on ${terminal}`, async () => {
    const end = vi.spyOn(StringDecoder.prototype, "end");
    const { child, promise } = start({ cwd: "/mock-cwd" });
    const out = Buffer.from([0x61, 0xf0, 0x9f, 0x98]);
    const err = Buffer.from([0x62, 0xe2, 0x82]);
    child.stdout.emit("data", out);
    child.stderr.emit("data", err);
    const error = Object.assign(new Error("mock spawn error"), { code: "ENOENT" });
    if (terminal === "error") child.emit("error", error);
    else child.emit("close", 7, null);
    // An error is commonly followed by close. Neither path may flush again.
    child.emit("close", 99, "SIGTERM");
    const result = await promise;
    expect(end).toHaveBeenCalledTimes(2);
    expect(result.stdout).toBe(out.toString());
    expect(result.stderr).toBe(err.toString());
    expect(result.status).toBe(terminal === "error" ? null : 7);
    expect(result.error).toBe(terminal === "error" ? error : undefined);
    expect(result.signal).toBeNull();
    expect(result.argv).toEqual(["mock-child", "arg"]);
    expect(result.cwd).toBe("/mock-cwd");
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
}

test("invalid and incomplete bytes match one complete UTF-8 decode", async () => {
  const { child, promise } = start();
  const bytes = Buffer.from([0xe2, 0x82, 0x41, 0xff, 0xc3]);
  for (const byte of bytes) child.stdout.emit("data", Buffer.from([byte]));
  child.emit("close", 0, null);
  expect((await promise).stdout).toBe(bytes.toString());
});

for (const encoding of ["latin1", "ascii", "hex", "base64", "utf16le"] as const) {
  test(`${encoding} retains its existing per-chunk decoding`, async () => {
    const { child, promise } = start({ encoding });
    const chunks = [Buffer.from([0xc3]), Buffer.from([0xa9, 0x00, 0x62])];
    for (const chunk of chunks) {
      child.stdout.emit("data", chunk);
      child.stderr.emit("data", chunk);
    }
    child.emit("close", 0, null);
    const result = await promise;
    const expected = chunks.map((chunk) => chunk.toString(encoding)).join("");
    expect(result.stdout).toBe(expected);
    expect(result.stderr).toBe(expected);
  });
}

test("exact raw byte cap succeeds independently on both streams", async () => {
  const { child, promise } = start({ maxBuffer: 4, input: "request" });
  const bytes = Buffer.from("😀");
  for (const byte of bytes) {
    child.stdout.emit("data", Buffer.from([byte]));
    child.stderr.emit("data", Buffer.from([byte]));
  }
  child.stdin.emit("error", Object.assign(new Error("closed pipe"), { code: "EPIPE" }));
  child.emit("close", 0, null);
  const result = await promise;
  expect(result.stdout).toBe("😀");
  expect(result.stderr).toBe("😀");
  expect(result.error).toBeUndefined();
  expect(child.kill).not.toHaveBeenCalled();
  expect(child.stdin.write).toHaveBeenCalledWith("request");
  expect(child.stdin.end).toHaveBeenCalledTimes(1);
});

for (const stream of ["stdout", "stderr"] as const) {
  test(`${stream}: cap plus one reports ENOBUFS using bytes, flushing admitted partial UTF-8`, async () => {
    const { child, promise } = start({ maxBuffer: 2 });
    child[stream].emit("data", Buffer.from([0xf0]));
    child[stream].emit("data", Buffer.from([0x9f, 0x98]));
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emit("close", null, "SIGTERM");
    const result = await promise;
    expect(result[stream]).toBe(Buffer.from([0xf0, 0x9f, 0x98]).toString());
    expect(result.error).toMatchObject({ code: "ENOBUFS" });
    expect(result.signal).toBe("SIGTERM");
    expect(result.status).toBeNull();
  });
}

for (const stream of ["stdout", "stderr"] as const) {
  test(`${stream}: corrected UTF-8 length admits the completing chunk at the backstop`, async () => {
    const { child, promise } = start();
    const maxCapture = 10 * 1024 * 1024;
    const prefix = "a".repeat(maxCapture - 1);
    child[stream].emit("data", Buffer.from(prefix));
    child[stream].emit("data", Buffer.from([0xc3]));
    child[stream].emit("data", Buffer.from([0xa9, 0x58]));
    child[stream].emit("data", Buffer.from("Y"));
    child.emit("close", 0, null);
    const result = await promise;
    expect(result[stream]).toBe(`${prefix}éX`);
    expect(result[stream].length).toBe(maxCapture + 1);
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });
}

test("capture retains whole admitted chunks and ignores subsequent chunks past its backstop", async () => {
  const { child, promise } = start();
  const prefix = "a".repeat(10 * 1024 * 1024 - 1);
  child.stdout.emit("data", Buffer.from(prefix));
  child.stdout.emit("data", Buffer.from([0x62, 0xe2, 0x82]));
  child.stdout.emit("data", Buffer.from([0xac]));
  child.emit("close", 0, null);
  const result = await promise;
  expect(result.stdout).toBe(`${prefix}b�`);
  expect(result.error).toBeUndefined();
});

test("deadline still escalates SIGTERM to SIGKILL and flushes partial UTF-8", async () => {
  vi.useFakeTimers();
  const { child, promise } = start({ timeout: 20 });
  child.stdout.emit("data", Buffer.from([0xc3]));
  vi.advanceTimersByTime(20);
  expect(child.kill.mock.calls).toEqual([[]]);
  vi.runOnlyPendingTimers();
  expect(child.kill.mock.calls).toEqual([[], ["SIGKILL"]]);
  child.emit("close", null, "SIGKILL");
  const result = await promise;
  expect(result.stdout).toBe("�");
  expect(result.error).toMatchObject({ code: "ETIMEDOUT" });
  expect(result.signal).toBe("SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
});

test("external signal failure retains metadata and flushes both pipes", async () => {
  const { child, promise } = start();
  child.stdout.emit("data", Buffer.from([0xc3]));
  child.stderr.emit("data", Buffer.from([0xe2, 0x82]));
  child.emit("close", null, "SIGINT");
  const result = await promise;
  expect(result.stdout).toBe("�");
  expect(result.stderr).toBe("�");
  expect(result.error?.message).toBe("child terminated by signal SIGINT");
  expect(result.error).not.toHaveProperty("code");
  expect(result.signal).toBe("SIGINT");
  expect(result.status).toBeNull();
});
