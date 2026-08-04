/**
 * Provider-neutral cost rank for admission.
 *
 * Broker-owned provider/model ordering is intentionally absent. Audit-tools only
 * compares declared or catalog prices when multiple independently declared source
 * pools are eligible, then falls back to the pool's relative capability tier.
 */
import type { DispatchModelTier } from "../types/stepContract.js";
import { tierRank } from "./tierRank.js";
import { resolveModelStatics, type ModelStatics } from "../quota/modelStatics.js";

export const COST_BLEND_INPUT_WEIGHT = 0.75;
export const COST_BLEND_OUTPUT_WEIGHT = 0.25;
export const PRICE_BAND_BASE = 1_000_000;
export const UNKNOWN_PRICE_BAND_BASE = 2_000_000;
export const PRICE_BAND_WIDTH = UNKNOWN_PRICE_BAND_BASE - PRICE_BAND_BASE;

export function blendedPrice(price: ModelStatics["price"] | undefined): number | undefined {
  if (!price) return undefined;
  const input = typeof price.input === "number" && Number.isFinite(price.input) ? price.input : undefined;
  const output = typeof price.output === "number" && Number.isFinite(price.output) ? price.output : undefined;
  if (input !== undefined && output !== undefined) {
    return input * COST_BLEND_INPUT_WEIGHT + output * COST_BLEND_OUTPUT_WEIGHT;
  }
  return input ?? output;
}

export function resolveModelPrice(
  model: string | null | undefined,
  provider?: string | null,
): number | undefined {
  return blendedPrice(resolveModelStatics(model, provider)?.price);
}

export interface CostRankInput {
  model: string | null | undefined;
  provider?: string | null;
  tier: DispatchModelTier | null | undefined;
  declaredCostPerMtok?: number | null;
}

/** Derive a stable rank (lower is cheaper) without prescribing provider order. */
export function deriveCostRank(input: CostRankInput): number {
  if (
    typeof input.declaredCostPerMtok === "number" &&
    Number.isFinite(input.declaredCostPerMtok) &&
    input.declaredCostPerMtok >= 0 &&
    input.declaredCostPerMtok < PRICE_BAND_WIDTH
  ) {
    return PRICE_BAND_BASE + input.declaredCostPerMtok;
  }
  const price = resolveModelPrice(input.model, input.provider);
  if (price !== undefined) return PRICE_BAND_BASE + price;
  return UNKNOWN_PRICE_BAND_BASE + tierRank(input.tier);
}
