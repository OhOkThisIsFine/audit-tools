import { test, expect } from "vitest";
import assert from "node:assert/strict";

const { resolveFreshSessionProviderName } =
  await import("../../src/audit/providers/index.ts");
const { assertHostProviderName } = await import("audit-tools/shared");

test("omitted provider defaults to worker-command even when external CLIs are available", () => {
  const deps = {
    commandExists: () => true,
    env: {},
  };
  expect(resolveFreshSessionProviderName(undefined, {}, deps)).toBe("worker-command");
  // Contrast oracle (TST-da398332): the SAME environment under explicit "auto"
  // resolves to a detected CLI — proving the omitted-provider case above is the
  // deliberate no-detection default, not detection that happened to find nothing.
  expect(resolveFreshSessionProviderName(undefined, { provider: "auto" }, deps)).toBe(
    "claude-code",
  );
});

test("COMPOSED selection+rejection: every auto-resolved provider is host-admissible (never claude-worker)", () => {
  // TST-da398332: the selection contract (auto-resolution) and the rejection
  // contract (assertHostProviderName refuses `claude-worker` as a host) were
  // only tested separately, which leaves their COMPOSITION unwitnessed: no
  // environment may auto-resolve to a name the host gate then rejects. Walk a
  // matrix spanning every priority rung and compose the two contracts.
  const contexts = [
    { config: {}, opts: { commandExists: () => false, env: {} } },
    { config: { provider: "auto" }, opts: { commandExists: () => false, env: {} } },
    { config: { provider: "auto" }, opts: { commandExists: () => true, env: {} } },
    { config: { provider: "auto" }, opts: { commandExists: () => false, env: { OPENCODE: "1" } } },
    { config: { provider: "auto" }, opts: { commandExists: () => false, env: { CODEX: "1" } } },
    {
      config: { provider: "auto", vscode_task: { command_template: ["pwsh", "-c", "{workerCommandShell}"] } },
      opts: { commandExists: () => false, env: { TERM_PROGRAM: "vscode" } },
    },
    {
      config: { provider: "auto", subprocess_template: { command_template: ["bash", "-lc", "{workerCommandShell}"] } },
      opts: { commandExists: () => false, env: {} },
    },
    {
      config: { provider: "auto", opencode: { command: "opencode" } },
      opts: { commandExists: (c) => c === "opencode", env: {} },
    },
    {
      config: { provider: "auto", openai_compatible: { base_url: "https://nim.test/v1", model: "m" } },
      opts: { commandExists: () => false, env: { CLAUDECODE: "1" } },
    },
    { config: { provider: "auto" }, opts: { commandExists: (c) => c === "claude", env: { CLAUDECODE: "1" } } },
    { config: { provider: "auto" }, opts: { commandExists: (c) => c === "codex", env: {} } },
    { config: { provider: "auto" }, opts: { commandExists: (c) => c === "agy", env: {} } },
  ];
  for (const { config, opts } of contexts) {
    const resolved = resolveFreshSessionProviderName(undefined, config, opts);
    expect(resolved, "auto-resolution must never select the source-pool-only claude-worker").not.toBe("claude-worker");
    assert.doesNotThrow(
      () => assertHostProviderName(resolved),
      `auto-resolved provider "${resolved}" (config=${JSON.stringify(config)}) must be accepted as a host provider`,
    );
  }
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

test("INV-SCC-01 (COR-849039de-2 / TST-da398332): headless auto-resolution never selects opencode, whose headless launch deterministically throws", async () => {
  // OpenCodeProvider.launch hard-fails any uiMode:"headless" input by design
  // (PB-1 guard: `opencode run` has no headless mode). Auto-resolution must
  // therefore never SELECT opencode for a headless run — selecting a provider
  // whose launch is guaranteed to throw is a resolution-layer defect even
  // though the failure is loud. Composed here through the shared factory seam
  // so the selection contract and the launch-rejection contract are witnessed
  // TOGETHER, not certified separately (the TST-da398332 gap).
  const { resolveFreshSessionProviderName: resolveShared } = await import(
    "audit-tools/shared"
  );

  // Inside an opencode session (top rung): a headless run must NOT resolve to
  // opencode — with nothing else available it falls through to worker-command.
  expect(
    resolveShared(undefined, { provider: "auto" }, {
      commandExists: () => false,
      env: { OPENCODE: "1" },
      uiMode: "headless",
    }),
  ).toBe("worker-command");

  // Config-gated rung: a VISIBLE (conversational) run still selects configured
  // opencode; the SAME configuration under headless must skip the rung.
  const cfg = { provider: "auto", opencode: { command: "opencode" } };
  const opts = { commandExists: (c) => c === "opencode", env: {} };
  expect(resolveShared(undefined, cfg, { ...opts, uiMode: "visible" })).toBe("opencode");
  expect(resolveShared(undefined, cfg, { ...opts, uiMode: "headless" })).toBe("worker-command");

  // With a headless-capable backend also configured, the headless run resolves
  // to IT rather than the guaranteed-throw opencode.
  expect(
    resolveShared(
      undefined,
      {
        provider: "auto",
        opencode: { command: "opencode" },
        openai_compatible: { base_url: "https://nim.test/v1", model: "m" },
      },
      { ...opts, uiMode: "headless" },
    ),
  ).toBe("openai-compatible");

  // Unspecified uiMode preserves the conversation-first default (unchanged
  // behavior for every existing caller that does not declare a launch mode).
  expect(resolveShared(undefined, cfg, opts)).toBe("opencode");
});
