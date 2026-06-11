import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const { PROVIDER_NAMES } = await import("@audit-tools/shared/types/sessionConfig");
const { classifyProvider } = await import("@audit-tools/shared/quota/limits");
const {
  resolveFreshSessionProviderName,
  createFreshSessionProvider,
} = await import("@audit-tools/shared/providers/providerFactory");
const { CodexProvider } = await import(
  "@audit-tools/shared/providers/codexProvider"
);
const { SubprocessTemplateProvider } = await import(
  "@audit-tools/shared/providers/subprocessTemplateProvider"
);

// Minimal deps for the factory. Codex/antigravity never touch the claude-code /
// opencode options; a dummy activeSessionMessage satisfies the type.
const deps = {
  orchestratorName: "test",
  claudeCodeOptions: {
    promptDelivery: "flag",
    skipPermissionsDefault: false,
    activeSessionMessage: "test-session-message",
  },
  openCodeOptions: {
    promptDelivery: "arg",
  },
};

const noCommands = () => false;
const allCommands = () => true;

test("codex and antigravity are members of PROVIDER_NAMES", () => {
  assert.ok(PROVIDER_NAMES.includes("codex"));
  assert.ok(PROVIDER_NAMES.includes("antigravity"));
});

test("resolveFreshSessionProviderName passes codex through verbatim", () => {
  assert.equal(resolveFreshSessionProviderName("codex", {}), "codex");
});

test("resolveFreshSessionProviderName passes antigravity through verbatim", () => {
  assert.equal(resolveFreshSessionProviderName("antigravity", {}), "antigravity");
});

test("auto resolves to codex when inside a codex session", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { CODEX: "1" }, commandExists: noCommands },
  );
  assert.equal(resolved, "codex");
});

test("auto resolves to codex from config when only codex is available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { codex: { command: "codex" } },
    {
      // No claude/opencode session env, and only `codex` resolves on PATH.
      env: {},
      commandExists: (command) => command === "codex",
    },
  );
  assert.equal(resolved, "codex");
});

test("auto resolves to antigravity with the IDE marker and a template", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { antigravity: { command_template: ["ag", "--run"] } },
    { env: { ANTIGRAVITY: "1" }, commandExists: noCommands },
  );
  assert.equal(resolved, "antigravity");
});

test("auto does NOT resolve to antigravity with the marker but no template", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { ANTIGRAVITY: "1" }, commandExists: noCommands },
  );
  assert.notEqual(resolved, "antigravity");
});

test("createFreshSessionProvider constructs a CodexProvider", () => {
  const provider = createFreshSessionProvider("codex", {}, deps);
  assert.equal(provider.name, "codex");
  assert.ok(provider instanceof CodexProvider);
});

test("codex construction succeeds with an absent codex config", () => {
  // No sessionConfig.codex at all — command defaults to "codex".
  const provider = createFreshSessionProvider("codex", {}, deps);
  assert.ok(provider instanceof CodexProvider);
});

test("createFreshSessionProvider constructs a SubprocessTemplateProvider for antigravity", () => {
  const provider = createFreshSessionProvider(
    "antigravity",
    { antigravity: { command_template: ["ag", "--run"] } },
    deps,
  );
  assert.equal(provider.name, "antigravity");
  assert.ok(provider instanceof SubprocessTemplateProvider);
});

test("antigravity throws when no command template is configured", () => {
  assert.throws(
    () => createFreshSessionProvider("antigravity", {}, deps),
    /antigravity.*command_template/i,
  );
});

test("antigravity throws when the command template is empty", () => {
  assert.throws(
    () =>
      createFreshSessionProvider(
        "antigravity",
        { antigravity: { command_template: [] } },
        deps,
      ),
    /antigravity.*command_template/i,
  );
});

test("CodexProvider.queryLimits resolves to null (best-effort no-op)", async () => {
  const provider = new CodexProvider(undefined);
  assert.equal(await provider.queryLimits(null), null);
  assert.equal(await provider.queryLimits("some-model"), null);
});

test("classifyProvider maps codex to hosted and antigravity to unknown", () => {
  assert.equal(classifyProvider("codex"), "hosted");
  assert.equal(classifyProvider("antigravity"), "unknown");
});

// Guard: the bare-availability codex tie-break is last-resort only — it must NOT
// fire when claude or opencode is also available. With no provider configured and
// all three binaries on PATH, resolution preserves today's behavior (claude and
// opencode both available => neither bare tie-break fires => local-subprocess),
// so codex does not change existing setups.
test("codex tie-break does not preempt claude/opencode availability", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: {}, commandExists: allCommands },
  );
  assert.notEqual(resolved, "codex");
});

// Guard: configured claude takes precedence over configured codex (claude's
// config rung is listed before codex's), matching the spec's "keep claude/opencode
// precedence" intent for configured providers.
test("configured claude takes precedence over configured codex", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { claude_code: { command: "claude" }, codex: { command: "codex" } },
    { env: {}, commandExists: allCommands },
  );
  assert.equal(resolved, "claude-code");
});

// Minimal deps that satisfies FreshSessionProviderDeps for the auto path.
// The auto path resolves to local-subprocess or another non-claude/opencode
// provider in most test environments, so these branches are never called.
const autoDeps = {
  orchestratorName: "test",
  createClaudeCodeProvider: () => {
    throw new Error("unexpected: createClaudeCodeProvider called in auto test");
  },
  createOpenCodeProvider: () => {
    throw new Error("unexpected: createOpenCodeProvider called in auto test");
  },
};

// Detect whether opencode is on PATH — if so, auto-resolution will pick it up
// and call createOpenCodeProvider, which this test intentionally stubs as a
// throw. Skip rather than fail in those environments.
function opencodeOnPath() {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return r.status === 0;
}

test("createFreshSessionProvider auto path writes a structured stderr diagnostic", { skip: opencodeOnPath() ? "opencode is on PATH in this environment" : false }, () => {
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    createFreshSessionProvider(undefined, {}, autoDeps);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(captured.length, 1, "exactly one stderr write expected");
  const line = captured[0];
  assert.ok(line.startsWith("[shared] providers:"), `line should start with '[shared] providers:': ${line}`);
  assert.ok(line.includes("test"), `line should contain orchestratorName 'test': ${line}`);
  assert.ok(line.includes("auto-resolved provider"), `line should contain 'auto-resolved provider': ${line}`);
  assert.ok(/auto-resolved provider '\w[\w-]*'/.test(line), `line should contain provider name in single quotes: ${line}`);
  assert.ok(
    line.includes("fallback: none") || line.includes("no capable agent provider detected"),
    `line should contain either 'fallback: none' or 'no capable agent provider detected': ${line}`,
  );
  assert.ok(line.endsWith("\n"), `line should end with newline: ${JSON.stringify(line)}`);
});

test("createFreshSessionProvider with an explicit provider name does NOT write a stderr diagnostic", () => {
  const captured = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  };
  try {
    createFreshSessionProvider("codex", {}, autoDeps);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.deepEqual(captured, [], "no stderr output expected for an explicitly named provider");
});

// ── chooseAutoProvider: explicit priority table ───────────────────────────────

test("chooseAutoProvider: insideOpenCode wins over all other signals", () => {
  // All signals true — opencode (in-session) must still win.
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {
      claude_code: { command: "claude" },
      opencode: { command: "opencode" },
      codex: { command: "codex" },
      vscode_task: { command_template: ["vscode-task"] },
      antigravity: { command_template: ["ag"] },
      subprocess_template: { command_template: ["sub"] },
    },
    {
      env: {
        OPENCODE: "1",
        CODEX: "1",
        TERM_PROGRAM: "vscode",
        ANTIGRAVITY: "1",
      },
      commandExists: allCommands,
    },
  );
  assert.equal(resolved, "opencode");
});

test("chooseAutoProvider: insideCodex wins when insideOpenCode is false", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { CODEX: "1" }, commandExists: allCommands },
  );
  assert.equal(resolved, "codex");
});

test("chooseAutoProvider: vscode-task fires when in VSCode with a template and no in-session signals", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { vscode_task: { command_template: ["vscode-task"] } },
    { env: { TERM_PROGRAM: "vscode" }, commandExists: noCommands },
  );
  assert.equal(resolved, "vscode-task");
});

test("chooseAutoProvider: antigravity fires when in Antigravity with a template", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { antigravity: { command_template: ["ag", "--run"] } },
    { env: { ANTIGRAVITY: "1" }, commandExists: noCommands },
  );
  assert.equal(resolved, "antigravity");
});

test("chooseAutoProvider: subprocess-template fires with no IDE or in-session signals", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { subprocess_template: { command_template: ["my-sub"] } },
    { env: {}, commandExists: noCommands },
  );
  assert.equal(resolved, "subprocess-template");
});

// ── config-gated rungs take precedence over tie-breaks ────────────────────────

test("chooseAutoProvider: config-gated claude-code fires even when opencode is also available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { claude_code: { command: "claude" } },
    { env: {}, commandExists: allCommands },
  );
  assert.equal(resolved, "claude-code");
});

test("chooseAutoProvider: config-gated opencode fires when explicitly configured and available", () => {
  // No in-session signals; no claude config; opencode config + both available.
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { opencode: { command: "opencode" } },
    { env: {}, commandExists: allCommands },
  );
  assert.equal(resolved, "opencode");
});

test("chooseAutoProvider: config-gated codex fires when configured and only codex available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    { codex: { command: "codex" } },
    {
      env: {},
      commandExists: (cmd) => cmd === "codex",
    },
  );
  assert.equal(resolved, "codex");
});

// ── availability tie-breaks with no explicit config ───────────────────────────

test("chooseAutoProvider: tie-break resolves claude-code when only claude is available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      env: {},
      commandExists: (cmd) => cmd === "claude",
    },
  );
  assert.equal(resolved, "claude-code");
});

test("chooseAutoProvider: tie-break resolves opencode when only opencode is available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      env: {},
      commandExists: (cmd) => cmd === "opencode",
    },
  );
  assert.equal(resolved, "opencode");
});

test("chooseAutoProvider: last-resort resolves codex when only codex is available", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      env: {},
      commandExists: (cmd) => cmd === "codex",
    },
  );
  assert.equal(resolved, "codex");
});

test("chooseAutoProvider: falls back to local-subprocess when nothing is available and no config", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: {}, commandExists: noCommands },
  );
  assert.equal(resolved, "local-subprocess");
});

// ── self-spawn guards ─────────────────────────────────────────────────────────

test("chooseAutoProvider: insideClaudeCode forces claudeAvailable=false, falls to local-subprocess with no other provider", () => {
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    {
      // CLAUDECODE set, claude on PATH — claudeAvailable must be forced false.
      env: { CLAUDECODE: "1" },
      commandExists: (cmd) => cmd === "claude",
    },
  );
  assert.notEqual(resolved, "claude-code");
  assert.equal(resolved, "local-subprocess");
});

test("chooseAutoProvider: insideCodex in-session rung fires before codexAvailable self-spawn guard", () => {
  // CODEX=1 → insideCodex fires (rung 2) before any availability check.
  const resolved = resolveFreshSessionProviderName(
    "auto",
    {},
    { env: { CODEX: "1" }, commandExists: noCommands },
  );
  assert.equal(resolved, "codex");
});
