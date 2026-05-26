import { describe, it, expect } from "vitest";
import { scheduleWave, buildProviderModelKey } from "../src/quota/scheduler.js";
import type { QuotaStateEntry } from "../src/quota/types.js";
import type { SessionConfig } from "../src/types/sessionConfig.js";
import {
  decayWeight,
  computeMaxSafeConcurrency,
  computeRampUpConcurrency,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
} from "../src/quota/state.js";

const baseConfig: SessionConfig = {
  provider: "claude-code",
  quota: { enabled: true },
};

function makeEntry(overrides: Partial<QuotaStateEntry> = {}): QuotaStateEntry {
  return {
    updated_at: new Date().toISOString(),
    buckets: {},
    cooldown_until: null,
    last_429_at: null,
    consecutive_429_count: 0,
    ...overrides,
  };
}

describe("scheduleWave (quota module)", () => {
  it("returns requested concurrency when quota disabled", () => {
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: { ...baseConfig, quota: { enabled: false } },
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(result.wave_size).toBe(10);
    expect(result.confidence).toBe("high");
  });

  it("applies host concurrency limit", () => {
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
      hostConcurrencyLimit: {
        active_subagents: 3,
        source: "cli_flags",
        description: "test",
      },
    });
    expect(result.wave_size).toBeLessThanOrEqual(3);
  });

  it("applies RPM cap", () => {
    const config: SessionConfig = {
      ...baseConfig,
      quota: {
        enabled: true,
        models: {
          "test/model": { requests_per_minute: 5 },
        },
      },
    };
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: config,
      hostModel: "test/model",
      requestedConcurrency: 20,
    });
    expect(result.wave_size).toBeLessThanOrEqual(4);
  });

  it("respects cooldown — forces wave_size=1", () => {
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const entry = makeEntry({ cooldown_until: futureTime });
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
      quotaStateEntry: entry,
    });
    expect(result.wave_size).toBe(1);
    expect(result.cooldown_until).toBe(futureTime);
  });

  it("ignores expired cooldown", () => {
    const pastTime = new Date(Date.now() - 60_000).toISOString();
    const entry = makeEntry({
      cooldown_until: pastTime,
      buckets: {
        "1": { success_weight: 3, failure_weight: 0 },
        "2": { success_weight: 3, failure_weight: 0 },
        "3": { success_weight: 3, failure_weight: 0 },
      },
    });
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
      quotaStateEntry: entry,
    });
    expect(result.wave_size).toBeGreaterThan(1);
    expect(result.cooldown_until).toBeNull();
  });

  it("uses learned concurrency cap", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        "2": { success_weight: 5, failure_weight: 0 },
        "3": { success_weight: 1, failure_weight: 10 },
      },
    });
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 20,
      quotaStateEntry: entry,
    });
    expect(result.wave_size).toBeLessThanOrEqual(3);
  });

  it("ramps up concurrency after consecutive successes", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        "2": { success_weight: 5, failure_weight: 0 },
      },
    });
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: { ...baseConfig, quota: { enabled: true, ramp_up_enabled: true } },
      hostModel: null,
      requestedConcurrency: 20,
      quotaStateEntry: entry,
    });
    expect(result.wave_size).toBe(3);
  });

  it("throttles when quota source shows <10% remaining", () => {
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
      quotaSourceSnapshot: {
        remaining_pct: 0.05,
        reset_at: null,
        requests_remaining: null,
        tokens_remaining: null,
        captured_at: new Date().toISOString(),
        source: "test",
      },
    });
    expect(result.wave_size).toBe(1);
  });

  it("halves when quota source shows <30% remaining", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        "2": { success_weight: 5, failure_weight: 0 },
        "3": { success_weight: 5, failure_weight: 0 },
        "4": { success_weight: 5, failure_weight: 0 },
        "5": { success_weight: 5, failure_weight: 0 },
        "6": { success_weight: 5, failure_weight: 0 },
      },
    });
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 6,
      quotaStateEntry: entry,
      quotaSourceSnapshot: {
        remaining_pct: 0.2,
        reset_at: null,
        requests_remaining: null,
        tokens_remaining: null,
        captured_at: new Date().toISOString(),
        source: "test",
      },
    });
    expect(result.wave_size).toBeLessThanOrEqual(3);
  });

  it("uses per-slot token estimates for TPM capping", () => {
    const config: SessionConfig = {
      ...baseConfig,
      quota: {
        enabled: true,
        models: {
          "test/model": { input_tokens_per_minute: 10_000 },
        },
      },
    };
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: config,
      hostModel: "test/model",
      requestedConcurrency: 10,
      estimatedSlotTokens: [5000, 4000, 3000, 2000, 1000],
    });
    expect(result.wave_size).toBeLessThan(10);
  });

  it("defaults unknown hosted provider to concurrency 1", () => {
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(result.wave_size).toBe(1);
  });

  it("allows unlimited for local provider", () => {
    const result = scheduleWave({
      providerName: "local-subprocess",
      sessionConfig: {
        ...baseConfig,
        quota: { enabled: true, unknown_local_concurrency: "unlimited" },
      },
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(result.wave_size).toBe(10);
  });
});

describe("buildProviderModelKey", () => {
  it("combines provider and model", () => {
    expect(buildProviderModelKey("claude-code", "anthropic/claude-sonnet-4-6")).toBe(
      "claude-code/anthropic/claude-sonnet-4-6",
    );
  });

  it("uses wildcard when model is null", () => {
    expect(buildProviderModelKey("claude-code", null)).toBe("claude-code/*");
  });
});

describe("decayWeight", () => {
  it("returns 0 for zero weight", () => {
    expect(decayWeight(0, 24, 24)).toBe(0);
  });

  it("halves weight after one half-life", () => {
    expect(decayWeight(4, 24, 24)).toBeCloseTo(2, 5);
  });

  it("returns 0 for zero half-life", () => {
    expect(decayWeight(5, 1, 0)).toBe(0);
  });
});

describe("computeMaxSafeConcurrency", () => {
  it("returns 1 with no buckets", () => {
    expect(computeMaxSafeConcurrency(makeEntry(), 24)).toBe(1);
  });

  it("returns highest bucket with sufficient evidence", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        "2": { success_weight: 5, failure_weight: 0 },
        "3": { success_weight: 5, failure_weight: 0 },
        "4": { success_weight: 0, failure_weight: 5 },
      },
    });
    expect(computeMaxSafeConcurrency(entry, 24)).toBe(3);
  });

  it("stops at bucket with more failure than success", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        "2": { success_weight: 1, failure_weight: 2 },
      },
    });
    expect(computeMaxSafeConcurrency(entry, 24)).toBe(1);
  });
});

describe("computeRampUpConcurrency", () => {
  it("returns maxSafe+1 after sufficient clean successes", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        "2": { success_weight: 5, failure_weight: 0 },
      },
    });
    expect(computeRampUpConcurrency(entry, 24)).toBe(3);
  });

  it("does not ramp up with failures present", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        "2": { success_weight: 5, failure_weight: 0.1 },
      },
    });
    expect(computeRampUpConcurrency(entry, 24)).toBe(2);
  });

  it("does not ramp up with insufficient successes", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 1, failure_weight: 0 },
      },
    });
    expect(computeRampUpConcurrency(entry, 24)).toBe(1);
  });
});

describe("computeBackoffCooldownMs", () => {
  it("returns 60s for first 429", () => {
    expect(computeBackoffCooldownMs(1)).toBe(60_000);
  });

  it("doubles for each consecutive 429", () => {
    expect(computeBackoffCooldownMs(2)).toBe(120_000);
    expect(computeBackoffCooldownMs(3)).toBe(240_000);
  });

  it("caps at 15 minutes", () => {
    expect(computeBackoffCooldownMs(10)).toBe(15 * 60_000);
  });
});

describe("computeBackoffFailureWeight", () => {
  it("returns 1.0 for first 429", () => {
    expect(computeBackoffFailureWeight(1)).toBe(1.0);
  });

  it("escalates for consecutive 429s", () => {
    expect(computeBackoffFailureWeight(3)).toBe(2.0);
    expect(computeBackoffFailureWeight(5)).toBe(3.0);
  });
});
