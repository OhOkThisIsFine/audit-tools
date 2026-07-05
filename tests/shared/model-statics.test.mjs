import { test, expect, describe } from "vitest";

const { resolveModelStatics, resetModelStaticsCache } = await import(
  "../../src/shared/quota/modelStatics.ts"
);
const { resolveLimits } = await import("../../src/shared/quota/limits.ts");

describe("resolveModelStatics", () => {
  test("resolves a known model's real context window from the vendored snapshot", () => {
    const opus = resolveModelStatics("claude-opus-4-8");
    expect(opus).toBeTruthy();
    expect(opus.context_tokens).toBeGreaterThan(32_000); // real window, not the flat default
    expect(opus.price).toBeTruthy();
  });

  test("resolves a large-window model (sonnet-5 = 1M context)", () => {
    const sonnet = resolveModelStatics("claude-sonnet-5");
    expect(sonnet?.context_tokens).toBe(1_000_000);
  });

  test("strips a slash/colon route prefix on the fallback", () => {
    const expected = resolveModelStatics("claude-opus-4-8")?.context_tokens;
    expect(resolveModelStatics("bedrock/claude-opus-4-8")?.context_tokens).toBe(expected);
    expect(resolveModelStatics("openrouter:claude-opus-4-8")?.context_tokens).toBe(expected);
  });

  test("does NOT strip on dots (model ids legitimately contain them)", () => {
    // Dots are never a namespace separator, so an unknown dotted-prefixed id
    // degrades to undefined rather than mis-resolving to a same-suffix model.
    expect(resolveModelStatics("zz.madeup.claude-opus-4-8")).toBeUndefined();
  });

  test("degrades to undefined for an unknown model id", () => {
    expect(resolveModelStatics("totally-made-up-model-xyz")).toBeUndefined();
  });

  test("degrades to undefined for empty / non-string input", () => {
    expect(resolveModelStatics("")).toBeUndefined();
    expect(resolveModelStatics(null)).toBeUndefined();
    expect(resolveModelStatics(undefined)).toBeUndefined();
  });

  test("cache reset does not change resolution", () => {
    const before = resolveModelStatics("claude-opus-4-8")?.context_tokens;
    resetModelStaticsCache();
    const after = resolveModelStatics("claude-opus-4-8")?.context_tokens;
    expect(after).toBe(before);
  });
});

describe("resolveLimits static_metadata rung", () => {
  const baseConfig = { quota: {} };

  test("uses the models.dev window when nothing is discovered", () => {
    const result = resolveLimits({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: "claude-opus-4-8",
    });
    expect(result.source).toBe("static_metadata");
    expect(result.limits.context_tokens).toBeGreaterThan(32_000);
  });

  test("discovered capability outranks the static rung", () => {
    const result = resolveLimits({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: "claude-opus-4-8",
      discoveredLimits: { context_tokens: 500_000 },
    });
    expect(result.source).toBe("discovered_capability");
    expect(result.limits.context_tokens).toBe(500_000);
  });

  test("explicit config override outranks the static rung", () => {
    const result = resolveLimits({
      providerName: "claude-code",
      sessionConfig: { quota: { models: { "claude-opus-4-8": { context_tokens: 111_000 } } } },
      hostModel: "claude-opus-4-8",
    });
    expect(result.source).toBe("explicit_config");
    expect(result.limits.context_tokens).toBe(111_000);
  });

  test("unknown model falls through to the conservative default", () => {
    const result = resolveLimits({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: "totally-made-up-model-xyz",
    });
    expect(result.source).not.toBe("static_metadata");
    expect(result.limits.context_tokens).toBe(32_000);
  });
});
