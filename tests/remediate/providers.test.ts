import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnLoggedCommand } from "audit-tools/shared";
import { resolveFreshSessionProviderName } from "../../src/remediate/providers/index.js";
import type { LaunchFreshSessionInput } from "../../src/remediate/providers/types.js";
import type { WriteStream } from "node:fs";
import { createClaudeCodeProvider } from "../../src/remediate/providers/claudeCodeProvider.js";
import { createOpenCodeProvider } from "../../src/remediate/providers/opencodeProvider.js";
import {
  SubprocessTemplateProvider,
  WorkerCommandProvider,
  quoteForCmd,
} from "audit-tools/shared";

function expectedShellQuoted(value: string): string {
  if (process.platform === "win32") {
    return quoteForCmd(value);
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
import { createRemediationWorkerTask } from "../../src/remediate/phases/workerTasks.js";

function makeInput(
  overrides: Partial<LaunchFreshSessionInput> = {},
): LaunchFreshSessionInput {
  return {
    repoRoot: "/tmp",
    runId: "test-run",
    obligationId: "F-001",
    promptPath: "/tmp/prompt.md",
    taskPath: "/tmp/task.json",
    resultPath: "/tmp/result.json",
    stdoutPath: "/tmp/stdout.txt",
    stderrPath: "/tmp/stderr.txt",
    uiMode: "headless",
    timeoutMs: 5000,
    ...overrides,
  };
}

function makeWriteStream(): WriteStream {
  // The shared spawnLoggedCommand awaits write/end completion callbacks before
  // settling (flush-before-settle correctness), so the mock must invoke them.
  const stream = {
    write: (_chunk: any, cb?: any) => {
      if (typeof cb === "function") cb();
      return true;
    },
    end: (cb?: any) => {
      if (typeof cb === "function") cb();
      return stream as any;
    },
    on: (_event: string, _cb: any) => stream as any,
  };
  return stream as unknown as WriteStream;
}

function makeSpawnMock(
  exitCode: number | null,
  exitSignal: string | null = null,
) {
  return (_cmd: string, _args: string[], _opts: any): any => {
    const child: any = new EventEmitter();
    child.pid = 9999;
    child.killed = false;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (sig: string) => {
      child.killed = true;
      process.nextTick(() => {
        child.emit("exit", exitCode, exitSignal);
        child.emit("close", exitCode, exitSignal);
      });
    };
    return child;
  };
}

async function withProviderFiles(
  fn: (paths: {
    dir: string;
    input: LaunchFreshSessionInput;
    prompt: string;
  }) => Promise<void>,
  workerCommand?: string[],
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "provider-launch-"));
  const prompt = "large prompt body";
  try {
    const promptPath = join(dir, "prompt.md");
    const taskPath = join(dir, "task.json");
    await writeFile(promptPath, prompt, "utf8");
    const task = createRemediationWorkerTask({
      runId: "test-run",
      options: { root: dir, artifactsDir: dir },
      obligationId: "F-001",
      preferredExecutor: "test",
      resultPath: join(dir, "result.json"),
      timeoutMs: 1234,
      ...(workerCommand !== undefined ? { workerCommand } : {}),
    });
    await writeFile(taskPath, JSON.stringify(task), "utf8");
    await fn({
      dir,
      prompt,
      input: makeInput({
        repoRoot: dir,
        promptPath,
        taskPath,
        resultPath: join(dir, "result.json"),
        stdoutPath: join(dir, "stdout.txt"),
        stderrPath: join(dir, "stderr.txt"),
        timeoutMs: 5000,
      }),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("spawnLoggedCommand", () => {
  it("resolves with accepted:true when process exits with code 0 normally", async () => {
    const mockSpawn = (_cmd: string, _args: string[], _opts: any): any => {
      const child: any = new EventEmitter();
      child.pid = 1234;
      child.killed = false;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    };

    const result = await spawnLoggedCommand(
      "node",
      ["-e", ""],
      makeInput({ timeoutMs: 5000 }),
      undefined,
      {
        spawn: mockSpawn,
        createWriteStream: () => makeWriteStream(),
        killGraceMs: 50,
      },
    );

    expect(result.accepted).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("rejects when process times out and exits with code 0 (COR-001 fix)", async () => {
    // A process that receives SIGTERM and exits cleanly with code 0
    // should still be treated as a timeout, not a success.
    const result = spawnLoggedCommand(
      "sleep",
      ["100"],
      makeInput({ timeoutMs: 20 }),
      undefined,
      {
        spawn: makeSpawnMock(0, null),
        createWriteStream: () => makeWriteStream(),
        killGraceMs: 50,
      },
    );

    await expect(result).rejects.toThrow(/timed out/i);
  });

  it("rejects when process times out and exits with non-zero code", async () => {
    const result = spawnLoggedCommand(
      "sleep",
      ["100"],
      makeInput({ timeoutMs: 20 }),
      undefined,
      {
        spawn: makeSpawnMock(1, null),
        createWriteStream: () => makeWriteStream(),
        killGraceMs: 50,
      },
    );

    await expect(result).rejects.toThrow(/timed out/i);
  });

  it("calls onProgress with output events for stdout lines", async () => {
    const updates: any[] = [];
    const mockSpawn = (_cmd: string, _args: string[], _opts: any): any => {
      const child: any = new EventEmitter();
      child.pid = 5555;
      child.killed = false;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      process.nextTick(() => {
        child.stdout.emit("data", Buffer.from("line one\nline two\n"));
        process.nextTick(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      });
      return child;
    };

    await spawnLoggedCommand(
      "node",
      ["-e", ""],
      makeInput({
        timeoutMs: 5000,
        onProgress: (update) => updates.push(update),
      }),
      undefined,
      {
        spawn: mockSpawn,
        createWriteStream: () => makeWriteStream(),
      },
    );

    expect(updates).toHaveLength(2);
    expect(updates[0].type).toBe("output");
    expect(updates[0].message).toBe("line one");
    expect(updates[0].runId).toBe("test-run");
    expect(updates[1].message).toBe("line two");
  });
});

describe("resolveFreshSessionProviderName", () => {
  it("returns the requested name directly when not 'auto'", () => {
    expect(resolveFreshSessionProviderName("claude-code", {})).toBe(
      "claude-code",
    );
    expect(resolveFreshSessionProviderName("opencode", {})).toBe("opencode");
    expect(resolveFreshSessionProviderName("worker-command", {})).toBe(
      "worker-command",
    );
  });

  it("uses sessionConfig.provider when name is undefined", () => {
    expect(
      resolveFreshSessionProviderName(undefined, { provider: "claude-code" }),
    ).toBe("claude-code");
  });

  it("defaults to worker-command when name is undefined and no config", () => {
    expect(resolveFreshSessionProviderName(undefined, {})).toBe(
      "worker-command",
    );
  });

  it("resolves auto to worker-command when no capable provider is found", () => {
    const result = resolveFreshSessionProviderName(
      "auto",
      {},
      {
        env: {},
        commandExists: () => false,
      },
    );
    expect(result).toBe("worker-command");
  });

  it("resolves auto to worker-command when inside ClaudeCode even if claude is available", () => {
    const result = resolveFreshSessionProviderName(
      "auto",
      {},
      {
        env: { CLAUDECODE: "1" },
        commandExists: (cmd) => cmd === "claude",
      },
    );
    expect(result).toBe("worker-command");
  });

  it("resolves auto to opencode when running inside an opencode session", () => {
    const result = resolveFreshSessionProviderName(
      "auto",
      {},
      {
        env: { OPENCODE: "1" },
        commandExists: () => false,
      },
    );
    expect(result).toBe("opencode");
  });

  it("resolves auto to vscode-task when in VSCode and template is configured", () => {
    const result = resolveFreshSessionProviderName(
      "auto",
      {
        vscode_task: { command_template: ["some", "command"] },
      },
      {
        env: { TERM_PROGRAM: "vscode" },
        commandExists: () => false,
      },
    );
    expect(result).toBe("vscode-task");
  });
});

describe("createRemediationWorkerTask", () => {
  it("does not include worker_command field", () => {
    const task = createRemediationWorkerTask({
      runId: "RUN-1",
      options: { root: "/repo", artifactsDir: "/repo/.audit-tools/remediation" },
      obligationId: "F-001",
      preferredExecutor: "worker-command",
      resultPath: "/repo/.audit-tools/remediation/result.json",
    });

    expect(Object.prototype.hasOwnProperty.call(task, "worker_command")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(task, "worker_command_mode")).toBe(false);
  });
});

describe("provider launch methods", () => {
  it("ClaudeCodeProvider sends prompt through stdin and honors task timeout", async () => {
    const savedClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;
    try {
    await withProviderFiles(async ({ input, prompt }) => {
      const calls: any[] = [];
      const provider = createClaudeCodeProvider(
        { command: "claude-test", extra_args: ["--json"] },
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
      );

      await provider.launch(input);

      expect(calls[0].command).toBe("claude-test");
      expect(calls[0].args).toEqual([
        "-p",
        "--json",
        "--dangerously-skip-permissions",
      ]);
      expect(calls[0].args).not.toContain(prompt);
      expect(calls[0].launchInput.stdinText).toBe(prompt);
      expect(calls[0].launchInput.timeoutMs).toBe(1234);
    });
    } finally {
      if (savedClaudeCode !== undefined) process.env.CLAUDECODE = savedClaudeCode;
    }
  });

  it("ClaudeCodeProvider omits --dangerously-skip-permissions when explicitly disabled", async () => {
    const savedClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;
    try {
      await withProviderFiles(async ({ input }) => {
        const calls: any[] = [];
        const provider = createClaudeCodeProvider(
          { command: "claude-test", dangerously_skip_permissions: false },
          async (command, args, launchInput) => {
            calls.push({ command, args, launchInput });
            return { accepted: true, exitCode: 0 };
          },
        );

        await provider.launch(input);

        expect(calls[0].args).not.toContain("--dangerously-skip-permissions");
      });
    } finally {
      if (savedClaudeCode !== undefined) process.env.CLAUDECODE = savedClaudeCode;
    }
  });

  it("OpenCodeProvider sends prompt through stdin and honors task timeout", async () => {
    await withProviderFiles(async ({ input, prompt }) => {
      const calls: any[] = [];
      const provider = createOpenCodeProvider(
        { command: "opencode-test", extra_args: ["--model", "x"] },
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
      );

      // opencode only runs conversationally (uiMode "visible"); headless is gated.
      await provider.launch({ ...input, uiMode: "visible" });

      // A custom command name is not a recognized launcher, so it is spawned
      // directly on every platform (no cmd.exe wrapping).
      expect(calls[0].command).toBe("opencode-test");
      expect(calls[0].args).toEqual(["run", "--model", "x"]);
      expect(calls[0].args).not.toContain(prompt);
      expect(calls[0].launchInput.stdinText).toBe(prompt);
      expect(calls[0].launchInput.timeoutMs).toBe(1234);
    });
  });

  it("PB-1: OpenCodeProvider.launch with uiMode 'headless' fast-fails before spawning (no GUI / no stdin hang)", async () => {
    await withProviderFiles(async ({ input }) => {
      const calls: any[] = [];
      const provider = createOpenCodeProvider({}, async (command, args, launchInput) => {
        calls.push({ command, args, launchInput });
        return { accepted: true, exitCode: 0 };
      });

      // makeInput defaults uiMode to "headless"; assert the gate rejects with an
      // actionable error and that the launcher was NEVER invoked (no spawn, so no
      // GUI pop, no blocking read on stdin).
      await expect(
        provider.launch({ ...input, uiMode: "headless" }),
      ).rejects.toThrow(/opencode cannot run headless/i);
      expect(calls.length).toBe(0);
    });
  });

  it("OpenCodeProvider routes the default opencode launcher through the Windows cmd shim", async () => {
    await withProviderFiles(async ({ input, prompt }) => {
      const calls: any[] = [];
      // No explicit command → defaults to "opencode", a recognized launcher.
      const provider = createOpenCodeProvider(
        {},
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
      );

      // opencode only runs conversationally (uiMode "visible"); headless is gated.
      await provider.launch({ ...input, uiMode: "visible" });

      if (process.platform === "win32") {
        // On Windows the opencode `.cmd` shim is wrapped through cmd.exe.
        expect(calls[0].command).toBe(process.env.ComSpec ?? "cmd.exe");
        expect(calls[0].args).toEqual(["/d", "/s", "/c", "opencode run"]);
      } else {
        expect(calls[0].command).toBe("opencode");
        expect(calls[0].args).toEqual(["run"]);
      }
      // The prompt is piped via stdin regardless of platform.
      expect(calls[0].launchInput.stdinText).toBe(prompt);
    });
  });

  it("SubprocessTemplateProvider quotes embedded placeholders and routes unknown placeholder to RunLogger", async () => {
    await withProviderFiles(async ({ input, dir }) => {
      const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { tmpdir } = await import("node:os");
      const { RunLogger } = await import("audit-tools/shared");
      const logDir = mkdtempSync(join(tmpdir(), "stp-remediate-test-"));
      const logPath = join(logDir, "run.log");
      const logger = new RunLogger(logPath);

      const calls: any[] = [];
      const provider = new SubprocessTemplateProvider(
        {
          command_template: [
            "sh",
            "-lc",
            "tool --root={repoRoot} --missing={unknown}",
          ],
        },
        "custom-template",
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
        logger,
      );

      await provider.launch(input);

      expect(calls[0].command).toBe("sh");
      expect(calls[0].args[1]).toContain(`--root=${expectedShellQuoted(dir)}`);
      expect(calls[0].launchInput.timeoutMs).toBe(1234);

      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      expect(lines.length).toBe(1);
      const event = JSON.parse(lines[0]);
      expect(event.kind).toBe("error");
      expect(event.provider).toBe("custom-template");
      expect(event.note).toContain("applyTemplate: unknown placeholder {unknown}");
      expect(event.note).toContain("runId=test-run");
      expect(event.note).toContain("taskPath=");

      rmSync(logDir, { recursive: true, force: true });
    });
  });

  it("SubprocessTemplateProvider (vscode-task name) delegates launch through the template", async () => {
    await withProviderFiles(async ({ input }) => {
      const calls: any[] = [];
      const provider = new SubprocessTemplateProvider(
        { command_template: ["cmd", "{taskPath}"] },
        "vscode-task",
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
      );

      await provider.launch(input);

      expect(calls[0].command).toBe("cmd");
      expect(calls[0].args).toEqual([input.taskPath]);
      expect(calls[0].launchInput.timeoutMs).toBe(1234);
    });
  });

  it("WorkerCommandProvider launches task.worker_command with task timeout", async () => {
    await withProviderFiles(async ({ input }) => {
      const calls: any[] = [];
      const provider = new WorkerCommandProvider(
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
      );

      await provider.launch(input);

      expect(calls.length).toBe(1);
      expect(calls[0].command).toBe("node");
      expect(calls[0].args).toEqual(["worker.js"]);
      expect(calls[0].launchInput.timeoutMs).toBe(1234);
    }, ["node", "worker.js"]);
  });

  it("WorkerCommandProvider throws MISSING_WORKER_COMMAND_MESSAGE when task has no worker_command", async () => {
    await withProviderFiles(async ({ input }) => {
      const provider = new WorkerCommandProvider(
        async () => ({ accepted: true, exitCode: 0 }),
      );

      await expect(provider.launch(input)).rejects.toThrow(
        /worker-command provider requires task\.worker_command/i,
      );
    });
  });
});
