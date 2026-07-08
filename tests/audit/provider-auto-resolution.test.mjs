import { test, expect } from "vitest";

const { resolveFreshSessionProviderName } =
  await import("../../src/audit/providers/index.ts");

test("omitted provider defaults to worker-command even when external CLIs are available", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    {},
    {
      commandExists: () => true,
      env: {},
    },
  );

  expect(provider).toBe("worker-command");
});

test("provider auto falls back to worker-command when no configured bridge or external provider is available", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    { provider: "auto" },
    {
      commandExists: () => false,
      env: {},
    },
  );

  expect(provider).toBe("worker-command");
});

test("omitted provider does not auto-detect; active Claude Code session falls back to worker-command", () => {
  // Bare `undefined` no longer triggers detection — it defaults to worker-command.
  expect(resolveFreshSessionProviderName(
      undefined,
      {},
      {
        commandExists: () => false,
        env: { CLAUDECODE: "1" },
      },
    )).toBe("worker-command");
  // Even under explicit auto, a fresh `claude` cannot be spawned from inside a
  // Claude Code session: although the `claude` CLI exists, the inside-claude
  // guard forces it unavailable, so auto-resolution falls through to
  // worker-command (no other provider is available here).
  expect(resolveFreshSessionProviderName(
      undefined,
      { provider: "auto" },
      {
        commandExists: (command) => command === "claude",
        env: { CLAUDECODE: "1" },
      },
    )).toBe("worker-command");
});

test("explicit worker-command is honored over an active OpenCode session; auto detects it", () => {
  // An explicit provider choice is never overridden by environment detection.
  expect(resolveFreshSessionProviderName(
      undefined,
      { provider: "worker-command" },
      {
        commandExists: () => false,
        env: { OPENCODE: "1" },
      },
    )).toBe("worker-command");
  // Auto-resolution does detect an active OpenCode session.
  expect(resolveFreshSessionProviderName(
      undefined,
      { provider: "auto" },
      {
        commandExists: () => false,
        env: { OPENCODE: "1" },
      },
    )).toBe("opencode");
});

test("provider auto selects vscode-task when running under VS Code and a vscode task template is configured", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    {
      provider: "auto",
      vscode_task: {
        command_template: ["pwsh", "-Command", "{workerCommandShell}"],
      },
    },
    {
      commandExists: () => false,
      env: { TERM_PROGRAM: "vscode" },
    },
  );

  expect(provider).toBe("vscode-task");
});

test("provider auto selects subprocess-template when a generic launcher bridge is configured", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    {
      provider: "auto",
      subprocess_template: {
        command_template: ["bash", "-lc", "{workerCommandShell}"],
      },
    },
    {
      commandExists: () => false,
      env: {},
    },
  );

  expect(provider).toBe("subprocess-template");
});

test("provider auto selects Claude Code when Claude is available and OpenCode is not", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    { provider: "auto" },
    {
      commandExists: (command) => command === "claude",
      env: {},
    },
  );

  expect(provider).toBe("claude-code");
});

test("PB-1: bare-PATH OpenCode (no config, no Claude) is NOT auto-selected; falls through to worker-command", () => {
  // A detected-on-PATH opencode is OPT-IN — it must never be auto-selected for a
  // real run on bare availability. With neither claude nor configured-opencode,
  // resolution falls through to worker-command rather than launching opencode
  // unprompted.
  const provider = resolveFreshSessionProviderName(
    undefined,
    { provider: "auto" },
    {
      commandExists: (command) => command === "opencode",
      env: {},
    },
  );

  expect(provider).toBe("worker-command");
});

test("PB-1: configured OpenCode is still auto-selected when on PATH (opt-in preserved)", () => {
  // The config-gated rung remains: explicitly-configured opencode is honored.
  const provider = resolveFreshSessionProviderName(
    undefined,
    { provider: "auto", opencode: { command: "opencode" } },
    {
      commandExists: (command) => command === "opencode",
      env: {},
    },
  );

  expect(provider).toBe("opencode");
});

test("provider auto prefers a configured Claude Code adapter when both external CLIs are available", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    {
      provider: "auto",
      claude_code: {
        extra_args: ["--model", "sonnet"],
      },
    },
    {
      commandExists: (command) =>
        command === "claude" || command === "opencode",
      env: {},
    },
  );

  expect(provider).toBe("claude-code");
});

test("provider auto prefers a configured OpenCode adapter when both external CLIs are available", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    {
      provider: "auto",
      opencode: {
        extra_args: ["--model", "anthropic/claude-sonnet-4.5"],
      },
    },
    {
      commandExists: (command) =>
        command === "claude" || command === "opencode",
      env: {},
    },
  );

  expect(provider).toBe("opencode");
});

test("explicit provider selection still wins over auto resolution logic", () => {
  const provider = resolveFreshSessionProviderName(
    "worker-command",
    {
      provider: "auto",
      claude_code: {
        extra_args: ["--model", "sonnet"],
      },
    },
    {
      commandExists: () => true,
      env: { TERM_PROGRAM: "vscode" },
    },
  );

  expect(provider).toBe("worker-command");
});
