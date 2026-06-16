import type { DispatchModelHint, DispatchModelTier } from "@audit-tools/shared";
import { DISPATCH_TIER_RANK, DISPATCH_TIER_ORDER } from "@audit-tools/shared";
import type { DispatchComplexity } from "./types.js";
import {
  DEFAULT_DEEP_ROUTING_RISK,
  DEFAULT_STANDARD_ROUTING_RISK,
  DEFAULT_DISPATCH_CONFIRM_THRESHOLD,
  DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS,
} from "./types.js";
import type { DispatchFanout } from "./types.js";

// Model-tier routing: risk-primary baseline with complexity escalators, tier
// budget resolution, and dispatch fanout summary. No I/O.

// Re-export of the single shared tier-rank authority (P1). audit-code keeps the
// `TIER_RANK` / `TIER_ORDER` names that its callers + seam tests reference, but
// the values are now sourced from `@audit-tools/shared` so there is no second
// copy of the {small,standard,deep} ordering to drift.
export const TIER_RANK: Record<DispatchModelTier, number> = DISPATCH_TIER_RANK;

const SENSITIVE_HINT_LENSES = new Set(["security", "data_integrity", "reliability"]);

/**
 * Derive a packet's relative model rank from its `routing_risk` (the JIT graph
 * partition's max member risk) — the risk-primary baseline — with complexity
 * signals acting as ESCALATORS ONLY: they can raise the tier (a genuinely
 * large/critical-flow packet still gets the top rank at low risk) but never
 * lower the risk baseline. Cut points are relative positions on the normalized
 * risk scale, never model names (no-hardcoded-models invariant).
 */
export function resolveDispatchTier(params: {
  /** Max member risk from the partition; undefined when no partition ran. */
  routingRisk: number | undefined;
  complexity: DispatchComplexity;
  /** Relative cut-point overrides (sessionConfig.dispatch.routing_tiers). */
  routingTiers?: { deep_at?: number; standard_at?: number };
}): DispatchModelHint {
  const { routingRisk, complexity } = params;
  const deepAt = params.routingTiers?.deep_at ?? DEFAULT_DEEP_ROUTING_RISK;
  const standardAt =
    params.routingTiers?.standard_at ?? DEFAULT_STANDARD_ROUTING_RISK;

  const baseline: DispatchModelTier =
    routingRisk === undefined
      ? "small"
      : routingRisk >= deepAt
        ? "deep"
        : routingRisk >= standardAt
          ? "standard"
          : "small";
  const reasons: string[] = [
    routingRisk === undefined
      ? "routing_risk:unknown"
      : `routing_risk:${routingRisk.toFixed(2)}`,
  ];

  const deepEscalators: string[] = [];
  if (complexity.large_file_mode) deepEscalators.push("isolated_large_file");
  if (complexity.estimated_tokens >= DEEP_MODEL_HINT_MIN_ESTIMATED_TOKENS) {
    deepEscalators.push("high_estimated_tokens");
  }
  if (
    complexity.tags.some(
      (tag) => tag === "critical_flow" || tag.startsWith("critical_flow:"),
    )
  ) {
    deepEscalators.push("critical_flow");
  }
  if (
    complexity.tags.some(
      (tag) =>
        tag === "external_analyzer_signal" || tag.startsWith("external_tool:"),
    )
  ) {
    deepEscalators.push("external_analyzer_signal");
  }
  if (complexity.tags.includes("lens_verification")) {
    deepEscalators.push("lens_verification");
  }

  const standardEscalators: string[] = [];
  if (complexity.lenses.some((lens) => SENSITIVE_HINT_LENSES.has(lens))) {
    standardEscalators.push("sensitive_lens");
  }
  if (complexity.priority === "medium") {
    standardEscalators.push("medium_priority");
  }

  let tier = baseline;
  if (deepEscalators.length > 0 && TIER_RANK.deep > TIER_RANK[tier]) {
    tier = "deep";
  }
  if (standardEscalators.length > 0 && TIER_RANK.standard > TIER_RANK[tier]) {
    tier = "standard";
  }
  // Reasons stay attributable: the risk baseline first, then every escalator
  // that fired (even ones below the final tier — they explain the floor).
  reasons.push(...deepEscalators, ...standardEscalators);
  return { tier, reasons };
}

export const TIER_ORDER: DispatchModelTier[] = DISPATCH_TIER_ORDER;

/**
 * Fill per-tier budgets from the reported roster ranks. A tier the host did
 * not report falls back to the nearest reported rank (preferring the more
 * capable one on ties), mirroring how a host maps a tier hint onto its closest
 * available model.
 */
export function resolveTierBudgets(
  perRank: ReadonlyMap<DispatchModelTier, number>,
): Record<DispatchModelTier, number> {
  if (perRank.size === 0) {
    throw new Error("resolveTierBudgets requires at least one reported rank.");
  }
  const out = {} as Record<DispatchModelTier, number>;
  TIER_ORDER.forEach((tier, i) => {
    const direct = perRank.get(tier);
    if (direct !== undefined) {
      out[tier] = direct;
      return;
    }
    // Fall back to the NEAREST reported rank — preferring LOWER (less capable)
    // on ties so a tier is never over-budgeted with a larger window than the
    // actual model it maps to (COR-eebbabf7: was checking up before down, which
    // assigned the "deep" context window to "small"-tier packets when only a
    // higher rank was reported).
    for (let distance = 1; distance < TIER_ORDER.length; distance++) {
      const down = TIER_ORDER[i - distance];
      const up = TIER_ORDER[i + distance];
      if (down && perRank.has(down)) {
        out[tier] = perRank.get(down)!;
        return;
      }
      if (up && perRank.has(up)) {
        out[tier] = perRank.get(up)!;
        return;
      }
    }
  });
  return out;
}

export function computeDispatchFanout(params: {
  agentCount: number;
  maxConcurrent: number;
  confirmThreshold?: number;
}): DispatchFanout {
  const agentCount = params.agentCount;
  const maxConcurrent = params.maxConcurrent;
  const confirmThreshold =
    params.confirmThreshold ?? DEFAULT_DISPATCH_CONFIRM_THRESHOLD;
  const confirmationRecommended = agentCount > confirmThreshold;
  const dispatchSummary =
    `${agentCount} agent${agentCount !== 1 ? "s" : ""}, ` +
    `max ${maxConcurrent} concurrent (rolling)`;
  return {
    agent_count: agentCount,
    max_concurrent_agents: maxConcurrent,
    confirmation_recommended: confirmationRecommended,
    dispatch_summary: dispatchSummary,
  };
}
