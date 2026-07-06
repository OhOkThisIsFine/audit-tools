// Cost-first routing engine (spec/cost-first-routing.md).
//
// Locks the three-rung costRank resolution: operator-confirmed position (rung 1)
// < real models.dev blended price (rung 2) < tier-ordinal fallback (rung 3),
// with disjoint bands so cross-rung values never interleave (a dollar value is
// never compared against a tier ordinal). Also locks the Gate-0 suggestion
// ordering. Uses real vendored model ids so the price math is end-to-end.

import { test, describe, expect } from "vitest";
import {
  COST_BLEND_INPUT_WEIGHT,
  COST_BLEND_OUTPUT_WEIGHT,
  PRICE_BAND_BASE,
  UNKNOWN_PRICE_BAND_BASE,
  blendedPrice,
  resolveModelPrice,
  deriveCostRank,
  suggestCostOrdering,
} from "../../dist/shared/index.js";

// Vendored models.dev prices ($/Mtok) at time of writing — used only to derive
// the EXPECTED blend here, never asserted as absolute routing values:
//   claude-haiku-4-5 : input 1, output 5   → 1*.75 + 5*.25   = 2.00
//   claude-sonnet-5  : input 2, output 10  → 2*.75 + 10*.25  = 4.00
//   claude-opus-4-8  : input 5, output 25  → 5*.75 + 25*.25  = 10.00
const UNKNOWN_MODEL = "no-such-model-xyz-000";

describe("blendedPrice", () => {
  test("blends a full input/output pair by the declared weights", () => {
    expect(blendedPrice({ input: 4, output: 8 })).toBeCloseTo(
      4 * COST_BLEND_INPUT_WEIGHT + 8 * COST_BLEND_OUTPUT_WEIGHT,
    );
  });
  test("weights sum to 1 (a blend, not a sum)", () => {
    expect(COST_BLEND_INPUT_WEIGHT + COST_BLEND_OUTPUT_WEIGHT).toBeCloseTo(1);
  });
  test("degrades a partial pair to the present component", () => {
    expect(blendedPrice({ input: 3 })).toBe(3);
    expect(blendedPrice({ output: 9 })).toBe(9);
  });
  test("returns undefined for an absent/empty price", () => {
    expect(blendedPrice(undefined)).toBeUndefined();
    expect(blendedPrice({})).toBeUndefined();
    expect(blendedPrice({ input: Number.NaN })).toBeUndefined();
  });
});

describe("resolveModelPrice", () => {
  test("prices a known vendored model", () => {
    expect(resolveModelPrice("claude-haiku-4-5")).toBeCloseTo(2.0);
    expect(resolveModelPrice("claude-sonnet-5")).toBeCloseTo(4.0);
    expect(resolveModelPrice("claude-opus-4-8")).toBeCloseTo(10.0);
  });
  test("returns undefined for an unknown model / null id", () => {
    expect(resolveModelPrice(UNKNOWN_MODEL)).toBeUndefined();
    expect(resolveModelPrice(null)).toBeUndefined();
    expect(resolveModelPrice(undefined)).toBeUndefined();
  });
});

describe("deriveCostRank — rungs occupy disjoint bands", () => {
  test("rung 1: a confirmed position sorts in the lowest band", () => {
    expect(deriveCostRank({ model: "claude-opus-4-8", tier: "deep", confirmedPosition: 0 })).toBe(0);
    expect(deriveCostRank({ model: "claude-opus-4-8", tier: "deep", confirmedPosition: 3 })).toBe(3);
  });
  test("rung 2: a known price sorts in the price band, ascending by dollars", () => {
    const haiku = deriveCostRank({ model: "claude-haiku-4-5", tier: "small" });
    const sonnet = deriveCostRank({ model: "claude-sonnet-5", tier: "standard" });
    const opus = deriveCostRank({ model: "claude-opus-4-8", tier: "deep" });
    expect(haiku).toBeGreaterThanOrEqual(PRICE_BAND_BASE);
    expect(haiku).toBeLessThan(UNKNOWN_PRICE_BAND_BASE);
    expect(haiku).toBeLessThan(sonnet);
    expect(sonnet).toBeLessThan(opus);
  });
  test("rung 3: an unknown price falls to the tier band, ordered by tier", () => {
    const small = deriveCostRank({ model: UNKNOWN_MODEL, tier: "small" });
    const deep = deriveCostRank({ model: UNKNOWN_MODEL, tier: "deep" });
    expect(small).toBeGreaterThanOrEqual(UNKNOWN_PRICE_BAND_BASE);
    expect(small).toBeLessThan(deep);
  });
  test("band ordering: confirmed < any priced < any unknown-price", () => {
    const confirmed = deriveCostRank({ model: "claude-opus-4-8", tier: "deep", confirmedPosition: 9 });
    const pricedDear = deriveCostRank({ model: "claude-opus-4-8", tier: "deep" });
    const unknownCheapTier = deriveCostRank({ model: UNKNOWN_MODEL, tier: "small" });
    expect(confirmed).toBeLessThan(pricedDear);
    expect(pricedDear).toBeLessThan(unknownCheapTier);
  });
  test("all-unknown set falls back to pure tier ordering (no regression)", () => {
    const pools = [
      { model: null, tier: "deep" },
      { model: null, tier: "small" },
      { model: null, tier: "standard" },
    ];
    const order = pools
      .map((p) => ({ tier: p.tier, rank: deriveCostRank(p) }))
      .sort((a, b) => a.rank - b.rank)
      .map((p) => p.tier);
    expect(order).toEqual(["small", "standard", "deep"]);
  });
  test("all-known set routes by real dollars (cheapest model first)", () => {
    const pools = [
      { key: "opus", model: "claude-opus-4-8", tier: "deep" },
      { key: "haiku", model: "claude-haiku-4-5", tier: "small" },
      { key: "sonnet", model: "claude-sonnet-5", tier: "standard" },
    ];
    const order = pools
      .map((p) => ({ key: p.key, rank: deriveCostRank(p) }))
      .sort((a, b) => a.rank - b.rank)
      .map((p) => p.key);
    expect(order).toEqual(["haiku", "sonnet", "opus"]);
  });
});

describe("suggestCostOrdering — Gate-0 suggestion", () => {
  test("orders known cheapest-first, unknown-price last by tier", () => {
    const suggestion = suggestCostOrdering([
      { key: "opus", model: "claude-opus-4-8", tier: "deep" },
      { key: "custom-deep", model: UNKNOWN_MODEL, tier: "deep" },
      { key: "haiku", model: "claude-haiku-4-5", tier: "small" },
      { key: "custom-small", model: UNKNOWN_MODEL, tier: "small" },
      { key: "sonnet", model: "claude-sonnet-5", tier: "standard" },
    ]);
    expect(suggestion.map((s) => s.key)).toEqual([
      "haiku", // 2.00
      "sonnet", // 4.00
      "opus", // 10.00
      "custom-small", // unknown, small tier
      "custom-deep", // unknown, deep tier
    ]);
    expect(suggestion.map((s) => s.suggested_order)).toEqual([0, 1, 2, 3, 4]);
    expect(suggestion.find((s) => s.key === "haiku")?.price_known).toBe(true);
    expect(suggestion.find((s) => s.key === "custom-deep")?.price_known).toBe(false);
    expect(suggestion.find((s) => s.key === "custom-deep")?.blended_price).toBeUndefined();
  });
  test("a suggested ordering fed back as confirmed positions preserves that order", () => {
    const suggestion = suggestCostOrdering([
      { key: "opus", model: "claude-opus-4-8", tier: "deep" },
      { key: "haiku", model: "claude-haiku-4-5", tier: "small" },
    ]);
    // Feed suggested_order back as rung-1 confirmedPosition and re-derive.
    const reordered = suggestion
      .map((s) => ({ key: s.key, rank: deriveCostRank({ model: s.model, tier: s.tier, confirmedPosition: s.suggested_order }) }))
      .sort((a, b) => a.rank - b.rank)
      .map((s) => s.key);
    expect(reordered).toEqual(["haiku", "opus"]);
  });
});
