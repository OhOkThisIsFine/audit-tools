import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { spawnLoggedCommand } = await import(
  "../src/providers/spawnLoggedCommand.ts"
);

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

test("spawnLoggedCommand applies opentoken wrap (default opentoken command)", async () => {
  const calls = [];
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    baseInput(),
    undefined,
    {
      opentoken: true,
      createWriteStream: fakeCreateWriteStream,
      spawn: (command, args) => {
        calls.push({ command, args });
        return makeChild();
      },
    },
  );

  assert.equal(calls.length, 1);
  const { command, args } = calls[0];

  if (process.platform === "win32") {
    // win32: command becomes cmd.exe and args are ['/d','/s','/c','opentoken wrap ...'].
    assert.equal(command, process.env.ComSpec ?? "cmd.exe");
    // quoteCmdArg leaves simple tokens alone and quotes the arg with a space.
    assert.deepEqual(args, [
      "/d",
      "/s",
      "/c",
      'opentoken wrap my-cli --prompt "p with space" --flag',
    ]);
  } else {
    // non-win32: command becomes the opentoken command, args are ['wrap', cmd, ...args].
    assert.equal(command, "opentoken");
    assert.equal(args[0], "wrap");
    assert.equal(args[1], ORIGINAL_COMMAND);
    assert.deepEqual(args.slice(2), ORIGINAL_ARGS);
  }

  assert.equal(result.accepted, true);
});

test("spawnLoggedCommand uses a custom opentokenCommand when provided", async () => {
  const calls = [];
  const result = await spawnLoggedCommand(
    ORIGINAL_COMMAND,
    ORIGINAL_ARGS,
    baseInput(),
    undefined,
    {
      opentoken: true,
      opentokenCommand: "ot-custom",
      createWriteStream: fakeCreateWriteStream,
      spawn: (command, args) => {
        calls.push({ command, args });
        return makeChild();
      },
    },
  );

  assert.equal(calls.length, 1);
  const { command, args } = calls[0];

  if (process.platform === "win32") {
    assert.equal(command, process.env.ComSpec ?? "cmd.exe");
    // The custom command appears inside the inner cmd string instead of 'opentoken'.
    assert.equal(args[3], 'ot-custom wrap my-cli --prompt "p with space" --flag');
  } else {
    // The custom command is used directly as the spawned command.
    assert.equal(command, "ot-custom");
    assert.equal(args[0], "wrap");
    assert.equal(args[1], ORIGINAL_COMMAND);
  }

  assert.equal(result.accepted, true);
});

test("spawnLoggedCommand does not wrap when opentoken is not set", async () => {
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

  assert.equal(calls.length, 1);
  // Without opentoken the original command/args reach spawn untouched.
  assert.equal(calls[0].command, ORIGINAL_COMMAND);
  assert.deepEqual(calls[0].args, ORIGINAL_ARGS);
  assert.equal(result.accepted, true);
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

test("spawnLoggedCommand emits a structured heartbeat even without onProgress (OBS-101)", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
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
    const input = { ...baseInput(), timeoutMs: 120_000 }; // NO onProgress wired
    const promise = spawnLoggedCommand(ORIGINAL_COMMAND, ORIGINAL_ARGS, input, undefined, {
      createWriteStream: (path) =>
        path === input.stderrPath ? recordingWriteStream(stderrLogLines) : fakeWriteStream(),
      spawn: () => {
        openChild = makeOpenChild();
        return openChild;
      },
    });

    // Advance past one heartbeat interval (30s) so the interval callback runs.
    t.mock.timers.tick(30_000);

    // Structured machine-parseable heartbeat is emitted to process.stderr even
    // though no onProgress consumer is attached.
    const heartbeatLine = stderrWrites.find((line) => {
      try {
        return JSON.parse(line).type === "provider_heartbeat";
      } catch {
        return false;
      }
    });
    assert.ok(heartbeatLine, "expected a structured provider_heartbeat stderr line");
    const parsed = JSON.parse(heartbeatLine);
    assert.equal(parsed.runId, "RUN-1");
    assert.equal(typeof parsed.elapsedMs, "number");

    // The human "[provider] ... still running" line is still written to the
    // per-run stderr log unconditionally.
    assert.ok(
      stderrLogLines.some((line) => line.includes("still running")),
      "expected the human still-running line in the stderr log",
    );

    openChild.settle();
    const result = await promise;
    assert.equal(result.accepted, true);
  } finally {
    process.stderr.write = originalStderrWrite;
    t.mock.timers.reset();
  }
});

test("spawnLoggedCommand fires both the structured heartbeat and onProgress when wired (OBS-101)", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  const stderrWrites = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  };

  const progressEvents = [];
  let openChild;
  try {
    const input = {
      ...baseInput(),
      timeoutMs: 120_000,
      onProgress: (event) => progressEvents.push(event),
    };
    const promise = spawnLoggedCommand(ORIGINAL_COMMAND, ORIGINAL_ARGS, input, undefined, {
      createWriteStream: fakeCreateWriteStream,
      spawn: () => {
        openChild = makeOpenChild();
        return openChild;
      },
    });

    t.mock.timers.tick(30_000);

    assert.ok(
      stderrWrites.some((line) => {
        try {
          return JSON.parse(line).type === "provider_heartbeat";
        } catch {
          return false;
        }
      }),
      "expected the structured stderr heartbeat",
    );
    assert.ok(
      progressEvents.some((event) => event.type === "heartbeat"),
      "expected an onProgress heartbeat callback",
    );

    openChild.settle();
    const result = await promise;
    assert.equal(result.accepted, true);
  } finally {
    process.stderr.write = originalStderrWrite;
    t.mock.timers.reset();
  }
});
