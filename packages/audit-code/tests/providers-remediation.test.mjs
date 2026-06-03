import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

const {
  ACTIVE_CLAUDE_CODE_SESSION_MESSAGE,
  ClaudeCodeProvider,
} = await import("../src/providers/claudeCodeProvider.ts");
const {
  LocalSubprocessProvider,
  MISSING_WORKER_COMMAND_MESSAGE,
} = await import("@audit-tools/shared");
const { spawnLoggedCommand } = await import(
  "@audit-tools/shared/providers/spawnLoggedCommand"
);

async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function buildLaunchInput(root, overrides = {}) {
  return {
    repoRoot: root,
    runId: "run-1",
    obligationId: "audit_tasks_completed",
    promptPath: join(root, "prompt.txt"),
    taskPath: join(root, "task.json"),
    resultPath: join(root, "result.json"),
    stdoutPath: join(root, "stdout.log"),
    stderrPath: join(root, "stderr.log"),
    uiMode: "headless",
    timeoutMs: 50,
    ...overrides,
  };
}

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.pid = 4242;
    this.killed = false;
    this.killSignals = [];
  }

  kill(signal) {
    this.killSignals.push(signal);
    if (signal === "SIGKILL") {
      this.killed = true;
      setImmediate(() => {
        this.emit("exit", null, "SIGKILL");
        this.emit("close", null, "SIGKILL");
      });
    }
    return true;
  }
}

test("ClaudeCodeProvider rejects nested Claude Code sessions with the shared guidance message", async () => {
  const original = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";

  try {
    const provider = new ClaudeCodeProvider();
    await assert.rejects(
      () => provider.launch(buildLaunchInput(process.cwd())),
      new RegExp(ACTIVE_CLAUDE_CODE_SESSION_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDECODE;
    } else {
      process.env.CLAUDECODE = original;
    }
  }
});

test("ClaudeCodeProvider reads the prompt and forwards the expected command arguments", async () => {
  const savedClaude = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;
  try {
  await withTempDir("audit-code-claude-provider-", async (root) => {
    const input = buildLaunchInput(root);
    await writeFile(input.promptPath, "Audit this repo", "utf8");
    await writeFile(
      input.taskPath,
      JSON.stringify({ worker_command: ["claude"], timeout_ms: 12345 }),
      "utf8",
    );

    const launches = [];
    const provider = new ClaudeCodeProvider(
      { command: "claude-bin", extra_args: ["--model", "sonnet"] },
      async (command, args, passedInput) => {
        launches.push({ command, args, passedInput });
        return { accepted: true, exitCode: 0, signal: null };
      },
    );

    const result = await provider.launch(input);
    assert.equal(result.accepted, true);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].command, "claude-bin");
    assert.deepEqual(launches[0].args, [
      "-p",
      "Audit this repo",
      "--model",
      "sonnet",
    ]);
    // The launch input is forwarded with the task's per-task timeout applied.
    assert.equal(launches[0].passedInput.promptPath, input.promptPath);
    assert.equal(launches[0].passedInput.timeoutMs, 12345);
  });
  } finally {
    if (savedClaude === undefined) {
      delete process.env.CLAUDECODE;
    } else {
      process.env.CLAUDECODE = savedClaude;
    }
  }
});

test("ClaudeCodeProvider only skips permissions when explicitly configured", async () => {
  const savedClaude = process.env.CLAUDECODE;
  delete process.env.CLAUDECODE;
  try {
    await withTempDir("audit-code-claude-provider-permissions-", async (root) => {
      const input = buildLaunchInput(root);
      await writeFile(input.promptPath, "Audit this repo", "utf8");
      await writeFile(
        input.taskPath,
        JSON.stringify({ worker_command: ["claude"] }),
        "utf8",
      );

      const launches = [];
      const provider = new ClaudeCodeProvider(
        { command: "claude-bin", dangerously_skip_permissions: true },
        async (command, args, passedInput) => {
          launches.push({ command, args, passedInput });
          return { accepted: true, exitCode: 0, signal: null };
        },
      );

      await provider.launch(input);
      assert.deepEqual(launches[0].args, [
        "-p",
        "Audit this repo",
        "--dangerously-skip-permissions",
      ]);
    });
  } finally {
    if (savedClaude === undefined) {
      delete process.env.CLAUDECODE;
    } else {
      process.env.CLAUDECODE = savedClaude;
    }
  }
});

test("LocalSubprocessProvider rejects tasks without worker_command", async () => {
  await withTempDir("audit-code-local-provider-empty-", async (root) => {
    const input = buildLaunchInput(root);
    await writeFile(
      input.taskPath,
      JSON.stringify({ worker_command: [] }, null, 2),
      "utf8",
    );

    const provider = new LocalSubprocessProvider();
    await assert.rejects(
      () => provider.launch(input),
      new RegExp(MISSING_WORKER_COMMAND_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });
});

test("LocalSubprocessProvider forwards worker_command through the launcher", async () => {
  await withTempDir("audit-code-local-provider-", async (root) => {
    const input = buildLaunchInput(root);
    await writeFile(
      input.taskPath,
      JSON.stringify(
        {
          worker_command: ["node", "--test", "tests/sample.test.mjs"],
          timeout_ms: 6000,
        },
        null,
        2,
      ),
      "utf8",
    );

    const launches = [];
    const provider = new LocalSubprocessProvider(async (command, args, passedInput) => {
      launches.push({ command, args, passedInput });
      return { accepted: true, exitCode: 0, signal: null };
    });

    const result = await provider.launch(input);
    assert.equal(result.accepted, true);
    assert.equal(launches.length, 1);
    assert.equal(launches[0].command, "node");
    assert.deepEqual(launches[0].args, ["--test", "tests/sample.test.mjs"]);
    // The launch input is forwarded with the task's per-task timeout applied.
    assert.equal(launches[0].passedInput.repoRoot, input.repoRoot);
    assert.equal(launches[0].passedInput.timeoutMs, 6000);
  });
});

test("spawnLoggedCommand captures stdout/stderr logs for successful processes", async () => {
  await withTempDir("audit-code-spawn-success-", async (root) => {
    const input = buildLaunchInput(root, { timeoutMs: 500 });
    const result = await spawnLoggedCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write('out'); process.stderr.write('err');",
      ],
      input,
    );

    assert.equal(result.accepted, true);
    assert.equal(result.exitCode, 0);
    assert.match(await readFile(input.stdoutPath, "utf8"), /out/);
    assert.match(await readFile(input.stderrPath, "utf8"), /err/);
  });
});

test("spawnLoggedCommand reports nonzero exits with launch diagnostics", async () => {
  await withTempDir("audit-code-spawn-nonzero-", async (root) => {
    const input = buildLaunchInput(root, { timeoutMs: 500 });
    const result = await spawnLoggedCommand(
      process.execPath,
      ["-e", "process.stderr.write('boom'); process.exit(7);"],
      input,
    );

    assert.equal(result.accepted, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.signal, null);
    assert.match(result.command, /node/i);
    assert.equal(result.stdoutPath, input.stdoutPath);
    assert.equal(result.stderrPath, input.stderrPath);
    assert.match(await readFile(input.stderrPath, "utf8"), /boom/);
  });
});

test("spawnLoggedCommand waits for close before ending logs", async () => {
  await withTempDir("audit-code-spawn-close-", async (root) => {
    const input = buildLaunchInput(root, { timeoutMs: 500 });
    const child = new FakeChildProcess();
    const stdoutLog = new PassThrough();
    const stderrLog = new PassThrough();
    const writes = [];
    stdoutLog.write = (chunk, callback) => {
      writes.push(String(chunk));
      setImmediate(callback);
      return true;
    };

    const promise = spawnLoggedCommand("fake", [], input, undefined, {
      spawn: () => child,
      createWriteStream: (path) =>
        path === input.stdoutPath ? stdoutLog : stderrLog,
    });

    child.stdout.write("tail");
    child.emit("exit", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stdoutLog.writableEnded, false);
    child.emit("close", 0, null);

    const result = await promise;
    assert.equal(result.accepted, true);
    assert.deepEqual(writes, ["tail"]);
    assert.equal(stdoutLog.writableEnded, true);
  });
});

test("spawnLoggedCommand escalates from SIGTERM to SIGKILL when a timed out child does not exit", async () => {
  await withTempDir("audit-code-spawn-timeout-", async (root) => {
    const input = buildLaunchInput(root, { timeoutMs: 20 });
    const child = new FakeChildProcess();

    await assert.rejects(
      () =>
        spawnLoggedCommand("fake", [], input, undefined, {
          spawn: () => child,
          createWriteStream: () => new PassThrough(),
          killGraceMs: 10,
        }),
      /Fresh session timed out after 20ms for run run-1/i,
    );

    assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  });
});

test("spawnLoggedCommand rejects on log stream failures and tears down the child", async () => {
  await withTempDir("audit-code-spawn-log-error-", async (root) => {
    const input = buildLaunchInput(root, { timeoutMs: 200 });
    const child = new FakeChildProcess();
    const firstStream = new PassThrough();
    const secondStream = new PassThrough();
    const streams = [firstStream, secondStream];

    setImmediate(() => {
      firstStream.emit("error", new Error("disk full"));
    });

    await assert.rejects(
      () =>
        spawnLoggedCommand("fake", [], input, undefined, {
          spawn: () => child,
          createWriteStream: () => streams.shift() ?? new PassThrough(),
          killGraceMs: 10,
        }),
      /disk full/i,
    );

    assert.deepEqual(child.killSignals, ["SIGKILL"]);
  });
});
