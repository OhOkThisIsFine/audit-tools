/**
 * INV-2 — cross-provider quota signals, remediate side.
 *
 * Asserts the remediation orchestrator consumes the unified quota contract the
 * same way audit-code does:
 *   - the explicit silent-degrade marker rides each CapacityPool as a RAW signal
 *     and surfaces in the pool summary, never pre-folded into a slot count;
 *   - `buildConfirmedPools` (the remediation pool builder) attaches the marker
 *     from the probe status rather than swallowing it into a bare null snapshot;
 *   - the discovered capability window escapes the conservative 32k floor.
 *
 * Hermetic: under vitest the default-fetch proactive sources skip the network, so
 * the live per-provider endpoints are exercised by the gated audit-side probe, not
 * here. The degrade aggregation is driven through injected stub sources.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import {
  CompositeQuotaSource,
  probeQuotaSource,
  computeDispatchCapacity,
  summarizeDispatchCapacityPools,
  setQuotaStateDir,
} from "audit-tools/shared";
import type { CapacityPool, QuotaSource, QuotaUsageSnapshot } from "audit-tools/shared";
import { buildConfirmedPools } from "../../src/remediate/steps/dispatch.js";

const NOW = Date.parse("2026-06-19T12:00:00.000Z");

beforeAll(() => {
  // Isolate quota-state so the learned source has no entry (deterministic
  // not_applicable) and never reads a developer's real state.
  setQuotaStateDir(mkdtempSync(join(tmpdir(), "remediate-inv2-quota-")));
});

const snapshot = (remaining_pct: number | null): QuotaUsageSnapshot => ({
  remaining_pct,
  reset_at: null,
  requests_remaining: null,
  tokens_remaining: null,
  captured_at: new Date(NOW).toISOString(),
  source: "test",
});

function stubSource(name: string, status: "ok" | "degraded" | "not_applicable", snap: QuotaUsageSnapshot | null = null): QuotaSource {
  return {
    name,
    async queryCurrentUsage() {
      return snap;
    },
    async probeUsage() {
      return { snapshot: snap, status };
    },
  };
}

describe("INV-2 silent-degrade marker (shared contract)", () => {
  it("a degraded probe attaches quotaSignalDegraded as a raw, unfolded pool signal", () => {
    const pool: CapacityPool = {
      id: "claude-code/*",
      accountKey: "claude-code/*",
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: null,
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSourceSnapshot: null,
      quotaSignalDegraded: true,
    };
    // No pre-folded slot count lives on the pool — capacity is derived downstream.
    expect("slots" in pool).toBe(false);

    const capacity = computeDispatchCapacity({
      pools: [pool],
      sessionConfig: { quota: {} },
      pendingItemTokens: [10_000, 10_000],
    });
    const [summary] = summarizeDispatchCapacityPools(capacity);
    expect(summary.quota_signal_degraded).toBe(true);
    expect(summary.slots).toBeGreaterThanOrEqual(1); // the fold still happened in scheduleWave
  });

  it("a healthy pool omits the marker (positive signal, never a literal false)", () => {
    const pool: CapacityPool = {
      id: "claude-code/*",
      accountKey: "claude-code/*",
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: null,
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSourceSnapshot: snapshot(0.8),
    };
    const capacity = computeDispatchCapacity({
      pools: [pool],
      sessionConfig: { quota: {} },
      pendingItemTokens: [1_000],
    });
    const [summary] = summarizeDispatchCapacityPools(capacity);
    expect(summary.quota_signal_degraded).toBeUndefined();
    expect(summary.quota_source_snapshot).toEqual(snapshot(0.8));
  });

  it("CompositeQuotaSource.probeUsage reports a cascade degrade vs. an inert miss", async () => {
    const okFirst = new CompositeQuotaSource([
      stubSource("inert", "not_applicable"),
      stubSource("good", "ok", snapshot(0.5)),
    ]);
    expect((await okFirst.probeUsage("codex/*")).status).toBe("ok");

    const degraded = new CompositeQuotaSource([
      stubSource("inert", "not_applicable"),
      stubSource("dead", "degraded"),
    ]);
    expect((await degraded.probeUsage("codex/*")).status).toBe("degraded");

    const inert = new CompositeQuotaSource([stubSource("inert", "not_applicable")]);
    expect((await inert.probeUsage("codex/*")).status).toBe("not_applicable");
  });

  it("probeQuotaSource never over-claims a degrade for a bare queryCurrentUsage stub", async () => {
    const nullStub: QuotaSource = { name: "n", async queryCurrentUsage() { return null; } };
    expect((await probeQuotaSource(nullStub, "x/y")).status).toBe("not_applicable");
    const throwStub: QuotaSource = { name: "t", async queryCurrentUsage() { throw new Error("x"); } };
    expect((await probeQuotaSource(throwStub, "x/y")).status).toBe("degraded");
  });
});

describe("INV-2 discovered-window slot-rise (32k floor escape)", () => {
  it("a reported capability window outranks the conservative 32k default", () => {
    const base: CapacityPool = {
      id: "claude-code/*",
      accountKey: "claude-code/*",
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: null,
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSourceSnapshot: null,
    };
    const sessionConfig = {
      quota: { safety_margin: 1.0, input_tokens_per_minute: 1_000_000 },
    };
    const pendingItemTokens = new Array(12).fill(30_000);

    const floored = computeDispatchCapacity({
      pools: [{ ...base, discoveredLimits: { input_tokens_per_minute: 600_000 } }],
      sessionConfig,
      pendingItemTokens,
    });
    const lifted = computeDispatchCapacity({
      pools: [
        {
          ...base,
          discoveredLimits: { input_tokens_per_minute: 600_000, context_tokens: 200_000, output_tokens: 32_000 },
        },
      ],
      sessionConfig,
      pendingItemTokens,
    });

    expect(floored.primary.schedule.resolved_limits.context_tokens).toBe(32_000);
    expect(lifted.primary.schedule.resolved_limits.context_tokens).toBe(200_000);
    expect(lifted.total_slots).toBeGreaterThanOrEqual(floored.total_slots);
  });
});

describe("INV-2 buildConfirmedPools wiring (hermetic)", () => {
  it("builds pools that carry raw snapshots + omit the degrade marker when sources are not_applicable", async () => {
    // Under vitest the default-fetch proactive sources skip the network and the
    // isolated learned state has no entry → every probe is not_applicable, so no
    // pool should be FALSELY marked degraded.
    const pools = await buildConfirmedPools({
      sessionConfig: { quota: {} },
      hostContextTokens: 200_000,
      hostOutputTokens: 32_000,
    });
    expect(pools.length).toBeGreaterThanOrEqual(1);
    for (const pool of pools) {
      // Raw signals are present on the pool, not a pre-folded slot count.
      expect("slots" in pool).toBe(false);
      expect(pool).toHaveProperty("quotaSourceSnapshot");
      // not_applicable must leave the marker unset.
      expect(pool.quotaSignalDegraded).toBeUndefined();
    }

    // The discovered window flows through to the resolved limits.
    const capacity = computeDispatchCapacity({
      pools,
      sessionConfig: { quota: {} },
      pendingItemTokens: [10_000],
    });
    expect(capacity.primary.schedule.resolved_limits.context_tokens).toBe(200_000);
  });
});

