import test from "node:test";
import assert from "node:assert/strict";

const { resolveFreshSessionProviderName } =
  await import("../dist/providers/index.js");

test("omitted provider defaults to local-subprocess even when external CLIs are available", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    {},
    {
      commandExists: () => true,
      env: {},
    },
  );

  assert.equal(provider, "local-subprocess");
});

test("provider auto falls back to local-subprocess when no configured bridge or external provider is available", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    { provider: "auto" },
    {
      commandExists: () => false,
      env: {},
    },
  );

  assert.equal(provider, "local-subprocess");
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

  assert.equal(provider, "vscode-task");
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

  assert.equal(provider, "subprocess-template");
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

  assert.equal(provider, "claude-code");
});

test("provider auto selects OpenCode when OpenCode is available and Claude is not", () => {
  const provider = resolveFreshSessionProviderName(
    undefined,
    { provider: "auto" },
    {
      commandExists: (command) => command === "opencode",
      env: {},
    },
  );

  assert.equal(provider, "opencode");
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

  assert.equal(provider, "claude-code");
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

  assert.equal(provider, "opencode");
});

test("explicit provider selection still wins over auto resolution logic", () => {
  const provider = resolveFreshSessionProviderName(
    "local-subprocess",
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

  assert.equal(provider, "local-subprocess");
});
