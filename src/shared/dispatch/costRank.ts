/**
 * Cost-first routing engine — the single authority for a dispatch pool's
 * `costRank` (the cheapest-capable-first sort key consumed by `admitBatch`).
 *
 * Design of record: `spec/cost-first-routing.md`. In brief, `costRank` used to
 * be `tierRank(pool.rank)` — a tier ORDINAL doubling as both cost and capability
 * signal. This module makes cost a real, independent axis resolved top-down over
 * three rungs (mirroring `resolveLimits`):
 *
 *   1. operator-confirmed ordering  (Gate-0 approved provider/model position)
 *   2. price band: an operator-declared per-source `$/Mtok` (authoritative over the
 *      catalog — the operator knows their own configured endpoint's cost, e.g. a free
 *      arbitrage backend declares 0), else the models.dev blended price
 *   3. tier ordinal                  (pre-existing fallback)
 *
 * The rungs occupy DISJOINT numeric bands so a dollar value is never compared
 * against a tier ordinal — the sort is always a well-defined total order even in
 * the edge case where pools in one pass resolve via different rungs (confirmed
 * pools first, then priced pools by dollars, then unknown-price pools by tier).
 *
 * Invariant-safe: price comes only from `resolveModelStatics` (degrade-to-empty
 * vendored dataset) — never a model→price literal in backend code.
 */

import type { DispatchModelTier } from "../types/stepContract.js";
import { tierRank } from "./tierRank.js";
import { resolveModelStatics, type ModelStatics } from "../quota/modelStatics.js";

/**
 * Blend weights for the single representative $/Mtok scalar. The audit/remediate
 * workload is prompt-heavy (reads far more than it writes), so input dominates —
 * but output price is typically 4–5× input per token, so it is weighted, not
 * dropped. A 3:1 input:output blend is a defensible general default.
 */
export const COST_BLEND_INPUT_WEIGHT = 0.75;
export const COST_BLEND_OUTPUT_WEIGHT = 0.25;

/**
 * Disjoint numeric bands per rung, so cross-rung values never interleave. A
 * confirmed position (small integer) always sorts below any priced pool, which
 * always sorts below any unknown-price pool. Widths comfortably exceed the range
 * of their payloads: confirmed positions are a handful of pools; blended $/Mtok
 * tops out well under the band width (models.dev's dearest models are ~$75/Mtok);
 * tierRank is 0..2.
 */
export const CONFIRMED_ORDER_BAND_BASE = 0;
export const PRICE_BAND_BASE = 1_000_000;
export const UNKNOWN_PRICE_BAND_BASE = 2_000_000;

/**
 * Width of the price band — the maximum in-band $/Mtok before a price would overflow
 * into the unknown-price band and invert ordering. models.dev's dearest models are
 * ~$75/Mtok, far inside this, but an OPERATOR-declared price is unbounded input, so
 * the declared rung guards against a nonsensical value silently breaking the
 * band-disjointness invariant (a declared price this large routes last, as unknown).
 */
export const PRICE_BAND_WIDTH = UNKNOWN_PRICE_BAND_BASE - PRICE_BAND_BASE;

/**
 * Blend a models.dev price pair into one representative $/Mtok scalar. Returns
 * `undefined` when the dataset carries no usable price (missing pair, or both
 * components absent/non-finite). A partial pair (only input, or only output)
 * degrades to the present component rather than to unknown.
 */
export function blendedPrice(price: ModelStatics["price"] | undefined): number | undefined {
  if (!price) return undefined;
  const input = typeof price.input === "number" && Number.isFinite(price.input) ? price.input : undefined;
  const output = typeof price.output === "number" && Number.isFinite(price.output) ? price.output : undefined;
  if (input !== undefined && output !== undefined) {
    return input * COST_BLEND_INPUT_WEIGHT + output * COST_BLEND_OUTPUT_WEIGHT;
  }
  if (input !== undefined) return input;
  if (output !== undefined) return output;
  return undefined;
}

/**
 * Resolve a model id to its blended $/Mtok price via the vendored models.dev
 * snapshot, or `undefined` when the model is unknown / the dataset is empty.
 *
 * Optional `provider` pins the native (per-provider) price; omitting it takes the
 * cheapest-collision default. Single-provider snapshots resolve identically
 * either way.
 */
export function resolveModelPrice(
  model: string | null | undefined,
  provider?: string | null,
): number | undefined {
  return blendedPrice(resolveModelStatics(model, provider)?.price);
}

export interface CostRankInput {
  /** Model id for the price lookup (rung 2). `null`/unknown ⇒ falls through. */
  model: string | null | undefined;
  /**
   * Optional provider that owns this pool's model. When set, the price lookup
   * pins that provider's native price on a cross-provider model-id collision;
   * omitting it takes the cheapest-collision default. No effect on a
   * single-provider snapshot.
   */
  provider?: string | null;
  /** Pool tier for the fallback ordinal (rung 3). */
  tier: DispatchModelTier | null | undefined;
  /**
   * Operator-declared `$/Mtok` for this pool's own configured source (rung 2,
   * authoritative OVER the models.dev lookup — the operator knows their endpoint's
   * price, e.g. a free arbitrage backend declares `0`). `null`/absent ⇒ fall through
   * to the models.dev price / tier. A declared `0` sorts free-first (price-band floor),
   * still BELOW any Gate-0 confirmed position (rung 1). A negative/non-finite value is
   * ignored (falls through), never trusted as "free".
   */
  declaredCostPerMtok?: number | null;
  /**
   * Operator-confirmed integer position for this pool's provider/model (rung 1).
   * `null`/absent when the run carries no confirmed ordering, or this pool was
   * not in it (e.g. a source pool that appeared after confirmation) — such a pool
   * falls through to price/tier and sorts AFTER the confirmed ones.
   */
  confirmedPosition?: number | null;
}

/**
 * Derive a pool's `costRank` (LOWER = cheaper). Total order across all pools in a
 * pass; see the band constants above for why cross-rung values never interleave.
 */
export function deriveCostRank(input: CostRankInput): number {
  // Rung 1 — operator-confirmed ordering is authoritative.
  if (
    typeof input.confirmedPosition === "number" &&
    Number.isFinite(input.confirmedPosition) &&
    input.confirmedPosition >= 0
  ) {
    return CONFIRMED_ORDER_BAND_BASE + input.confirmedPosition;
  }
  // Rung 2a — operator-declared per-source price is authoritative over the generic
  // models.dev catalog: the operator knows their own endpoint's cost. A declared 0
  // lands at the price-band floor → free-first, below any positive-priced pool (but
  // still above a rung-1 confirmed position). Negative/non-finite is ignored.
  if (
    typeof input.declaredCostPerMtok === "number" &&
    Number.isFinite(input.declaredCostPerMtok) &&
    input.declaredCostPerMtok >= 0 &&
    input.declaredCostPerMtok < PRICE_BAND_WIDTH
  ) {
    return PRICE_BAND_BASE + input.declaredCostPerMtok;
  }
  // Rung 2b — real blended price when the dataset knows the model.
  const price = resolveModelPrice(input.model, input.provider);
  if (price !== undefined) return PRICE_BAND_BASE + price;
  // Rung 3 — tier ordinal, offset above every priced pool (unknown = overflow).
  return UNKNOWN_PRICE_BAND_BASE + tierRank(input.tier);
}

/** One candidate provider/model to rank for the Gate-0 suggested ordering. */
export interface CostCandidate {
  /** Stable identifier for the candidate (provider name, or `provider/model`). */
  key: string;
  model?: string | null;
  /**
   * Optional owning provider; pins the native price on a cross-provider model-id
   * collision. Omit for the cheapest-collision default.
   */
  provider?: string | null;
  tier?: DispatchModelTier | null;
}

/** A candidate with its resolved price + the tool's suggested position. */
export interface OrderedCostCandidate extends CostCandidate {
  /** Blended $/Mtok, or `undefined` when the dataset can't price it. */
  blended_price?: number;
  price_known: boolean;
  /** 0-based suggested position (ascending cost). */
  suggested_order: number;
}

/**
 * Suggest a cost-ascending ordering for the Gate-0 confirmation surface: priced
 * candidates first (cheapest $/Mtok first), unknown-price candidates after,
 * ordered among themselves by capability tier (cheaper tier first). Stable on the
 * input `key` so equal-cost candidates keep a deterministic order. The operator
 * approves or reorders this; the confirmed order becomes rung 1.
 */
export function suggestCostOrdering(candidates: CostCandidate[]): OrderedCostCandidate[] {
  const priced = candidates.map((c) => {
    const price = resolveModelPrice(c.model, c.provider);
    return { candidate: c, price };
  });
  const sorted = [...priced].sort((a, b) => {
    const aKnown = a.price !== undefined;
    const bKnown = b.price !== undefined;
    if (aKnown && bKnown) {
      return a.price! - b.price! || compareKey(a.candidate.key, b.candidate.key);
    }
    if (aKnown !== bKnown) return aKnown ? -1 : 1; // known before unknown
    // Both unknown: order by capability tier, then key.
    return tierRank(a.candidate.tier) - tierRank(b.candidate.tier) ||
      compareKey(a.candidate.key, b.candidate.key);
  });
  return sorted.map((entry, index) => ({
    ...entry.candidate,
    blended_price: entry.price,
    price_known: entry.price !== undefined,
    suggested_order: index,
  }));
}

function compareKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Look up a pool's operator-confirmed position (rung 1) from a model-keyed map,
 * degrade-safe: `null` when there is no map, no model id, or no entry for it —
 * exactly the "fall through to price/tier" signal `deriveCostRank` expects.
 * Single-sourced so audit and remediate resolve rung 1 identically.
 */
export function lookupConfirmedPosition(
  positions: Map<string, number> | null | undefined,
  model: string | null | undefined,
): number | null {
  if (!positions || !model) return null;
  const hit = positions.get(model);
  return typeof hit === "number" && Number.isFinite(hit) ? hit : null;
}

/**
 * Build the model-keyed confirmed-position map from a confirmed provider pool's
 * entries. Each entry contributes its `cost_order` under its `model_id`; entries
 * without both are skipped (they fall through to price/tier at dispatch). The
 * one place the Gate-0 confirmed ordering is turned into a dispatch lookup, so
 * both orchestrators read it the same way.
 */
export function resolveConfirmedCostPositions(
  entries: ReadonlyArray<{ model_id?: string | null; cost_order?: number | null }> | null | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  if (!entries) return map;
  for (const entry of entries) {
    if (
      entry.model_id &&
      typeof entry.cost_order === "number" &&
      Number.isFinite(entry.cost_order) &&
      entry.cost_order >= 0
    ) {
      map.set(entry.model_id, entry.cost_order);
    }
  }
  return map;
}
