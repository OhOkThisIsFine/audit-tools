// Pins the (provider, model)-keyed snapshot generator (CP-NODE-9).
//
// A cross-provider model-id collision must collapse to the CHEAPEST blended
// price in the flat `default` half (so an operator who names no backend never
// over-prices), while every colliding provider's native record is preserved
// under the `__by_provider` index. A model only one provider carries stays in
// `default` with no per-provider copy — so a collision-free snapshot is
// byte-identical to the pre-(provider,model) format.

import { test, describe, expect } from "vitest";
import {
  flatten,
  stableStringify,
  blendedPrice,
  BY_PROVIDER_KEY,
} from "../../scripts/shared/update-models.mjs";

/** models.dev-shaped entry helper. */
function entry(contextTokens, outputTokens, inputPrice, outputPrice) {
  return {
    limit: { context: contextTokens, output: outputTokens },
    cost: { input: inputPrice, output: outputPrice },
  };
}

describe("update-models blendedPrice (generator)", () => {
  test("blends input/output by 0.75/0.25 (must match costRank COST_BLEND_*)", () => {
    // 4*0.75 + 8*0.25 = 5
    expect(blendedPrice({ price: { input: 4, output: 8 } })).toBeCloseTo(5);
  });
  test("degrades to the single present component", () => {
    expect(blendedPrice({ price: { input: 3 } })).toBe(3);
    expect(blendedPrice({ price: { output: 9 } })).toBe(9);
  });
  test("undefined when no price at all", () => {
    expect(blendedPrice({})).toBeUndefined();
    expect(blendedPrice({ price: {} })).toBeUndefined();
  });
});

describe("flatten — single-provider models stay byte-identical", () => {
  const api = {
    beta: { models: { solo: entry(128000, 4096, 1, 2) } },
    alpha: { models: { other: entry(64000, 2048, 3, 4) } },
  };
  const { statics, byProvider, collisions } = flatten(api);

  test("no collisions, no per-provider index", () => {
    expect(collisions).toBe(0);
    expect(byProvider).toEqual({});
  });
  test("default carries each model's own record", () => {
    expect(statics.solo).toEqual({
      context_tokens: 128000,
      output_tokens: 4096,
      price: { input: 1, output: 2 },
    });
    expect(statics.other.price).toEqual({ input: 3, output: 4 });
  });
  test("serialization omits the __by_provider key entirely", () => {
    const json = JSON.parse(stableStringify({ statics, byProvider }));
    expect(json).not.toHaveProperty(BY_PROVIDER_KEY);
    expect(Object.keys(json)).toEqual(["other", "solo"]); // sorted, model-only
  });
});

describe("flatten — cross-provider collision collapses to cheapest default", () => {
  // Same model id offered by three providers at different prices.
  //   pricey : input 10, output 10 → blended 10.0
  //   cheap  : input  1, output  1 → blended  1.0   ← cheapest
  //   mid    : input  4, output  8 → blended  5.0
  // Providers deliberately declared out of sorted order to prove the pick is
  // price-driven, not iteration-order-driven.
  const api = {
    pricey: { models: { "shared-model": entry(200000, 8192, 10, 10) } },
    cheap: { models: { "shared-model": entry(100000, 4096, 1, 1) } },
    mid: { models: { "shared-model": entry(150000, 6144, 4, 8) } },
    // A model only `mid` carries — must NOT appear in the per-provider index.
    solo: { models: {} },
  };
  api.mid.models["mid-only"] = entry(50000, 2048, 2, 2);
  const { statics, byProvider, collisions } = flatten(api);

  test("counts the collision drops (entries - 1 per collided model)", () => {
    expect(collisions).toBe(2); // three providers on one id → 2 dropped from default
  });

  test("default = cheapest provider's native record", () => {
    expect(statics["shared-model"]).toEqual({
      context_tokens: 100000,
      output_tokens: 4096,
      price: { input: 1, output: 1 },
    });
  });

  test("every colliding provider's native record is indexed by (provider, model)", () => {
    expect(byProvider.cheap["shared-model"].price).toEqual({ input: 1, output: 1 });
    expect(byProvider.mid["shared-model"].price).toEqual({ input: 4, output: 8 });
    expect(byProvider.pricey["shared-model"].price).toEqual({ input: 10, output: 10 });
  });

  test("a single-provider model is NOT copied into the per-provider index", () => {
    expect(statics["mid-only"].price).toEqual({ input: 2, output: 2 });
    expect(byProvider.mid).not.toHaveProperty("mid-only");
  });

  test("serialization emits a sorted __by_provider index", () => {
    const json = JSON.parse(stableStringify({ statics, byProvider }));
    expect(json).toHaveProperty(BY_PROVIDER_KEY);
    // providers sorted; only colliding providers present.
    expect(Object.keys(json[BY_PROVIDER_KEY])).toEqual(["cheap", "mid", "pricey"]);
    // default half still cheapest.
    expect(json["shared-model"].price).toEqual({ input: 1, output: 1 });
  });
});

describe("flatten — deterministic regardless of provider declaration order", () => {
  const build = (order) => {
    const providers = {
      aaa: { models: { dup: entry(100000, 4096, 7, 7) } }, // blended 7
      zzz: { models: { dup: entry(100000, 4096, 3, 3) } }, // blended 3 ← cheapest
    };
    const api = {};
    for (const p of order) api[p] = providers[p];
    return flatten(api);
  };
  test("cheapest wins whichever order providers are visited", () => {
    const a = build(["aaa", "zzz"]);
    const b = build(["zzz", "aaa"]);
    expect(a.statics.dup.price).toEqual({ input: 3, output: 3 });
    expect(b.statics.dup.price).toEqual({ input: 3, output: 3 });
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
});
