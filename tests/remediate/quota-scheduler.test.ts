import { describe, it, expect } from "vitest";
import type { QuotaStateEntry, SessionConfig } from "audit-tools/shared";
import {
  scheduleWave,
  buildProviderModelKey,
  decayWeight,
  computeMaxSafeConcurrency,
  computeRampUpConcurrency,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
  classifyProvider,
  computeDispatchCapacity,
  estimateTokensFromBytes,
  BYTES_PER_TOKEN,
  DEFAULT_SAFETY_MARGIN,
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
} from "audit-tools/shared";
import type { CapacityPool } from "audit-tools/shared";
import { HostSessionQuotaSource } from "audit-tools/shared";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// INV-remediate-tests-05: dispatch.ts scheduleWave must also be covered here
import { scheduleWave as dispatchScheduleWave } from "../../src/remediate/steps/dispatch.js";

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
    expect(result.max_concurrent).toBe(10);
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
    expect(result.max_concurrent).toBeLessThanOrEqual(3);
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
    expect(result.max_concurrent).toBeLessThanOrEqual(Math.floor(5 * DEFAULT_SAFETY_MARGIN));
  });

  it("respects cooldown — forces max_concurrent=1", () => {
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    const entry = makeEntry({ cooldown_until: futureTime });
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
      quotaStateEntry: entry,
    });
    expect(result.max_concurrent).toBe(1);
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
    expect(result.max_concurrent).toBeGreaterThan(1);
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
    expect(result.max_concurrent).toBeLessThanOrEqual(3);
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
    expect(result.max_concurrent).toBe(3);
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
    expect(result.max_concurrent).toBe(1);
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
    expect(result.max_concurrent).toBeLessThanOrEqual(3);
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
    expect(result.max_concurrent).toBeLessThan(10);
  });

  it("defaults agent-host providers to parallel dispatch, unknown providers to 1", () => {
    // claude-code fans out to parallel subagents, so an unknown model must not
    // collapse to serial (1) — it defaults to the agent-host parallel fallback.
    const agentHost = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(agentHost.max_concurrent).toBe(
      classifyProvider("claude-code").concurrencyFloor,
    );

    // A genuinely unknown (non-agent-host) provider stays conservative at 1.
    const unknown = scheduleWave({
      providerName: "subprocess-template",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(unknown.max_concurrent).toBe(1);
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
    expect(result.max_concurrent).toBe(10);
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

  it("does not ramp up when the top bucket carries meaningful failure evidence", () => {
    const entry = makeEntry({
      buckets: {
        "1": { success_weight: 5, failure_weight: 0 },
        // failure_weight >= MIN_EVIDENCE_WEIGHT (0.5) counts as real evidence, so
        // bucket 2 stays maxSafe (5 > 1.0) but ramp-up to 3 is suppressed.
        "2": { success_weight: 5, failure_weight: 1.0 },
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
    expect(computeBackoffCooldownMs(1)).toBe(BASE_COOLDOWN_MS);
  });

  it("doubles for each consecutive 429", () => {
    expect(computeBackoffCooldownMs(2)).toBe(120_000);
    expect(computeBackoffCooldownMs(3)).toBe(240_000);
  });

  it("caps at 15 minutes", () => {
    expect(computeBackoffCooldownMs(10)).toBe(MAX_COOLDOWN_MS);
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

// INV-remediate-tests-05: dispatch.ts scheduleWave — ensures the dispatch
// package's own scheduleWave wrapper is exercised, not only the shared version.
describe("dispatch.ts scheduleWave", () => {
  it("returns a wave schedule with max_concurrent when quota is disabled", async () => {
    const result = await dispatchScheduleWave({
      providerName: "claude-code",
      sessionConfig: { provider: "claude-code", quota: { enabled: false } },
      hostModel: null,
      itemCount: 5,
    });
    expect(result.max_concurrent).toBe(5);
  });

  it("caps concurrency at the host limit when quota is enabled", async () => {
    const result = await dispatchScheduleWave({
      providerName: "claude-code",
      sessionConfig: { provider: "claude-code", quota: { enabled: true } },
      hostModel: null,
      hostMaxConcurrent: 3,
      itemCount: 10,
    });
    expect(result.max_concurrent).toBeLessThanOrEqual(3);
  });
});

// ===========================================================================
// M5-BROKER — tool-enforced dispatch broker (CP-M5-BROKER).
// computeDispatchCapacity is the single admission chokepoint; classifyProvider
// is the single host-classification struct; HostSessionQuotaSource is the wired
// owned-account window; estimateTokensFromBytes is the deterministic-local token
// estimate. Obligations OBL-m5-broker-inv-1..9 (esp. inv-2 (a)-(d)).
// ===========================================================================

function brokerPool(overrides: Partial<CapacityPool> = {}): CapacityPool {
  return {
    id: "pool-a",
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    ...overrides,
  };
}

describe("M5 dispatch broker — classifyProvider single struct (inv-1, inv-7, CE-005)", () => {
  it("returns ONE struct { hostClass, concurrencyFloor, driverMechanism }", () => {
    const c = classifyProvider("claude-code");
    expect(c).toEqual({
      hostClass: "hosted",
      concurrencyFloor: c.concurrencyFloor,
      driverMechanism: c.driverMechanism,
    });
    expect(typeof c.concurrencyFloor).toBe("number");
    // Deterministic single outcome — claude-code is a capable agent host.
    expect(c.driverMechanism).toBe("y_dispatcher");
  });

  it("classifies a capable agent host onto the lifted agent-host floor (not the cold-start floor 1/3)", () => {
    const agentHost = classifyProvider("claude-code");
    expect(agentHost.hostClass).toBe("hosted");
    // The floor is lifted above the conservative cold-start floor (3) for a
    // capable agent host, surfaced ONLY via the struct's concurrencyFloor.
    expect(agentHost.concurrencyFloor).toBeGreaterThan(3);
    expect(agentHost.driverMechanism).toBe("y_dispatcher");

    const localBackend = classifyProvider("local-subprocess");
    expect(localBackend.hostClass).toBe("local");
    expect(localBackend.driverMechanism).toBe("in_process_slot_pull");
  });

  it("keys off provider-class, never a model-name table (inv-7)", () => {
    expect(classifyProvider("codex").hostClass).toBe("hosted");
    expect(classifyProvider("antigravity").hostClass).toBe("unknown");
  });

  it("exports NO standalone floor constant to re-derive from (CE-005)", async () => {
    const shared = await import("audit-tools/shared");
    expect("DEFAULT_FIRST_CONTACT_CONCURRENCY" in shared).toBe(false);
    expect("DEFAULT_AGENT_HOST_CONCURRENCY" in shared).toBe(false);
    expect("agentHostFallbackConcurrency" in shared).toBe(false);
  });

  it("source reads the floor off the struct, never a separable constant (no second cold-start table)", () => {
    // The only public floor surface is the struct; the scheduler's fallback wave
    // for a no-signal capable agent host equals that struct floor.
    const floor = classifyProvider("claude-code").concurrencyFloor;
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 50,
    });
    expect(result.max_concurrent).toBe(floor);
  });
});

describe("M5 dispatch broker — deterministic-local token estimate (inv-3)", () => {
  it("estimates tokens ONLY from local byte heuristics (BYTES_PER_TOKEN), never an API count", () => {
    expect(estimateTokensFromBytes(BYTES_PER_TOKEN * 100)).toBe(100);
    expect(estimateTokensFromBytes(BYTES_PER_TOKEN * 7 + 1)).toBe(8);
  });

  it("non-finite / non-positive sizes estimate to 0 so a missing size never inflates the budget", () => {
    expect(estimateTokensFromBytes(0)).toBe(0);
    expect(estimateTokensFromBytes(-100)).toBe(0);
    expect(estimateTokensFromBytes(Number.NaN)).toBe(0);
    expect(estimateTokensFromBytes(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("the broker module imports estimateTokensFromBytes (deterministic, no tokenizer dep)", () => {
    // Guards INV-BROKER deterministic-local-token-estimate at the source: the
    // brokered-dispatch slot estimator is byte-derived, never an API token count.
    const src = readFileSync(
      fileURLToPath(new URL("../../src/shared/repair/brokeredDispatch.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("estimateTokensFromBytes");
    expect(src).not.toMatch(/count_?tokens|countTokens|tokenizer/i);
  });
});

describe("M5 dispatch broker — never-over-dispatch admission (inv-2, inv-4)", () => {
  it("(a) refuses slots beyond the computed total_slots / host-concurrency cap", () => {
    const capacity = computeDispatchCapacity({
      pools: [
        brokerPool({
          hostConcurrencyLimit: { active_subagents: 2, source: "cli_flags", description: "t" },
        }),
      ],
      sessionConfig: baseConfig,
      pendingItemTokens: [1000, 1000, 1000, 1000, 1000],
    });
    // total_slots is the admission ceiling — five pending items, but the host cap
    // of 2 binds, so admission grants at most 2 and never the requested 5.
    expect(capacity.total_slots).toBeLessThanOrEqual(2);
    expect(capacity.binding_cap).toBe("host_concurrency");
  });

  it("(a) refuses beyond the RPM cap (floor(rpm*safetyMargin))", () => {
    const config: SessionConfig = {
      ...baseConfig,
      quota: { enabled: true, models: { "m": { requests_per_minute: 5 } } },
    };
    const capacity = computeDispatchCapacity({
      pools: [brokerPool({ hostModel: "m" })],
      sessionConfig: config,
      pendingItemTokens: Array.from({ length: 20 }, () => 100),
    });
    expect(capacity.total_slots).toBeLessThanOrEqual(Math.floor(5 * DEFAULT_SAFETY_MARGIN));
  });

  it("(a) refuses beyond the TPM budget (sumTopN <= input_tokens_per_minute*safetyMargin)", () => {
    const config: SessionConfig = {
      ...baseConfig,
      quota: { enabled: true, models: { "m": { input_tokens_per_minute: 10_000 } } },
    };
    const capacity = computeDispatchCapacity({
      pools: [brokerPool({ hostModel: "m" })],
      sessionConfig: config,
      pendingItemTokens: [5000, 4000, 3000, 2000, 1000],
    });
    const budget = 10_000 * DEFAULT_SAFETY_MARGIN;
    // Sum of the admitted per-slot estimates must not exceed the TPM budget.
    const sortedDesc = [5000, 4000, 3000, 2000, 1000];
    let sum = 0;
    for (let i = 0; i < capacity.total_slots; i++) sum += sortedDesc[i] ?? 0;
    expect(sum).toBeLessThanOrEqual(budget);
  });

  it("(a) an active cooldown forces the wave to 1", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const capacity = computeDispatchCapacity({
      pools: [brokerPool({ quotaStateEntry: makeEntry({ cooldown_until: future }) })],
      sessionConfig: baseConfig,
      pendingItemTokens: [100, 100, 100, 100],
    });
    expect(capacity.total_slots).toBe(1);
    expect(capacity.cooldown_until).toBe(future);
  });

  it("never grants more slots than pending items (admission is floored at 1, refusal is a refusal)", () => {
    const capacity = computeDispatchCapacity({
      pools: [brokerPool()],
      sessionConfig: baseConfig,
      pendingItemTokens: [100],
    });
    expect(capacity.total_slots).toBe(1);
  });

  it("throws TypeError on an empty pool set (caller routes empty_pool, fail-1)", () => {
    expect(() =>
      computeDispatchCapacity({ pools: [], sessionConfig: baseConfig, pendingItemTokens: [1] }),
    ).toThrow(TypeError);
  });
});

describe("M5 dispatch broker — HostSessionQuotaSource wired (inv-2(b), inv-5, inv-6, inv-8)", () => {
  const KEY = "claude-code/anthropic/claude-x";

  it("(b) a recorded host-session limit drives remaining_pct to 0 and the next admission throttles to 1", async () => {
    let nowMs = 1_000_000;
    const source = new HostSessionQuotaSource({ providerModelKey: KEY, now: () => nowMs });
    // Channel-isolated record from the ERROR channel.
    const event = source.recordLimit(
      "error",
      "You've hit your session limit · resets 3:30pm",
      "packet-1",
    );
    expect(event.recorded).toBe(true);

    const probe = await source.probeUsage(KEY);
    expect(probe.status).toBe("ok");
    expect(probe.snapshot?.remaining_pct).toBe(0);

    // Feeding that snapshot to the scheduler throttles the wave to 1 (CRITICAL band).
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
      quotaSourceSnapshot: probe.snapshot!,
    });
    expect(result.max_concurrent).toBe(1);
  });

  it("(inv-6) channel isolation: a limit string on the RESULT channel is never recorded", () => {
    const source = new HostSessionQuotaSource({ providerModelKey: KEY });
    const event = source.recordLimit(
      "result",
      "You've hit your session limit · resets 3:30pm",
      "packet-1",
    );
    expect(event.recorded).toBe(false);
    expect(event.cooldown_until).toBeNull();
  });

  it("(inv-5) own-provider only: not_applicable for a foreign key, never clobbers other sources", async () => {
    const source = new HostSessionQuotaSource({ providerModelKey: KEY });
    const probe = await source.probeUsage("some-other/provider");
    expect(probe.status).toBe("not_applicable");
    expect(probe.snapshot).toBeNull();
  });

  it("(d / inv-8) escalation fires after maxConsecutiveReLimits same-packet re-limits and the packet is no longer admitted", () => {
    let nowMs = 1_000_000;
    const escalations: unknown[] = [];
    const source = new HostSessionQuotaSource({
      providerModelKey: KEY,
      now: () => nowMs,
      maxConsecutiveReLimits: 2,
      onEscalation: (e) => escalations.push(e),
    });
    const limit = "You've hit your session limit";
    // 1st, 2nd within bound, 3rd crosses the bound (>2).
    expect(source.recordLimit("error", limit, "P").escalation).toBeNull();
    expect(source.recordLimit("error", limit, "P").escalation).toBeNull();
    const tripped = source.recordLimit("error", limit, "P");
    expect(tripped.escalation).not.toBeNull();
    expect(escalations).toHaveLength(1);
    // The escalated packet is terminal — admission must not re-arm it.
    expect(source.isEscalated("P")).toBe(true);
  });
});
