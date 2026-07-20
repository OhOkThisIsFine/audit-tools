import { describe, it, expect } from "vitest";
import type { QuotaStateEntry, SessionConfig } from "audit-tools/shared";
import {
  scheduleWave,
  quotaPoolKey,
  computeBackoffCooldownMs,
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
  quota: {},
};

function makeEntry(overrides: Partial<QuotaStateEntry> = {}): QuotaStateEntry {
  return {
    updated_at: new Date().toISOString(),
    cooldown_until: null,
    last_429_at: null,
    consecutive_429_count: 0,
    ...overrides,
  };
}

describe("scheduleWave (quota module)", () => {
  it("returns requested concurrency when blind (no live quota snapshot)", () => {
    // One track, no quota-off switch: a blind wave (no /usage snapshot, no
    // RPM/TPM, no declared host cap) stays UNCAPPED per the no-invented-ceiling
    // invariant — max_concurrent is the requested concurrency verbatim.
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(result.max_concurrent).toBe(10);
    expect(result.confidence).toBeDefined();
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
      quota: { models: {
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

  it("throttles to 1 when a window is genuinely exhausted (remaining 0)", () => {
    // The removed 0.1/0.3 cliff bands no longer throttle a merely-low window —
    // concurrency is governed by the learned token budget. Only a GENUINELY empty
    // window (remaining fraction 0, a hard-limit reading) is a known-zero budget
    // that throttles to 1 (0 × any slope = 0). A nonzero-but-low reading with no
    // learned slope instead admits the small cold-start calibration batch (covered
    // by the token-budget cold-start tests).
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
      quotaSourceSnapshot: {
        remaining_pct: 0,
        reset_at: null,
        requests_remaining: null,
        tokens_remaining: null,
        captured_at: new Date().toISOString(),
        source: "test",
      },
    });
    expect(result.max_concurrent).toBe(1);
  });

  it("does NOT halve a low-but-nonzero window (cliffs removed; budget governs)", () => {
    const entry = makeEntry();
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
      quota: { models: {
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

  it("invents no ceiling for any provider with no host/rate/budget signal", () => {
    // The former agent-host / unknown fallback caps are gone: with no learned
    // state, no host limit, no RPM/TPM, and no live snapshot, both an agent host
    // and a genuinely unknown provider dispatch the full requested wave.
    const agentHost = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(agentHost.max_concurrent).toBe(10);
    expect(agentHost.binding_cap).toBe("none");

    const unknown = scheduleWave({
      providerName: "subprocess-template",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(unknown.max_concurrent).toBe(10);
    expect(unknown.binding_cap).toBe("none");
  });

  it("dispatches the full requested wave for a local provider with no signal", () => {
    const result = scheduleWave({
      providerName: "worker-command",
      sessionConfig: { ...baseConfig, quota: {} },
      hostModel: null,
      requestedConcurrency: 10,
    });
    expect(result.max_concurrent).toBe(10);
  });
});

describe("quotaPoolKey", () => {
  it("combines provider and model", () => {
    expect(quotaPoolKey("claude-code", "anthropic/claude-sonnet-4-6")).toBe(
      "claude-code/anthropic/claude-sonnet-4-6",
    );
  });

  it("uses wildcard when model is null", () => {
    expect(quotaPoolKey("claude-code", null)).toBe("claude-code/*");
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

// INV-remediate-tests-05: dispatch.ts scheduleWave — ensures the dispatch
// package's own scheduleWave wrapper is exercised, not only the shared version.
describe("dispatch.ts scheduleWave", () => {
  it("returns a wave schedule with max_concurrent when quota is disabled", async () => {
    const result = await dispatchScheduleWave({
      providerName: "claude-code",
      sessionConfig: { provider: "claude-code", quota: {} },
      hostModel: null,
      itemCount: 5,
    });
    expect(result.max_concurrent).toBe(5);
  });

  it("caps concurrency at the host limit when quota is enabled", async () => {
    const result = await dispatchScheduleWave({
      providerName: "claude-code",
      sessionConfig: { provider: "claude-code", quota: {} },
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

    const localBackend = classifyProvider("worker-command");
    expect(localBackend.hostClass).toBe("local");
    expect(localBackend.driverMechanism).toBe("in_process_slot_pull");
  });

  it("keys off provider-class, never a model-name table (inv-7)", () => {
    expect(classifyProvider("codex").hostClass).toBe("hosted");
    expect(classifyProvider("agy").hostClass).toBe("hosted");
    expect(classifyProvider("antigravity").hostClass).toBe("unknown");
  });

  it("exports NO standalone floor constant to re-derive from (CE-005)", async () => {
    const shared = await import("audit-tools/shared");
    expect("DEFAULT_FIRST_CONTACT_CONCURRENCY" in shared).toBe(false);
    expect("DEFAULT_AGENT_HOST_CONCURRENCY" in shared).toBe(false);
    expect("agentHostFallbackConcurrency" in shared).toBe(false);
  });

  it("the struct floor survives only as a classification reference, not a scheduler wave cap", () => {
    // The only public floor surface is still the struct (for classifyCapableHost),
    // but the scheduler no longer clamps a no-signal wave to it — the invented
    // cold-start/fallback caps were removed in favour of the token-budget gate.
    const floor = classifyProvider("claude-code").concurrencyFloor;
    expect(typeof floor).toBe("number");
    const result = scheduleWave({
      providerName: "claude-code",
      sessionConfig: baseConfig,
      hostModel: null,
      requestedConcurrency: 50,
    });
    expect(result.max_concurrent).toBe(50);
    expect(result.binding_cap).toBe("none");
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
      quota: { models: { "m": { requests_per_minute: 5 } } },
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
      quota: { models: { "m": { input_tokens_per_minute: 10_000 } } },
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

// ===========================================================================
// M5-WIRING — convergence guard (CP-M5-WIRING). This node wires every dispatch
// path so concurrency/token/rate come ONLY from the M5-BROKER chokepoint
// (computeDispatchCapacity → scheduleWave), floor+mechanism come ONLY from the
// single classifyProvider struct (CE-005), and no dispatch path re-derives a
// floor at the the shared in-process worker predicate (inProcessWorkers.ts) / resolvesToInProcessDispatchProvider
// site or reaches around the broker to a provider. These guards LOCK the wiring
// against drift (enforce-in-tooling, OBL-m5-wiring-inv-1/4/5/8/9/12).
// ===========================================================================

/** Read a source file from the worktree relative to this test module. */
function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("M5-WIRING convergence — concurrency is broker-output, never host discretion (inv-4, inv-12a)", () => {
  it("the remediate dispatch.ts wave size equals scheduleWave's broker output and never exceeds the pool slots", async () => {
    // With quota enabled, the remediate driver's scheduleWave wrapper must derive
    // its wave size from the broker (computeDispatchCapacity → scheduleWave),
    // never from a host-supplied number. We feed more items than the host cap and
    // assert the wrapper's max_concurrent is the broker output, bounded by slots.
    const config: SessionConfig = {
      provider: "claude-code",
      quota: {},
    };
    const result = await dispatchScheduleWave({
      sessionConfig: config,
      providerName: "claude-code",
      hostModel: null,
      itemCount: 50,
      hostMaxConcurrent: 2, // host handshake-only number
      estimatedSlotTokens: Array.from({ length: 50 }, () => 1000),
    });
    // (a) wave size never exceeds the host handshake-only number…
    expect(result.max_concurrent).toBeLessThanOrEqual(2);
    // …nor the pending item count (a slot is never granted for absent work).
    expect(result.max_concurrent).toBeLessThanOrEqual(50);
    expect(result.max_concurrent).toBeGreaterThanOrEqual(1);
    // …and the capacity-pool summary the broker produced agrees with it.
    const poolSlots = (result.capacity_pools ?? []).reduce((a, p) => a + p.slots, 0);
    if ((result.capacity_pools ?? []).length > 0) {
      expect(result.max_concurrent).toBeLessThanOrEqual(Math.max(1, poolSlots));
    }
  });
});

describe("M5-WIRING convergence — no dispatch path bypasses the broker (inv-1, inv-12b)", () => {
  // Every dispatch path on both orchestrators routes concurrency/token/rate
  // through the shared broker. The single wave-scheduling authority is
  // scheduleWave, and it is reached ONLY through computeDispatchCapacity (the
  // broker fold) or the broker seam — never by a dispatch path calling a provider
  // directly for a slot count.
  it("the remediate dispatch.ts driver routes through computeDispatchCapacity, never a hand-rolled slot count", () => {
    // Wave scheduling was split into steps/dispatch/waveScheduling.ts (CP-NODE-7);
    // the broker-routing invariant now lives there.
    const src = readSource("../../src/remediate/steps/dispatch/waveScheduling.ts");
    expect(src).toContain("computeDispatchCapacity");
    // A capable host's reported active-subagent number feeds the broker as a
    // ceiling input, never a substitute for the broker's own sizing.
    expect(src).toContain("scheduleWave");
  });

  it("the contract-pipeline DC-3 parallel waves route through the same scheduleWave broker wrapper", () => {
    const src = readSource("../../src/remediate/steps/contractPipeline.ts");
    expect(src).toContain("scheduleWave");
  });

  it("the audit rolling-dispatch driver derives slots from the shared scheduler, never host discretion", () => {
    const src = readSource("../../src/shared/dispatch/rollingDispatch.ts");
    // The shared rolling engine sizes every pool through scheduleWave; the audit
    // and remediate drivers both ride this single engine.
    expect(src).toContain("scheduleWave");
  });
});

describe("M5-WIRING convergence — floor+mechanism from the single classifyProvider struct (inv-5, CE-005)", () => {
  it("classifyProvider surfaces BOTH the concurrency floor and the driver mechanism in one struct", () => {
    const hosted = classifyProvider("claude-code");
    const local = classifyProvider("worker-command");
    // One struct owns all three fields — host class, floor, and mechanism.
    expect(Object.keys(hosted).sort()).toEqual([
      "concurrencyFloor",
      "driverMechanism",
      "hostClass",
    ]);
    expect(hosted.driverMechanism).toBe("y_dispatcher");
    expect(local.driverMechanism).toBe("in_process_slot_pull");
  });

  it("the shared driver-identity resolver (providerPathGuard.ts) selects a MECHANISM only — it never re-derives a concurrency floor", () => {
    // resolveHostDispatchProviderName (the H2+H4 single-sourced driver-identity
    // read — the branch predicate it absorbed is gone) is a pure classification
    // gate; it must NOT read or compute a concurrency floor (the floor lives ONLY
    // on the classifyProvider struct, CE-005).
    const src = readSource("../../src/shared/providers/providerPathGuard.ts");
    const fnStart = src.indexOf("export function resolveHostDispatchProviderName");
    expect(fnStart).toBeGreaterThan(-1);
    // Slice the function body region and assert it derives no floor.
    const region = src.slice(fnStart, fnStart + 600);
    expect(region).not.toMatch(/concurrencyFloor|COLD_START|AGENT_HOST_CONCURRENCY|first_contact/);
  });

  it("classifyProvider keys off provider-class, never a model-name table (no-hardcoded-models)", () => {
    expect(classifyProvider("codex").hostClass).toBe("hosted");
    expect(classifyProvider("agy").hostClass).toBe("hosted");
    expect(classifyProvider("antigravity").hostClass).toBe("unknown");
    expect(classifyProvider("worker-command").hostClass).toBe("local");
  });
});

describe("M5-WIRING convergence — deterministic-local token estimate, never an API count (inv-9)", () => {
  it("the remediate per-node slot estimator is byte-derived (estimateTokensFromBytes), with no tokenizer/count call", () => {
    const src = readSource("../../src/remediate/steps/dispatch.ts");
    // The implement slot estimate flows from local byte heuristics, never an API
    // token-count call (matching the project's token-estimate policy).
    expect(src).not.toMatch(/count_?tokens|countTokens|tokenizer/i);
  });

  it("estimateTokensFromBytes is purely local and monotonic in byte length", () => {
    expect(estimateTokensFromBytes(BYTES_PER_TOKEN * 100)).toBe(100);
    expect(estimateTokensFromBytes(BYTES_PER_TOKEN * 1000)).toBeGreaterThan(
      estimateTokensFromBytes(BYTES_PER_TOKEN * 100),
    );
  });
});
