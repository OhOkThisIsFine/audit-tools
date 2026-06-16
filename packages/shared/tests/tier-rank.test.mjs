// Single shared dispatch tier-rank authority (P1 / drift-consolidation).
//
// Locks the invariant that the DispatchModelTier ORDERING lives in exactly one
// place (`@audit-tools/shared` dispatch/tierRank). The previously-duplicated
// rank maps (audit TIER_RANK / quotaPool rankOrder, shared rollingDispatch
// DISPATCH_TIER_RANK, remediate RANK_ORDER ×2) now all source from here.

import test from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCH_TIER_RANK,
  DISPATCH_TIER_ORDER,
  DISPATCH_TIER_RANK_FALLBACK,
  tierRank,
  compareTier,
  mostCapableTier,
} from "../dist/index.js";

test("DISPATCH_TIER_RANK orders small < standard < deep", () => {
  assert.ok(DISPATCH_TIER_RANK.small < DISPATCH_TIER_RANK.standard);
  assert.ok(DISPATCH_TIER_RANK.standard < DISPATCH_TIER_RANK.deep);
});

test("DISPATCH_TIER_RANK covers exactly the three canonical tiers", () => {
  assert.deepEqual(Object.keys(DISPATCH_TIER_RANK).sort(), ["deep", "small", "standard"]);
});

test("DISPATCH_TIER_ORDER is derived ascending capability order", () => {
  assert.deepEqual(DISPATCH_TIER_ORDER, ["small", "standard", "deep"]);
  // Derived from the rank map — every adjacent pair strictly increases.
  for (let i = 1; i < DISPATCH_TIER_ORDER.length; i++) {
    assert.ok(
      DISPATCH_TIER_RANK[DISPATCH_TIER_ORDER[i]] >
        DISPATCH_TIER_RANK[DISPATCH_TIER_ORDER[i - 1]],
    );
  }
});

test("tierRank maps an absent/unknown tier to the neutral middle (standard)", () => {
  assert.equal(tierRank(undefined), DISPATCH_TIER_RANK.standard);
  assert.equal(tierRank(null), DISPATCH_TIER_RANK.standard);
  assert.equal(DISPATCH_TIER_RANK_FALLBACK, DISPATCH_TIER_RANK.standard);
  assert.equal(tierRank("deep"), DISPATCH_TIER_RANK.deep);
});

test("compareTier sorts ascending; negate for most-capable-first", () => {
  const tiers = ["deep", "small", "standard"];
  assert.deepEqual([...tiers].sort(compareTier), ["small", "standard", "deep"]);
  assert.deepEqual(
    [...tiers].sort((a, b) => compareTier(b, a)),
    ["deep", "standard", "small"],
  );
});

test("mostCapableTier picks the highest rank, undefined for empty", () => {
  assert.equal(mostCapableTier(["small", "deep", "standard"]), "deep");
  assert.equal(mostCapableTier(["small"]), "small");
  assert.equal(mostCapableTier([]), undefined);
});
