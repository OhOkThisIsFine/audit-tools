/**
 * Single shared dispatch tier-rank authority (P1 / drift-consolidation).
 *
 * The `DispatchModelTier` *type* (`small | standard | deep`) is single-sourced in
 * `types/stepContract.ts`; its *ordering* used to be re-declared in at least five
 * places (audit `tierRouting.TIER_RANK`, audit `quotaPool.rankOrder`, shared
 * `rollingDispatch.DISPATCH_TIER_RANK`, remediate `dispatch.RANK_ORDER` and the
 * local `rankOrder` reducer in `buildImplementModelHint`). Every copy used the
 * same `{small:0,standard:1,deep:2}` mapping, so they could silently drift. This
 * module is the one ordering authority — all of those sites now import from here.
 *
 * Serves the no-hardcoded-models invariant: a "tier" is a RELATIVE capability
 * label, never a model name, and its ordering lives in exactly one place.
 *
 * Pure / synchronous / zero-dependency beyond the type import.
 */

import type { DispatchModelTier } from "../types/stepContract.js";

/**
 * Canonical relative ordering of the dispatch tiers. Higher number = more
 * capable. The ONLY place this mapping is declared.
 */
export const DISPATCH_TIER_RANK: Record<DispatchModelTier, number> = {
  small: 0,
  standard: 1,
  deep: 2,
};

/**
 * Tiers in ascending capability order (`["small", "standard", "deep"]`). Derived
 * from {@link DISPATCH_TIER_RANK} so it can never disagree with the rank map.
 */
export const DISPATCH_TIER_ORDER: DispatchModelTier[] = (
  Object.keys(DISPATCH_TIER_RANK) as DispatchModelTier[]
).sort((a, b) => DISPATCH_TIER_RANK[a] - DISPATCH_TIER_RANK[b]);

/**
 * The neutral fallback rank for an absent/unknown tier: the MIDDLE tier
 * ("standard"). Used where a pool/packet declares no tier — a new provider is
 * treated as neutral rather than silently mis-classified (INV-shared-core-02).
 */
export const DISPATCH_TIER_RANK_FALLBACK = DISPATCH_TIER_RANK.standard;

/**
 * Numeric rank for a (possibly undefined) tier. An unknown/absent tier maps to
 * the neutral middle rank, never to the bottom — so a pool with no declared rank
 * is treated as "standard", matching the rolling-dispatch capability model.
 */
export function tierRank(tier: DispatchModelTier | null | undefined): number {
  if (tier == null) return DISPATCH_TIER_RANK_FALLBACK;
  return DISPATCH_TIER_RANK[tier] ?? DISPATCH_TIER_RANK_FALLBACK;
}

/**
 * Comparator over tiers: negative when `a` is less capable than `b`, positive
 * when more capable, zero when equal. `compareTier(a, b)` sorts ascending
 * (least-capable first); negate it for most-capable-first. Unknown tiers sort as
 * the neutral middle rank.
 */
export function compareTier(
  a: DispatchModelTier | null | undefined,
  b: DispatchModelTier | null | undefined,
): number {
  return tierRank(a) - tierRank(b);
}

/**
 * The most-capable tier among `tiers`, or `undefined` when the list is empty.
 * Replaces the ad-hoc `reduce` that picked the max tier in
 * `buildImplementModelHint`.
 */
export function mostCapableTier(
  tiers: ReadonlyArray<DispatchModelTier>,
): DispatchModelTier | undefined {
  let best: DispatchModelTier | undefined;
  for (const t of tiers) {
    if (best === undefined || tierRank(t) > tierRank(best)) best = t;
  }
  return best;
}
