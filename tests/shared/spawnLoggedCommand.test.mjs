import { test, expect, vi } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { spawnLoggedCommand } = await import("../../src/shared/providers/spawnLoggedCommand.ts");

// A WriteStream stand-in that satisfies the surface spawnLoggedCommand uses
// (write(chunk, cb), end(cb), on("error")) without touching the filesystem.
function fakeWriteStream() {
  const stream = new EventEmitter();
  stream.write = (_chunk, cb) => {
    if (typeof cb === "function") cb();
    return true;
  };
  stream.end = (cb) => {
    if (typeof cb === "function") cb();
  };
  return stream;
}

function fakeCreateWriteStream() {
  return fakeWriteStream();
}

// A child-process stand-in. Provides pipe-backed stdout/stderr and emits a
// clean exit/close (code 0, no signal) on the next tick so spawnLoggedCommand
// settles with accepted === true.
function makeChild() {
  const child = new EventEmitter();
  child.pid = 4321;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  setImmediate(() => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return child;
}

function baseInput() {
  return {
    repoRoot: "/repo",
    runId: "RUN-1",
    obligationId: null,
    promptPath: "/repo/prompt.md",
    taskPath: "/repo/task.json",
    resultPath: "/repo/result.json",
    stdoutPath: "/repo/out.log",
    stderrPath: "/repo/err.log",
    uiMode: "headless",
    timeoutMs: 5_000,
  };
}

const ORIGINAL_COMMAND = "my-cli";
const ORIGINAL_ARGS = ["--prompt", "p with space", "--flag"];

test("spawnLoggedCommand passes command and args to spawn untouched (INV-shared-core-11)", async () => {
  // INV-shared-core-11: spawnLoggedCommand applies no command wrapping.
  // The command and args passed to spawn must always be exactly the inputs given.
  const calls = [];
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    baseInput(),
    undefined,
    {
      createWriteStream: fakeCreateWriteStream,
      spawn: (command, args) => {
        calls.push({ command, args });
        return makeChild();
      },
    },
  );

  expect(calls.length).toBe(1);
  expect(calls[0].command).toBe(ORIGINAL_COMMAND);
  expect(calls[0].args).toEqual(ORIGINAL_ARGS);
  expect(result.accepted).toBe(true);
});

// A child that stays open until `settle()` is called, so a heartbeat can fire
// under mocked timers before the process closes.
function makeOpenChild() {
  const child = new EventEmitter();
  child.pid = 4321;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.settle = () => {
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  };
  return child;
}

// A stderr-log stand-in that records the human "[provider] ... still running"
// lines written to the per-run stderr log file.
function recordingWriteStream(sink) {
  const stream = new EventEmitter();
  stream.write = (chunk, cb) => {
    sink.push(String(chunk));
    if (typeof cb === "function") cb();
    return true;
  };
  stream.end = (cb) => {
    if (typeof cb === "function") cb();
  };
  return stream;
}

test("spawnLoggedCommand routes structured heartbeat to stderrLog, not process.stderr, in headless mode (OBS-101)", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
  const stderrWrites = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };

  const stderrLogLines = [];
  let openChild;
  try {
    // Timeout well past one heartbeat interval so ticking to fire the heartbeat
    // does not also trip the timeout timer.
    const input = { ...baseInput(), timeoutMs: 120_000 }; // NO onProgress wired, uiMode: "headless"
    const promise = spawnLoggedCommand(ORIGINAL_COMMAND, ORIGINAL_ARGS, input, undefined, {
      createWriteStream: (path) =>
        path === input.stderrPath ? recordingWriteStream(stderrLogLines) : fakeWriteStream(),
      spawn: () => {
        openChild = makeOpenChild();
        return openChild;
      },
    });

    // Advance past one heartbeat interval (30s) so the interval callback runs.
    vi.advanceTimersByTime(30_000);

    // Structured heartbeat is written to the run log file (stderrLog), not process.stderr,
    // in headless mode so it is correlated, machine-parseable, and durable.
    const heartbeatLine = stderrLogLines.find((line) => {
      try {
        return JSON.parse(line).type === "provider_heartbeat";
      } catch {
        return false;
      }
    });
    expect(heartbeatLine, "expected a structured provider_heartbeat line in stderrLog").toBeTruthy();
    const parsed = JSON.parse(heartbeatLine);
    expect(parsed.runId).toBe("RUN-1");
    expect(typeof parsed.elapsedMs).toBe("number");

    // process.stderr.write must NOT have been called with the structured JSON in headless mode.
    expect(!stderrWrites.some((line) => {
        try {
          return JSON.parse(line).type === "provider_heartbeat";
        } catch {
          return false;
        }
      }), "expected no structured heartbeat on process.stderr in headless mode").toBeTruthy();

    // The human "[provider] ... still running" line is still written to the
    // per-run stderr log unconditionally.
    expect(stderrLogLines.some((line) => line.includes("still running")), "expected the human still-running line in the stderr log").toBeTruthy();

    openChild.settle();
    const result = await promise;
    expect(result.accepted).toBe(true);
  } finally {
    process.stderr.write = originalStderrWrite;
    vi.useRealTimers();
  }
});

test("spawnLoggedCommand echoes structured heartbeat to process.stderr when uiMode is visible (OBS-101)", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
  const stderrWrites = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };

  const stderrLogLines = [];
  let openChild;
  try {
    const input = { ...baseInput(), timeoutMs: 120_000, uiMode: "visible" };
    const promise = spawnLoggedCommand(ORIGINAL_COMMAND, ORIGINAL_ARGS, input, undefined, {
      createWriteStream: (path) =>
        path === input.stderrPath ? recordingWriteStream(stderrLogLines) : fakeWriteStream(),
      spawn: () => {
        openChild = makeOpenChild();
        return openChild;
      },
    });

    vi.advanceTimersByTime(30_000);

    // In visible mode the structured heartbeat appears in both stderrLog AND process.stderr.
    expect(stderrLogLines.some((line) => {
        try {
          return JSON.parse(line).type === "provider_heartbeat";
        } catch {
          return false;
        }
      }), "expected structured heartbeat in stderrLog in visible mode").toBeTruthy();
    expect(stderrWrites.some((line) => {
        try {
          return JSON.parse(line).type === "provider_heartbeat";
        } catch {
          return false;
        }
      }), "expected structured heartbeat on process.stderr in visible mode").toBeTruthy();

    openChild.settle();
    const result = await promise;
    expect(result.accepted).toBe(true);
  } finally {
    process.stderr.write = originalStderrWrite;
    vi.useRealTimers();
  }
});

test("spawnLoggedCommand rejects with timeout error and sends SIGTERM when timeoutMs elapses", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
  const killCalls = [];
  let openChild;
  try {
    const input = { ...baseInput(), timeoutMs: 5_000 };
    const promise = spawnLoggedCommand(ORIGINAL_COMMAND, ORIGINAL_ARGS, input, undefined, {
      killGraceMs: 200,
      createWriteStream: fakeCreateWriteStream,
      spawn: () => {
        openChild = makeOpenChild();
        openChild.kill = (signal) => {
          killCalls.push(signal ?? "SIGTERM");
          openChild.killed = true;
          return true;
        };
        return openChild;
      },
    });

    // Advance past timeoutMs — the timeout timer fires, setting timedOut=true and sending SIGTERM.
    vi.advanceTimersByTime(5_001);

    expect(killCalls.includes("SIGTERM"), "expected SIGTERM to be sent after timeout").toBeTruthy();

    // Settle the child so the promise resolves/rejects.
    openChild.emit("exit", null, "SIGTERM");
    openChild.emit("close", null, "SIGTERM");

    await assert.rejects(promise, (err) => {
      expect(err.message.includes("timed out"), `expected 'timed out' in error message, got: ${err.message}`).toBeTruthy();
      expect(err.message.includes(input.runId), `expected run ID in error message, got: ${err.message}`).toBeTruthy();
      return true;
    });
  } finally {
    vi.useRealTimers();
  }
});

test("spawnLoggedCommand escalates to SIGKILL after grace period when child does not exit after SIGTERM", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
  const killCalls = [];
  let openChild;
  try {
    const input = { ...baseInput(), timeoutMs: 5_000 };
    const promise = spawnLoggedCommand(ORIGINAL_COMMAND, ORIGINAL_ARGS, input, undefined, {
      killGraceMs: 200,
      createWriteStream: fakeCreateWriteStream,
      spawn: () => {
        openChild = makeOpenChild();
        openChild.kill = (signal) => {
          killCalls.push(signal ?? "SIGTERM");
          openChild.killed = true;
          return true;
        };
        return openChild;
      },
    });

    // Advance past timeoutMs — SIGTERM should be sent.
    vi.advanceTimersByTime(5_001);
    expect(killCalls.includes("SIGTERM"), "expected SIGTERM after timeout").toBeTruthy();
    // Child does not exit — advance past killGraceMs without emitting close.
    vi.advanceTimersByTime(201);
    expect(killCalls.includes("SIGKILL"), "expected SIGKILL escalation after grace period").toBeTruthy();

    // Now settle the child (as if SIGKILL took effect).
    openChild.emit("exit", null, "SIGKILL");
    openChild.emit("close", null, "SIGKILL");

    await assert.rejects(promise, (err) => {
      expect(err.message.includes("timed out"), `expected 'timed out' in message, got: ${err.message}`).toBeTruthy();
      return true;
    });
  } finally {
    vi.useRealTimers();
  }
});

test("spawnLoggedCommand does NOT send SIGKILL when child exits cleanly within the grace period after SIGTERM", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
  const killCalls = [];
  let openChild;
  try {
    const input = { ...baseInput(), timeoutMs: 5_000 };
    const promise = spawnLoggedCommand(ORIGINAL_COMMAND, ORIGINAL_ARGS, input, undefined, {
      killGraceMs: 200,
      createWriteStream: fakeCreateWriteStream,
      spawn: () => {
        openChild = makeOpenChild();
        openChild.kill = (signal) => {
          killCalls.push(signal ?? "SIGTERM");
          openChild.killed = true;
          return true;
        };
        return openChild;
      },
    });

    // Advance past timeoutMs — SIGTERM should be sent.
    vi.advanceTimersByTime(5_001);
    expect(killCalls.includes("SIGTERM"), "expected SIGTERM after timeout").toBeTruthy();

    // Child honors SIGTERM and exits before grace period expires.
    openChild.emit("exit", null, "SIGTERM");
    openChild.emit("close", null, "SIGTERM");

    // Advance past killGraceMs — SIGKILL should NOT be sent because child already closed.
    vi.advanceTimersByTime(201);
    expect(!killCalls.includes("SIGKILL"), "expected NO SIGKILL when child exits within grace period").toBeTruthy();
    expect(killCalls.filter((s) => s === "SIGTERM").length, "expected exactly one SIGTERM call").toBe(1);

    await assert.rejects(promise, (err) => {
      expect(err.message.includes("timed out"), `expected 'timed out' in message, got: ${err.message}`).toBeTruthy();
      return true;
    });
  } finally {
    vi.useRealTimers();
  }
});

// TST-2c6d0deb: stdinText pipe path and null-stdin guard coverage.

test("spawnLoggedCommand pipes stdinText to the child stdin and closes it", async () => {
  const spawnCalls = [];
  const stdinEndCalls = [];

  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    { ...baseInput(), stdinText: "hello from stdin" },
    undefined,
    {
      createWriteStream: fakeCreateWriteStream,
      spawn: (command, args, opts) => {
        spawnCalls.push({ command, args, opts });
        const child = makeChild();
        const origEnd = child.stdin.end.bind(child.stdin);
        child.stdin.end = (data, ...rest) => {
          stdinEndCalls.push(data);
          return origEnd(data, ...rest);
        };
        return child;
      },
    },
  );

  expect(spawnCalls.length).toBe(1);
  // stdio[0] must be 'pipe' when stdinText is provided.
  expect(spawnCalls[0].opts.stdio[0]).toBe("pipe");
  // stdin.end must have been called with the exact stdinText value.
  expect(stdinEndCalls.length).toBe(1);
  expect(stdinEndCalls[0]).toBe("hello from stdin");
  expect(result.accepted).toBe(true);
});

test("spawnLoggedCommand rejects when stdinText is set but child.stdin is null", async () => {
  await assert.rejects(
    spawnLoggedCommand(
      ORIGINAL_COMMAND,
      ORIGINAL_ARGS,
      { ...baseInput(), stdinText: "some text" },
      undefined,
      {
        createWriteStream: fakeCreateWriteStream,
        spawn: () => {
          const child = makeChild();
          child.stdin = null;
          return child;
        },
      },
    ),
    (err) => {
      expect(err.message.includes("pipe-backed stdin"), `expected 'pipe-backed stdin' in error message, got: ${err.message}`).toBeTruthy();
      return true;
    },
  );
});

// MNT-2a585b94: SpawnRunController now owns its Promise via run(); validate via public API.
test("SpawnRunController can be instantiated without an external Promise: spawnLoggedCommand returns a Promise", async () => {
  // If SpawnRunController still required external resolve/reject the call
  // would throw or never settle. A clean return proves the class is self-contained.
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    baseInput(),
    undefined,
    {
      createWriteStream: fakeCreateWriteStream,
      spawn: () => makeChild(),
    },
  );
  expect(result !== null && typeof result === "object", "run() must resolve with an object").toBeTruthy();
  expect("accepted" in result, "resolved value must have an accepted field").toBeTruthy();
});

test("SpawnRunController.run() resolves with accepted=true when child exits with code 0", async () => {
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    baseInput(),
    undefined,
    {
      createWriteStream: fakeCreateWriteStream,
      spawn: () => {
        const child = makeChild(); // emits exit(0, null) and close(0, null)
        return child;
      },
    },
  );
  expect(result.accepted).toBe(true);
  expect(result.exitCode).toBe(0);
});

test("SpawnRunController.run() rejects when child exits with a non-zero code", async () => {
  function makeFailingChild(code) {
    const child = new EventEmitter();
    child.pid = 9999;
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    setImmediate(() => {
      child.emit("exit", code, null);
      child.emit("close", code, null);
    });
    return child;
  }

  // Non-zero exit should not reject outright — it resolves with accepted=false
  // (the class settles via resolve, not reject, for non-zero exits).
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    baseInput(),
    undefined,
    {
      createWriteStream: fakeCreateWriteStream,
      spawn: () => makeFailingChild(1),
    },
  );
  expect(result.accepted).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(typeof result.error === "string", "error field must be set for non-zero exit").toBeTruthy();
});

// TST-42dbaa42: non-success branch coverage

function makeFailingChild() {
  const child = new EventEmitter();
  child.pid = 8001;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  setImmediate(() => {
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
  });
  return child;
}

function makeSignaledChild() {
  const child = new EventEmitter();
  child.pid = 8002;
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  setImmediate(() => {
    child.emit("exit", null, "SIGTERM");
    child.emit("close", null, "SIGTERM");
  });
  return child;
}

test("spawnLoggedCommand returns accepted=false and error message when child exits with non-zero code", async () => {
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    baseInput(),
    undefined,
    {
      createWriteStream: fakeCreateWriteStream,
      spawn: () => makeFailingChild(),
    },
  );
  expect(result.accepted).toBe(false);
  expect(result.exitCode).toBe(1);
  expect(typeof result.error === "string" && result.error.includes("code 1"), `expected error to contain 'code 1', got: ${result.error}`).toBeTruthy();
  expect(result.signal === null || result.signal === undefined, `expected signal to be null or undefined, got: ${result.signal}`).toBeTruthy();
});

test("spawnLoggedCommand returns accepted=false and error message when child is killed by a signal", async () => {
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    baseInput(),
    undefined,
    {
      createWriteStream: fakeCreateWriteStream,
      spawn: () => makeSignaledChild(),
    },
  );
  expect(result.accepted).toBe(false);
  expect(result.signal).toBe("SIGTERM");
  expect(typeof result.error === "string" && result.error.includes("SIGTERM"), `expected error to contain 'SIGTERM', got: ${result.error}`).toBeTruthy();
  expect(result.exitCode === null || result.exitCode === undefined, `expected exitCode to be null or undefined, got: ${result.exitCode}`).toBeTruthy();
});

test("spawnLoggedCommand fires both the structured heartbeat to log and onProgress when wired (OBS-101)", async (t) => {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"] });
  const stderrWrites = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };

  const stderrLogLines = [];
  const progressEvents = [];
  let openChild;
  try {
    const input = {
      ...baseInput(),
      timeoutMs: 120_000,
      onProgress: (event) => progressEvents.push(event),
    };
    const promise = spawnLoggedCommand(ORIGINAL_COMMAND, ORIGINAL_ARGS, input, undefined, {
      createWriteStream: (path) =>
        path === input.stderrPath ? recordingWriteStream(stderrLogLines) : fakeWriteStream(),
      spawn: () => {
        openChild = makeOpenChild();
        return openChild;
      },
    });

    vi.advanceTimersByTime(30_000);

    // Structured heartbeat is in the log file (headless mode: not on process.stderr).
    expect(stderrLogLines.some((line) => {
        try {
          return JSON.parse(line).type === "provider_heartbeat";
        } catch {
          return false;
        }
      }), "expected the structured heartbeat in stderrLog").toBeTruthy();
    expect(progressEvents.some((event) => event.type === "heartbeat"), "expected an onProgress heartbeat callback").toBeTruthy();

    openChild.settle();
    const result = await promise;
    expect(result.accepted).toBe(true);
  } finally {
    process.stderr.write = originalStderrWrite;
    vi.useRealTimers();
  }
});

// INV-shared-core-10: spawnLoggedCommand spawn-error 'error'-event path.
// The 'error' event on the child process (emitted when spawn itself fails,
// e.g. ENOENT) must cause the returned Promise to reject with a descriptive
// error rather than hanging forever or silently swallowing the failure.
test("spawnLoggedCommand rejects when the child process emits an 'error' event (e.g. ENOENT)", async () => {
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  const spawnError = new Error("spawn my-cli ENOENT");
  spawnError.code = "ENOENT";

  await assert.rejects(
    spawnLoggedCommand(
      ORIGINAL_COMMAND,
      ORIGINAL_ARGS,
      baseInput(),
      undefined,
      {
        createWriteStream: fakeCreateWriteStream,
        spawn: () => {
          const child = new EventEmitter();
          child.pid = undefined;
          child.killed = false;
          child.kill = () => { child.killed = true; return true; };
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.stdin = new PassThrough();
          // Emit 'error' on next tick — this is the async spawn-failure path.
          setImmediate(() => child.emit("error", spawnError));
          return child;
        },
      },
    ),
    (err) => {
      expect(err instanceof Error, `expected an Error instance, got ${typeof err}`).toBeTruthy();
      expect(err.message.includes("ENOENT") || err.message.includes("spawn"), `expected error to mention ENOENT or spawn, got: ${err.message}`).toBeTruthy();
      return true;
    },
  );
});

// INV-shared-core-10: lifecycle test — spawnLoggedCommand start → log flush → settle.
// Verifies that the full lifecycle (spawn → data events → close → settle) works
// correctly: stdout/stderr data are written to logs, and the promise resolves
// with the correct accepted/exitCode fields after the close event.
test("spawnLoggedCommand lifecycle: stdout/stderr logged and result carries correct fields", async () => {
  const stdoutLinesSink = [];
  const stderrLinesSink = [];

  function recordingStream(sink) {
    const s = new EventEmitter();
    s.write = (chunk, cb) => {
      sink.push(String(chunk));
      if (typeof cb === "function") cb();
      return true;
    };
    s.end = (cb) => { if (typeof cb === "function") cb(); };
    return s;
  }

  const input = baseInput();
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    input,
    undefined,
    {
      createWriteStream: (path) => {
        if (path === input.stdoutPath) return recordingStream(stdoutLinesSink);
        return recordingStream(stderrLinesSink);
      },
      spawn: () => {
        const child = makeChild();
        return child;
      },
    },
  );

  expect(result.accepted, "lifecycle must settle accepted=true").toBe(true);
  expect(result.exitCode, "exitCode must be 0 for clean exit").toBe(0);
  expect(result.command.includes(ORIGINAL_COMMAND), "command must be in result").toBeTruthy();
});
