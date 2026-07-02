// Single shared dispatch tier-rank authority (P1 / drift-consolidation).
//
// Locks the invariant that the DispatchModelTier ORDERING lives in exactly one
// place (`audit-tools/shared` dispatch/tierRank). The previously-duplicated
// rank maps (audit TIER_RANK / quotaPool rankOrder, shared rollingDispatch
// DISPATCH_TIER_RANK, remediate RANK_ORDER ×2) now all source from here.

import { test, expect } from "vitest";
import {
  DISPATCH_TIER_RANK,
  DISPATCH_TIER_ORDER,
  DISPATCH_TIER_RANK_FALLBACK,
  tierRank,
  compareTier,
  mostCapableTier,
} from "../../dist/shared/index.js";

test("DISPATCH_TIER_RANK orders small < standard < deep", () => {
  expect(DISPATCH_TIER_RANK.small < DISPATCH_TIER_RANK.standard).toBeTruthy();
  expect(DISPATCH_TIER_RANK.standard < DISPATCH_TIER_RANK.deep).toBeTruthy();
});

test("DISPATCH_TIER_RANK covers exactly the three canonical tiers", () => {
  expect(Object.keys(DISPATCH_TIER_RANK).sort()).toEqual(["deep", "small", "standard"]);
});

test("DISPATCH_TIER_ORDER is derived ascending capability order", () => {
  expect(DISPATCH_TIER_ORDER).toEqual(["small", "standard", "deep"]);
  // Derived from the rank map — every adjacent pair strictly increases.
  for (let i = 1; i < DISPATCH_TIER_ORDER.length; i++) {
    expect(DISPATCH_TIER_RANK[DISPATCH_TIER_ORDER[i]] >
        DISPATCH_TIER_RANK[DISPATCH_TIER_ORDER[i - 1]]).toBeTruthy();
  }
});

test("tierRank maps an absent/unknown tier to the neutral middle (standard)", () => {
  expect(tierRank(undefined)).toBe(DISPATCH_TIER_RANK.standard);
  expect(tierRank(null)).toBe(DISPATCH_TIER_RANK.standard);
  expect(DISPATCH_TIER_RANK_FALLBACK).toBe(DISPATCH_TIER_RANK.standard);
  expect(tierRank("deep")).toBe(DISPATCH_TIER_RANK.deep);
});

test("compareTier sorts ascending; negate for most-capable-first", () => {
  const tiers = ["deep", "small", "standard"];
  expect([...tiers].sort(compareTier)).toEqual(["small", "standard", "deep"]);
  expect([...tiers].sort((a, b) => compareTier(b, a))).toEqual(["deep", "standard", "small"]);
});

test("mostCapableTier picks the highest rank, undefined for empty", () => {
  expect(mostCapableTier(["small", "deep", "standard"])).toBe("deep");
  expect(mostCapableTier(["small"])).toBe("small");
  expect(mostCapableTier([])).toBe(undefined);
});
