import test from "node:test";
import assert from "node:assert/strict";

const { resolveLimits, classifyProvider, resolveHostModel } = await import(
  "../../src/shared/quota/limits.ts"
);

test("classifyProvider maps claude-code to hosted", () => {
  assert.equal(classifyProvider("claude-code"), "hosted");
});

test("classifyProvider maps opencode to local", () => {
  assert.equal(classifyProvider("opencode"), "local");
});

test("classifyProvider maps local-subprocess to local", () => {
  assert.equal(classifyProvider("local-subprocess"), "local");
});

test("classifyProvider maps subprocess-template and vscode-task to unknown", () => {
  assert.equal(classifyProvider("subprocess-template"), "unknown");
  assert.equal(classifyProvider("vscode-task"), "unknown");
});

test("resolveLimits uses explicit config when quota.models has an entry", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: {
          "my-provider/my-model": {
            context_tokens: 50_000,
            output_tokens: 2_048,
            requests_per_minute: 20,
          },
        },
      },
    },
    hostModel: "my-provider/my-model",
  });
  assert.equal(result.source, "explicit_config");
  assert.equal(result.confidence, "high");
  assert.equal(result.limits.context_tokens, 50_000);
  assert.equal(result.limits.output_tokens, 2_048);
  assert.equal(result.limits.requests_per_minute, 20);
  assert.equal(result.limits.input_tokens_per_minute, null);
});

test("resolveLimits uses discovered_capability when the handshake reports a window", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "anthropic/claude-opus-4-7",
    discoveredLimits: { context_tokens: 200_000, output_tokens: 32_000 },
  });
  assert.equal(result.source, "discovered_capability");
  assert.equal(result.confidence, "high");
  assert.equal(result.limits.context_tokens, 200_000);
  assert.equal(result.limits.output_tokens, 32_000);
});

test("resolveLimits falls back to provider_default for a named model with no discovered window", () => {
  // No static known-model table: a recognized model name carries no special
  // limits — only a discovered window or explicit config does.
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "anthropic/claude-opus-4-7",
  });
  assert.equal(result.source, "provider_default");
  assert.equal(result.confidence, "low");
  assert.equal(result.limits.context_tokens, 32_000);
});

test("resolveLimits falls back to provider_default when model is unknown", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "unknown/model",
  });
  assert.equal(result.source, "provider_default");
  assert.equal(result.confidence, "low");
  assert.equal(result.limits.context_tokens, 32_000);
});

test("resolveLimits uses quota.default_context_tokens from session config", () => {
  const result = resolveLimits({
    providerName: "local-subprocess",
    sessionConfig: { quota: { default_context_tokens: 128_000, reserved_output_tokens: 8_192 } },
  });
  assert.equal(result.limits.context_tokens, 128_000);
  assert.equal(result.limits.output_tokens, 8_192);
});

test("resolveLimits with no hostModel falls back to provider_default for hosted provider", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
  });
  assert.equal(result.source, "provider_default");
  assert.equal(result.confidence, "low");
});

test("explicit_config takes precedence for a configured model", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: {
          "anthropic/claude-sonnet-4-6": {
            context_tokens: 1_000,
          },
        },
      },
    },
    hostModel: "anthropic/claude-sonnet-4-6",
  });
  assert.equal(result.source, "explicit_config");
  assert.equal(result.limits.context_tokens, 1_000);
  // known output_tokens not used — falls back to default_context_tokens? No, reserved_output_tokens default
  assert.equal(result.limits.output_tokens, 4_096); // default reserved_output_tokens
});

test("resolveHostModel returns explicit hostModel argument when provided", () => {
  const result = resolveHostModel({
    providerName: "claude-code",
    sessionConfig: {},
    explicitModel: "anthropic/claude-sonnet-4-6",
  });
  assert.equal(result, "anthropic/claude-sonnet-4-6");
});

test("resolveHostModel returns null when no argument, no env var, no session config, no provider default", () => {
  const result = resolveHostModel({
    providerName: "local-subprocess",
    sessionConfig: {},
    env: {},
    envVar: "AUDIT_CODE_HOST_MODEL",
  });
  assert.equal(result, null);
});

test("resolveHostModel reads from env var when no explicit argument", () => {
  const result = resolveHostModel({
    providerName: "local-subprocess",
    sessionConfig: {},
    env: { AUDIT_CODE_HOST_MODEL: "anthropic/claude-opus-4-7" },
    envVar: "AUDIT_CODE_HOST_MODEL",
  });
  assert.equal(result, "anthropic/claude-opus-4-7");
});

test("resolveHostModel explicit argument takes precedence over env var", () => {
  const result = resolveHostModel({
    providerName: "local-subprocess",
    sessionConfig: {},
    explicitModel: "anthropic/claude-sonnet-4-6",
    env: { AUDIT_CODE_HOST_MODEL: "anthropic/claude-opus-4-7" },
    envVar: "AUDIT_CODE_HOST_MODEL",
  });
  assert.equal(result, "anthropic/claude-sonnet-4-6");
});
