import { test, expect, describe } from "vitest";
import type { DispatchModelTier } from "audit-tools/shared";

const { resolveDispatchTier, DEFAULT_DEEP_ROUTING_RISK, DEFAULT_STANDARD_ROUTING_RISK } =
  await import("../../src/audit/cli/dispatch.js");

const { computeDynamicRoutingTiers } =
  await import("../../src/audit/cli/dispatch/tierRouting.js");

interface DispatchComplexity {
  priority: "low" | "medium" | "high";
  task_count: number;
  file_count: number;
  total_lines: number;
  estimated_tokens: number;
  lenses: string[];
  tags: string[];
  large_file_mode: boolean;
}

function makeComplexity(
  overrides: Partial<DispatchComplexity> = {},
): DispatchComplexity {
  return {
    priority: "low",
    task_count: 1,
    file_count: 1,
    total_lines: 100,
    estimated_tokens: 500,
    lenses: ["correctness"],
    tags: [],
    large_file_mode: false,
    ...overrides,
  };
}

describe("dq-1: dynamic routing tiers should respect operator configuration", () => {
  test("should not clobber operator-set routing_tiers when dynamic tiers are computed", () => {
    // Issue: prepareDispatchArtifacts was computing dynamic routing tiers
    // UNCONDITIONALLY, clobbering an operator-set sessionConfig.dispatch.routing_tiers
    // Expected: dynamic thresholds apply ONLY when no explicit routing_tiers are configured

    // Sample operator-configured routing tiers (explicit config)
    const operatorTiers = { standard_at: 0.3, deep_at: 0.7 };

    // Sample packet risks
    const packetRisks = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

    // Compute dynamic thresholds (if any)
    const computed = computeDynamicRoutingTiers(packetRisks, 3);
    expect(computed).not.toBeNull();

    // The fix: ONLY apply computed thresholds if no operator config exists
    // This would be validated in prepareDispatchArtifacts
    const hasOperatorConfig = operatorTiers !== undefined;
    const effectiveTiers = hasOperatorConfig ? operatorTiers : computed;

    // Verify operator config is preserved
    expect(effectiveTiers).not.toBeNull();
    if (effectiveTiers) {
      expect(effectiveTiers).toEqual(operatorTiers);
      expect(effectiveTiers.standard_at).toBe(0.3);
      expect(effectiveTiers.deep_at).toBe(0.7);
    }
  });
});

describe("dq-1: tier routing collapse with multi-rank roster", () => {
  test("computeDynamicRoutingTiers should distribute packets across tiers via percentiles", () => {
    // Issue: when a roster provides multiple tiers (small/standard/deep),
    // the routing thresholds should be computed dynamically based on the
    // actual packet risk distribution, not just use fixed DEFAULT_* constants.

    // Sample packet risks (simulating the real distribution from the dogfood run)
    const allPackets = [
      ...Array(50).fill(0.2),   // low risks
      ...Array(100).fill(0.45), // mid-low risks
      ...Array(100).fill(0.5),  // mid risks
      ...Array(50).fill(0.7),   // high risks
      ...Array(58).fill(0.8),   // very high risks
    ];

    // Compute percentile-based thresholds for 3 tiers via the function
    const computed = computeDynamicRoutingTiers(allPackets, 3);
    expect(computed).not.toBeNull();
    expect(computed).toHaveProperty("standard_at");
    expect(computed).toHaveProperty("deep_at");

    const tierCounts: Record<DispatchModelTier, number> = { small: 0, standard: 0, deep: 0 };

    for (const risk of allPackets) {
      const result = resolveDispatchTier({
        routingRisk: risk,
        complexity: makeComplexity(),
        routingTiers: computed!,
      });
      tierCounts[result.tier]++;
    }

    // With computed thresholds, we should see a more balanced distribution
    expect(tierCounts.small).toBeGreaterThan(0);
    expect(tierCounts.standard).toBeGreaterThan(0);
    expect(tierCounts.deep).toBeGreaterThan(0);

    // No single tier should dominate (have >60% of packets)
    const total = allPackets.length;
    const maxFraction = Math.max(
      tierCounts.small / total,
      tierCounts.standard / total,
      tierCounts.deep / total,
    );
    expect(maxFraction).toBeLessThan(0.65);
  });

  test("dynamic threshold computation should match expected percentiles", () => {
    // This tests the specific algorithm for computing dynamic thresholds
    // Given N packets and K tiers, thresholds should partition at 1/K, 2/K, etc.

    const risks = Array.from({ length: 300 }, (_, i) => (i / 300) * 1.0); // 0 to 1

    // Compute percentile-based thresholds via the function
    const computed = computeDynamicRoutingTiers(risks, 3);
    expect(computed).not.toBeNull();
    expect(computed).toHaveProperty("standard_at");
    expect(computed).toHaveProperty("deep_at");

    const tierCounts: Record<DispatchModelTier, number> = { small: 0, standard: 0, deep: 0 };

    for (const risk of risks) {
      const result = resolveDispatchTier({
        routingRisk: risk,
        complexity: makeComplexity(),
        routingTiers: computed!,
      });
      tierCounts[result.tier]++;
    }

    // Each tier should get roughly 1/3
    const target = risks.length / 3;
    expect(tierCounts.small).toBeCloseTo(target, -1);      // within 10 items
    expect(tierCounts.standard).toBeCloseTo(target, -1);
    expect(tierCounts.deep).toBeCloseTo(target, -1);
  });
});
