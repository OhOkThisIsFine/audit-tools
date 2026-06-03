import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const { spawnLoggedCommand } = await import(
  "../dist/providers/spawnLoggedCommand.js"
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
