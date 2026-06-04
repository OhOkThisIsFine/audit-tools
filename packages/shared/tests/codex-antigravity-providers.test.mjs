import test from "node:test";
import assert from "node:assert/strict";

const { PROVIDER_NAMES } = await import("@audit-tools/shared/types/sessionConfig");
const { classifyProvider } = await import("@audit-tools/shared/quota/limits");
const {
  resolveFreshSessionProviderName,
  createFreshSessionProvider,
} = await import("@audit-tools/shared/providers/providerFactory");
const { CodexProvider } = await import(
  "@audit-tools/shared/providers/codexProvider"
);
const { AntigravityProvider } = await import(
  "@audit-tools/shared/providers/antigravityProvider"
);

// Minimal deps for the factory. Codex/antigravity never touch these injected
// claude-code/opencode constructors, so failing stubs prove they are unused.
const deps = {
  orchestratorName: "test",
  createClaudeCodeProvider: () => {
    throw new Error("createClaudeCodeProvider should not be called");
  },
  createOpenCodeProvider: () => {
    throw new Error("createOpenCodeProvider should not be called");
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

test("createFreshSessionProvider constructs an AntigravityProvider", () => {
  const provider = createFreshSessionProvider(
    "antigravity",
    { antigravity: { command_template: ["ag", "--run"] } },
    deps,
  );
  assert.equal(provider.name, "antigravity");
  assert.ok(provider instanceof AntigravityProvider);
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
