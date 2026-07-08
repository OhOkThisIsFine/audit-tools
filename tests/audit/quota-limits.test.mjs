import { test, expect } from "vitest";

const { resolveLimits, hostClassFor, resolveHostModel } = await import(
  "../../src/shared/quota/limits.ts"
);
const { DEFAULT_OUTPUT_TOKENS } = await import("../../src/shared/tokens.ts");

test("hostClassFor maps claude-code to hosted", () => {
  expect(hostClassFor("claude-code")).toBe("hosted");
});

test("hostClassFor maps opencode to local", () => {
  expect(hostClassFor("opencode")).toBe("local");
});

test("hostClassFor maps worker-command to local", () => {
  expect(hostClassFor("worker-command")).toBe("local");
});

test("hostClassFor maps subprocess-template and vscode-task to unknown", () => {
  expect(hostClassFor("subprocess-template")).toBe("unknown");
  expect(hostClassFor("vscode-task")).toBe("unknown");
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
  expect(result.source).toBe("explicit_config");
  expect(result.confidence).toBe("high");
  expect(result.limits.context_tokens).toBe(50_000);
  expect(result.limits.output_tokens).toBe(2_048);
  expect(result.limits.requests_per_minute).toBe(20);
  expect(result.limits.input_tokens_per_minute).toBe(null);
});

test("resolveLimits uses discovered_capability when the handshake reports a window", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "anthropic/claude-opus-4-7",
    discoveredLimits: { context_tokens: 200_000, output_tokens: 32_000 },
  });
  expect(result.source).toBe("discovered_capability");
  expect(result.confidence).toBe("high");
  expect(result.limits.context_tokens).toBe(200_000);
  expect(result.limits.output_tokens).toBe(32_000);
});

test("resolveLimits respects a discovered context but ignores an inverted output reservation", () => {
  // A degenerate discovered window (output ≥ context — e.g. a malformed operator
  // quota that reached the scheduler without a validator) must not size against
  // the bad output: keep the real context ceiling (no over-admit) and fall to the
  // conservative default output so the pair can't wedge a negative budget.
  const result = resolveLimits({
    providerName: "openai-compatible",
    sessionConfig: {},
    hostModel: "nim/some-model",
    discoveredLimits: { context_tokens: 4_000, output_tokens: 8_000 },
  });
  expect(result.source).toBe("discovered_capability");
  expect(result.limits.context_tokens).toBe(4_000);
  expect(result.limits.output_tokens).toBe(DEFAULT_OUTPUT_TOKENS);
});

test("resolveLimits uses static_metadata for a named model in the models.dev snapshot", () => {
  // No discovered window and no explicit config, but the model is in the vendored
  // models.dev dataset — the static rung supplies its real window instead of the
  // conservative default. (Route prefix `anthropic/` is stripped on lookup.)
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "anthropic/claude-opus-4-7",
  });
  expect(result.source).toBe("static_metadata");
  expect(result.confidence).toBe("medium");
  expect(result.limits.context_tokens).toBeGreaterThan(32_000);
});

test("resolveLimits falls back to provider_default when model is unknown to the snapshot", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "unknown/model",
  });
  expect(result.source).toBe("provider_default");
  expect(result.confidence).toBe("low");
  expect(result.limits.context_tokens).toBe(32_000);
});

test("resolveLimits uses quota.default_context_tokens from session config", () => {
  const result = resolveLimits({
    providerName: "worker-command",
    sessionConfig: { quota: { default_context_tokens: 128_000, reserved_output_tokens: 8_192 } },
  });
  expect(result.limits.context_tokens).toBe(128_000);
  expect(result.limits.output_tokens).toBe(8_192);
});

test("resolveLimits with no hostModel falls back to provider_default for hosted provider", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
  });
  expect(result.source).toBe("provider_default");
  expect(result.confidence).toBe("low");
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
  expect(result.source).toBe("explicit_config");
  expect(result.limits.context_tokens).toBe(1_000);
  // known output_tokens not used — falls back to default_context_tokens? No, reserved_output_tokens default
  expect(result.limits.output_tokens).toBe(4_096); // default reserved_output_tokens
});

test("resolveHostModel returns explicit hostModel argument when provided", () => {
  const result = resolveHostModel({
    providerName: "claude-code",
    sessionConfig: {},
    explicitModel: "anthropic/claude-sonnet-4-6",
  });
  expect(result).toBe("anthropic/claude-sonnet-4-6");
});

test("resolveHostModel returns null when no argument, no env var, no session config, no provider default", () => {
  const result = resolveHostModel({
    providerName: "worker-command",
    sessionConfig: {},
    env: {},
    envVar: "AUDIT_CODE_HOST_MODEL",
  });
  expect(result).toBe(null);
});

test("resolveHostModel reads from env var when no explicit argument", () => {
  const result = resolveHostModel({
    providerName: "worker-command",
    sessionConfig: {},
    env: { AUDIT_CODE_HOST_MODEL: "anthropic/claude-opus-4-7" },
    envVar: "AUDIT_CODE_HOST_MODEL",
  });
  expect(result).toBe("anthropic/claude-opus-4-7");
});

test("resolveHostModel explicit argument takes precedence over env var", () => {
  const result = resolveHostModel({
    providerName: "worker-command",
    sessionConfig: {},
    explicitModel: "anthropic/claude-sonnet-4-6",
    env: { AUDIT_CODE_HOST_MODEL: "anthropic/claude-opus-4-7" },
    envVar: "AUDIT_CODE_HOST_MODEL",
  });
  expect(result).toBe("anthropic/claude-sonnet-4-6");
});
