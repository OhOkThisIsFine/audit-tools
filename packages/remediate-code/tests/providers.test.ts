import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnLoggedCommand } from "@audit-tools/shared";
import { resolveFreshSessionProviderName } from "../src/providers/index.js";
import { usesDeferredWorkerCommand } from "../src/types/workerSession.js";
import type { LaunchFreshSessionInput } from "../src/providers/types.js";
import type { WriteStream } from "node:fs";
import { ClaudeCodeProvider } from "../src/providers/claudeCodeProvider.js";
import { OpenCodeProvider } from "../src/providers/opencodeProvider.js";
import { SubprocessTemplateProvider } from "../src/providers/subprocessTemplateProvider.js";
import { VSCodeTaskProvider } from "../src/providers/vscodeTaskProvider.js";
import { LocalSubprocessProvider } from "../src/providers/localSubprocessProvider.js";
import { quoteForCmd } from "../src/utils/commands.js";

function expectedShellQuoted(value: string): string {
  if (process.platform === "win32") {
    return quoteForCmd(value);
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
import { createRemediationWorkerTask } from "../src/phases/workerTasks.js";

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
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "provider-launch-"));
  const prompt = "large prompt body";
  try {
    const promptPath = join(dir, "prompt.md");
    const taskPath = join(dir, "task.json");
    await writeFile(promptPath, prompt, "utf8");
    await writeFile(
      taskPath,
      JSON.stringify({
        contract_version: "remediation-worker/v1alpha1",
        run_id: "test-run",
        repo_root: dir,
        artifacts_dir: dir,
        obligation_id: "F-001",
        preferred_executor: "test",
        result_path: join(dir, "result.json"),
        worker_command: ["node", "worker.js"],
        timeout_ms: 1234,
      }),
      "utf8",
    );
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
    expect(resolveFreshSessionProviderName("local-subprocess", {})).toBe(
      "local-subprocess",
    );
  });

  it("uses sessionConfig.provider when name is undefined", () => {
    expect(
      resolveFreshSessionProviderName(undefined, { provider: "claude-code" }),
    ).toBe("claude-code");
  });

  it("defaults to local-subprocess when name is undefined and no config", () => {
    expect(resolveFreshSessionProviderName(undefined, {})).toBe(
      "local-subprocess",
    );
  });

  it("resolves auto to local-subprocess when no capable provider is found", () => {
    const result = resolveFreshSessionProviderName(
      "auto",
      {},
      {
        env: {},
        commandExists: () => false,
      },
    );
    expect(result).toBe("local-subprocess");
  });

  it("resolves auto to local-subprocess when inside ClaudeCode even if claude is available", () => {
    const result = resolveFreshSessionProviderName(
      "auto",
      {},
      {
        env: { CLAUDECODE: "1" },
        commandExists: (cmd) => cmd === "claude",
      },
    );
    expect(result).toBe("local-subprocess");
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

describe("usesDeferredWorkerCommand", () => {
  it("returns true when worker_command_mode is 'deferred'", () => {
    expect(usesDeferredWorkerCommand({ worker_command_mode: "deferred" })).toBe(
      true,
    );
  });

  it("returns true when skip_worker_command is true (legacy compatibility)", () => {
    expect(usesDeferredWorkerCommand({ skip_worker_command: true })).toBe(true);
  });

  it("returns false when worker_command_mode is 'run'", () => {
    expect(usesDeferredWorkerCommand({ worker_command_mode: "run" })).toBe(
      false,
    );
  });

  it("returns false when both fields are absent", () => {
    expect(usesDeferredWorkerCommand({})).toBe(false);
  });

  it("returns false when skip_worker_command is false", () => {
    expect(usesDeferredWorkerCommand({ skip_worker_command: false })).toBe(
      false,
    );
  });
});

describe("createRemediationWorkerTask", () => {
  it("defaults to the global remediate-code MCP bridge, not a relative dist command", () => {
    const task = createRemediationWorkerTask({
      runId: "RUN-1",
      options: { root: "/repo", artifactsDir: "/repo/.remediation-artifacts" },
      obligationId: "F-001",
      preferredExecutor: "local-subprocess",
      resultPath: "/repo/.remediation-artifacts/result.json",
    });

    expect(task.worker_command).toEqual(["remediate-code", "mcp"]);
    expect(task.worker_command.join(" ")).not.toContain("dist/index.js");
  });
});

describe("provider launch methods", () => {
  it("ClaudeCodeProvider sends prompt through stdin and honors task timeout", async () => {
    const savedClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;
    try {
    await withProviderFiles(async ({ input, prompt }) => {
      const calls: any[] = [];
      const provider = new ClaudeCodeProvider(
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

  it("OpenCodeProvider sends prompt through stdin and honors task timeout", async () => {
    await withProviderFiles(async ({ input, prompt }) => {
      const calls: any[] = [];
      const provider = new OpenCodeProvider(
        { command: "opencode-test", extra_args: ["--model", "x"] },
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
      );

      await provider.launch(input);

      expect(calls[0].command).toBe("opencode-test");
      expect(calls[0].args).toEqual(["run", "--model", "x"]);
      expect(calls[0].args).not.toContain(prompt);
      expect(calls[0].launchInput.stdinText).toBe(prompt);
      expect(calls[0].launchInput.timeoutMs).toBe(1234);
    });
  });

  it("SubprocessTemplateProvider quotes embedded placeholders and includes warning context", async () => {
    await withProviderFiles(async ({ input, dir }) => {
      const calls: any[] = [];
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (message?: unknown) => warnings.push(String(message));
      try {
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
        );

        await provider.launch(input);

        expect(calls[0].command).toBe("sh");
        expect(calls[0].args[1]).toContain(`--root=${expectedShellQuoted(dir)}`);
        expect(calls[0].launchInput.timeoutMs).toBe(1234);
        expect(warnings[0]).toContain("provider=custom-template");
        expect(warnings[0]).toContain("runId=test-run");
        expect(warnings[0]).toContain("taskPath=");
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  it("VSCodeTaskProvider delegates launch through the subprocess template provider", async () => {
    await withProviderFiles(async ({ input }) => {
      const calls: any[] = [];
      const provider = new VSCodeTaskProvider(
        { command_template: ["cmd", "{taskPath}"] },
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

  it("LocalSubprocessProvider launches task.worker_command with task timeout", async () => {
    await withProviderFiles(async ({ input }) => {
      const calls: any[] = [];
      const provider = new LocalSubprocessProvider(
        async (command, args, launchInput) => {
          calls.push({ command, args, launchInput });
          return { accepted: true, exitCode: 0 };
        },
      );

      await provider.launch(input);

      expect(calls[0].command).toBe("node");
      expect(calls[0].args).toEqual(["worker.js"]);
      expect(calls[0].launchInput.timeoutMs).toBe(1234);
    });
  });
});
