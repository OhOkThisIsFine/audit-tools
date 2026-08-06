import { describe, test, expect } from "vitest";
import {
  COST_BLEND_INPUT_WEIGHT,
  COST_BLEND_OUTPUT_WEIGHT,
  PRICE_BAND_BASE,
  UNKNOWN_PRICE_BAND_BASE,
  blendedPrice,
  deriveCostRank,
} from "../../src/shared/dispatch/costRank.js";

describe("provider-neutral cost rank", () => {
  test("blends input and output catalog prices", () => {
    expect(blendedPrice({ input: 4, output: 8 })).toBeCloseTo(
      4 * COST_BLEND_INPUT_WEIGHT + 8 * COST_BLEND_OUTPUT_WEIGHT,
    );
  });

  test("declared source cost wins over catalog price", () => {
    expect(
      deriveCostRank({
        model: "claude-opus-4-8",
        tier: "deep",
        declaredCostPerMtok: 0,
      }),
    ).toBe(PRICE_BAND_BASE);
  });

  test("unknown prices fall back to the relative capability tier", () => {
    const small = deriveCostRank({ model: "unknown/model", tier: "small" });
    const deep = deriveCostRank({ model: "unknown/model", tier: "deep" });
    expect(small).toBeGreaterThanOrEqual(UNKNOWN_PRICE_BAND_BASE);
    expect(deep).toBeGreaterThan(small);
  });
});
