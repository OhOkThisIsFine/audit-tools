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

describe("resolveModelPrice — optional provider scope (CP-NODE-9)", () => {
  // The vendored snapshot is collision-free, so naming a provider must resolve
  // the exact same price as the bare lookup (single-provider byte-identical).
  // The cheapest-collision collapse is pinned against the generator in
  // update-models-collision.test.mjs.
  test("naming a provider yields the same price as the default lookup", () => {
    expect(resolveModelPrice("claude-opus-4-8", "anthropic")).toBeCloseTo(
      resolveModelPrice("claude-opus-4-8"),
    );
  });
  test("an unmatched provider degrades to the default price", () => {
    expect(resolveModelPrice("claude-sonnet-5", "no-such-provider")).toBeCloseTo(
      resolveModelPrice("claude-sonnet-5"),
    );
  });
  test("provider scope keeps an unknown model unpriced", () => {
    expect(resolveModelPrice(UNKNOWN_MODEL, "anthropic")).toBeUndefined();
  });
});

describe("deriveCostRank / suggestCostOrdering — provider is inert on a collision-free snapshot", () => {
  test("deriveCostRank is unchanged by an added provider", () => {
    const bare = deriveCostRank({ model: "claude-sonnet-5", tier: "standard" });
    const scoped = deriveCostRank({ model: "claude-sonnet-5", provider: "anthropic", tier: "standard" });
    expect(scoped).toBe(bare);
  });
  test("suggestCostOrdering preserves ordering when candidates carry a provider", () => {
    const withProvider = suggestCostOrdering([
      { key: "opus", model: "claude-opus-4-8", provider: "anthropic", tier: "deep" },
      { key: "haiku", model: "claude-haiku-4-5", provider: "anthropic", tier: "small" },
      { key: "sonnet", model: "claude-sonnet-5", provider: "anthropic", tier: "standard" },
    ]);
    expect(withProvider.map((s) => s.key)).toEqual(["haiku", "sonnet", "opus"]);
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

describe("deriveCostRank — operator-declared per-source price (rung 2, arbitrage free-first)", () => {
  test("a declared 0 sorts at the price-band floor (free-first)", () => {
    expect(deriveCostRank({ model: UNKNOWN_MODEL, tier: "deep", declaredCostPerMtok: 0 })).toBe(PRICE_BAND_BASE);
  });
  test("a declared-free pool beats every positive-priced and every unknown-price pool", () => {
    const free = deriveCostRank({ model: UNKNOWN_MODEL, tier: "deep", declaredCostPerMtok: 0 });
    const cheapestPriced = deriveCostRank({ model: "claude-haiku-4-5", tier: "small" }); // ~2.00
    const unknownCheapTier = deriveCostRank({ model: UNKNOWN_MODEL, tier: "small" });
    expect(free).toBeLessThan(cheapestPriced);
    expect(free).toBeLessThan(unknownCheapTier);
  });
  test("declared price is authoritative OVER the models.dev catalog for the same model", () => {
    // claude-opus-4-8 is priced ~10.00 in the vendored set; a declared 0.5 must win.
    const declared = deriveCostRank({ model: "claude-opus-4-8", tier: "deep", declaredCostPerMtok: 0.5 });
    const catalog = deriveCostRank({ model: "claude-opus-4-8", tier: "deep" });
    expect(declared).toBe(PRICE_BAND_BASE + 0.5);
    expect(declared).toBeLessThan(catalog);
  });
  test("declared pools order by their declared dollars", () => {
    const cheap = deriveCostRank({ model: UNKNOWN_MODEL, tier: "deep", declaredCostPerMtok: 0 });
    const dearer = deriveCostRank({ model: UNKNOWN_MODEL, tier: "deep", declaredCostPerMtok: 3 });
    expect(cheap).toBeLessThan(dearer);
  });
  test("a Gate-0 confirmed position still beats a declared 0 (rung 1 > rung 2)", () => {
    const confirmed = deriveCostRank({ model: UNKNOWN_MODEL, tier: "deep", declaredCostPerMtok: 0, confirmedPosition: 0 });
    const declaredFree = deriveCostRank({ model: UNKNOWN_MODEL, tier: "deep", declaredCostPerMtok: 0 });
    expect(confirmed).toBeLessThan(declaredFree);
  });
  test("a negative / non-finite declared value is ignored (never trusted as free) — falls through", () => {
    const negative = deriveCostRank({ model: "claude-sonnet-5", tier: "standard", declaredCostPerMtok: -1 });
    const nan = deriveCostRank({ model: "claude-sonnet-5", tier: "standard", declaredCostPerMtok: Number.NaN });
    const catalog = deriveCostRank({ model: "claude-sonnet-5", tier: "standard" });
    expect(negative).toBe(catalog);
    expect(nan).toBe(catalog);
  });
  test("declared price on an unknown model still lands in the price band, not the unknown band", () => {
    const declared = deriveCostRank({ model: UNKNOWN_MODEL, tier: "deep", declaredCostPerMtok: 1 });
    expect(declared).toBeGreaterThanOrEqual(PRICE_BAND_BASE);
    expect(declared).toBeLessThan(UNKNOWN_PRICE_BAND_BASE);
  });
  test("a nonsensical declared cost >= the price-band width falls through (never overflows the band)", () => {
    // A declared value large enough to overflow into the unknown band is rejected as
    // the declared rung and falls through to models.dev / tier — the band-disjointness
    // invariant holds even for absurd operator input.
    const huge = deriveCostRank({ model: UNKNOWN_MODEL, tier: "small", declaredCostPerMtok: 5_000_000 });
    const plainUnknown = deriveCostRank({ model: UNKNOWN_MODEL, tier: "small" });
    expect(huge).toBe(plainUnknown);
    expect(huge).toBeGreaterThanOrEqual(UNKNOWN_PRICE_BAND_BASE);
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
  test("capability breaks a COST-EQUAL tie (lower rank = more capable, first)", () => {
    // Same model ⇒ identical price ⇒ the tie is decided by capabilityRank.
    const suggestion = suggestCostOrdering([
      { key: "weak", model: "claude-sonnet-5", capabilityRank: 10 },
      { key: "strong", model: "claude-sonnet-5", capabilityRank: 3 },
    ]);
    expect(suggestion.map((s) => s.key)).toEqual(["strong", "weak"]);
  });
  test("capability breaks a tie for two unknown-price, same-tier candidates", () => {
    const suggestion = suggestCostOrdering([
      { key: "b", model: UNKNOWN_MODEL, tier: "deep", capabilityRank: 8 },
      { key: "a", model: UNKNOWN_MODEL, tier: "deep", capabilityRank: 2 },
    ]);
    expect(suggestion.map((s) => s.key)).toEqual(["a", "b"]);
  });
  test("cost PRIMACY: a cheaper-but-weaker candidate still beats a pricier-stronger one", () => {
    // haiku ~2.00 with a WEAK rank vs opus ~10.00 with a STRONG rank — cost wins,
    // capability is never consulted because the prices differ.
    const suggestion = suggestCostOrdering([
      { key: "opus-strong", model: "claude-opus-4-8", capabilityRank: 1 },
      { key: "haiku-weak", model: "claude-haiku-4-5", capabilityRank: 999 },
    ]);
    expect(suggestion.map((s) => s.key)).toEqual(["haiku-weak", "opus-strong"]);
  });
  test("a present capabilityRank sorts before an absent one within a tie only", () => {
    const suggestion = suggestCostOrdering([
      { key: "absent", model: "claude-sonnet-5" },
      { key: "present", model: "claude-sonnet-5", capabilityRank: 5 },
    ]);
    expect(suggestion.map((s) => s.key)).toEqual(["present", "absent"]);
  });
  test("no capabilityRank anywhere ⇒ ordering unchanged (key tiebreak preserved)", () => {
    const suggestion = suggestCostOrdering([
      { key: "z", model: "claude-sonnet-5" },
      { key: "a", model: "claude-sonnet-5" },
    ]);
    expect(suggestion.map((s) => s.key)).toEqual(["a", "z"]);
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

describe("suggestCostOrdering — quota-aware demotion (fixes quota-before-cost-ordering)", () => {
  test("a saturated candidate is demoted below every healthy one, cost order preserved intra-group", () => {
    const suggestion = suggestCostOrdering([
      { key: "haiku", model: "claude-haiku-4-5", saturated: true }, // cheapest but saturated
      { key: "sonnet", model: "claude-sonnet-5" },
      { key: "opus", model: "claude-opus-4-8" },
    ]);
    // Healthy (sonnet, opus) first by cost; saturated haiku demoted last despite being cheapest.
    expect(suggestion.map((s) => s.key)).toEqual(["sonnet", "opus", "haiku"]);
    expect(suggestion.find((s) => s.key === "haiku")?.saturated).toBe(true);
    expect(suggestion.find((s) => s.key === "sonnet")?.saturated).toBe(false);
  });
  test("multiple saturated candidates keep their cost order among themselves, after the healthy", () => {
    const suggestion = suggestCostOrdering([
      { key: "opus", model: "claude-opus-4-8", saturated: true }, // dearer, saturated
      { key: "haiku", model: "claude-haiku-4-5", saturated: true }, // cheaper, saturated
      { key: "sonnet", model: "claude-sonnet-5" }, // healthy
    ]);
    expect(suggestion.map((s) => s.key)).toEqual(["sonnet", "haiku", "opus"]);
  });
  test("no saturation signal ⇒ ordering unchanged (additive no-op)", () => {
    const withFlag = suggestCostOrdering([
      { key: "opus", model: "claude-opus-4-8" },
      { key: "haiku", model: "claude-haiku-4-5" },
    ]);
    expect(withFlag.map((s) => s.key)).toEqual(["haiku", "opus"]);
    expect(withFlag.every((s) => s.saturated === false)).toBe(true);
  });
});
