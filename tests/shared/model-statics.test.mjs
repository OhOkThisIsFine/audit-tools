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

describe("resolveModelStatics — optional provider scope (CP-NODE-9)", () => {
  // The vendored snapshot DOES carry cross-provider collisions, so the
  // per-provider index is populated and a provider-scoped lookup resolves that
  // provider's own record. This test previously asserted scoped === bare, which
  // was only ever true because the shipped snapshot predated the collision index
  // and was therefore inert — it pinned the defect rather than the contract.
  //
  // The distinction is load-bearing for cost-first routing: the flat default is
  // the CHEAPEST colliding price, which for a model many gateways resell is not
  // the price you pay on the backend you actually dispatch to. `claude-opus-4-8`
  // collides across 17 providers; the default resolves a reseller's $0.425/Mtok
  // input while anthropic's own is $5 — a ~12x underprice, the same class of
  // error as the INV-SCC-03 per-token/per-Mtok unit bug.
  test("naming a provider returns THAT provider's record, not the cheapest-collision default", () => {
    const bare = resolveModelStatics("claude-opus-4-8");
    const scoped = resolveModelStatics("claude-opus-4-8", "anthropic");
    expect(scoped).toBeTruthy();
    // Consulted the index rather than falling through — the path is live, not inert.
    expect(scoped).not.toEqual(bare);
    expect(scoped.price.input).toBeGreaterThan(bare.price.input);
  });
  test("an unmatched provider degrades to the default, never to undefined", () => {
    const bare = resolveModelStatics("claude-opus-4-8");
    expect(resolveModelStatics("claude-opus-4-8", "no-such-provider")).toEqual(bare);
  });
  test("route-prefix stripping still applies under a provider scope", () => {
    const expected = resolveModelStatics("claude-opus-4-8")?.context_tokens;
    expect(resolveModelStatics("bedrock/claude-opus-4-8", "anthropic")?.context_tokens).toBe(
      expected,
    );
  });
  test("provider scope does not resurrect an unknown model", () => {
    expect(resolveModelStatics("totally-made-up-model-xyz", "anthropic")).toBeUndefined();
  });
  test("null/empty provider behaves like no provider", () => {
    const bare = resolveModelStatics("claude-opus-4-8");
    expect(resolveModelStatics("claude-opus-4-8", null)).toEqual(bare);
    expect(resolveModelStatics("claude-opus-4-8", "")).toEqual(bare);
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
