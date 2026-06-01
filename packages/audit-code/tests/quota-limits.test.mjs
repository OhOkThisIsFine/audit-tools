import test from "node:test";
import assert from "node:assert/strict";

const { resolveLimits, lookupKnownModel, classifyProvider } = await import(
  "@audit-tools/shared/quota/limits"
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

test("lookupKnownModel finds anthropic/claude-sonnet-4-6", () => {
  const found = lookupKnownModel("anthropic/claude-sonnet-4-6");
  assert.ok(found, "model should be in the DB");
  assert.equal(found.context_tokens, 200_000);
  assert.equal(found.output_tokens, 8_192);
});

test("lookupKnownModel is case-insensitive", () => {
  const found = lookupKnownModel("Anthropic/Claude-Sonnet-4-6");
  assert.ok(found);
  assert.equal(found.context_tokens, 200_000);
});

test("lookupKnownModel returns undefined for unknown model", () => {
  const found = lookupKnownModel("unknown-vendor/unknown-model");
  assert.equal(found, undefined);
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

test("resolveLimits uses known_metadata for recognized model without explicit config", () => {
  const result = resolveLimits({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "anthropic/claude-opus-4-7",
  });
  assert.equal(result.source, "known_metadata");
  assert.equal(result.confidence, "medium");
  assert.equal(result.limits.context_tokens, 200_000);
  assert.equal(result.limits.output_tokens, 32_000);
  assert.equal(result.limits.requests_per_minute, null);
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

test("explicit_config overrides known_metadata even for a known model", () => {
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
