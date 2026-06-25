import { describe, it, expect, vi, afterEach } from "vitest";
import {
  detectHostConcurrencyFromEnv,
  resolveHostConcurrencyLimit,
  scheduleWave,
  buildDispatchQuota,
  normalizeSlotTokens,
  type WaveScheduleResult,
} from "../../src/remediate/steps/dispatch.js";
import {
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
} from "../../src/remediate/quota/index.js";
import {
  CODEX_DESKTOP_ACTIVE_SUBAGENT_LIMIT,
  createBrokeredRepairDispatch,
  classifyCapableHost,
  classifyProvider,
  computeDispatchCapacity,
  estimateSlotTokens,
  estimateTokensFromBytes,
  ESTIMATED_PROMPT_OVERHEAD_TOKENS,
  type BrokeredDispatchSlot,
  type CapacityPool,
  type QuotaStateEntry,
} from "audit-tools/shared";

describe("detectHostConcurrencyFromEnv", () => {
  it("returns limit from REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
    const result = detectHostConcurrencyFromEnv({
      REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "8",
    } as any);
    expect(result).not.toBeNull();
    expect(result!.active_subagents).toBe(8);
    expect(result!.source).toBe("environment");
  });

  it("falls back to CODEX_MAX_ACTIVE_SUBAGENTS", () => {
    const result = detectHostConcurrencyFromEnv({
      CODEX_MAX_ACTIVE_SUBAGENTS: "4",
    } as any);
    expect(result).not.toBeNull();
    expect(result!.active_subagents).toBe(4);
  });

  it("detects Codex Desktop with hardcoded limit", () => {
    const result = detectHostConcurrencyFromEnv({
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    } as any);
    expect(result).not.toBeNull();
    expect(result!.active_subagents).toBe(CODEX_DESKTOP_ACTIVE_SUBAGENT_LIMIT);
  });

  it("returns null when no env vars set", () => {
    const result = detectHostConcurrencyFromEnv({} as any);
    expect(result).toBeNull();
  });

  it("ignores non-positive values", () => {
    const result = detectHostConcurrencyFromEnv({
      REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "0",
    } as any);
    expect(result).toBeNull();
  });

  it("ignores non-numeric values", () => {
    const result = detectHostConcurrencyFromEnv({
      REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "abc",
    } as any);
    expect(result).toBeNull();
  });
});

describe("resolveHostConcurrencyLimit", () => {
  it("uses explicit hostMaxConcurrent over everything", () => {
    const result = resolveHostConcurrencyLimit({
      hostMaxConcurrent: 10,
      sessionConfig: { parallel_workers: 3 },
      env: { REMEDIATE_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "8" } as any,
    });
    expect(result!.active_subagents).toBe(10);
    expect(result!.source).toBe("cli_flags");
  });

  it("falls back to session config parallel_workers", () => {
    const result = resolveHostConcurrencyLimit({
      sessionConfig: { parallel_workers: 3 },
      env: {} as any,
    });
    expect(result!.active_subagents).toBe(3);
    expect(result!.source).toBe("session_config");
  });

  it("falls back to environment when no CLI or config", () => {
    const result = resolveHostConcurrencyLimit({
      sessionConfig: null,
      env: { CODEX_MAX_ACTIVE_SUBAGENTS: "4" } as any,
    });
    expect(result!.active_subagents).toBe(4);
    expect(result!.source).toBe("environment");
  });

  it("returns null when nothing is configured", () => {
    const result = resolveHostConcurrencyLimit({
      sessionConfig: null,
      env: {} as any,
    });
    expect(result).toBeNull();
  });
});

describe("scheduleWave", () => {
  it("uses host-reported limit as max_concurrent cap", async () => {
    const result = await scheduleWave({
      hostMaxConcurrent: 3,
      sessionConfig: null,
      itemCount: 10,
      env: {} as any,
    });
    expect(result.max_concurrent).toBe(3);
    expect(result.host_concurrency_limit!.active_subagents).toBe(3);
  });

  it("F4 inv-4: a host limit below the computed wave reduces max_concurrent to exactly active_subagents and binds host_concurrency", async () => {
    // No reported host limit → unknown-provider fallback yields a wave > 2.
    const uncapped = await scheduleWave({
      sessionConfig: null,
      itemCount: 20,
      env: {} as any,
    });
    expect(uncapped.max_concurrent).toBeGreaterThan(2);

    // Same request, but the host reports active_subagents=2 (strictly below the
    // computed wave). The reported limit is a hard ceiling: the wave is clamped
    // to exactly 2 and binding_cap is stamped host_concurrency.
    const capped = await scheduleWave({
      hostMaxConcurrent: 2,
      sessionConfig: null,
      itemCount: 20,
      env: {} as any,
    });
    expect(capped.max_concurrent).toBe(2);
    expect(capped.host_concurrency_limit!.active_subagents).toBe(2);
    expect(capped.binding_cap).toBe("host_concurrency");
  });

  it("defaults to 5 when no limit is known", async () => {
    const result = await scheduleWave({
      sessionConfig: null,
      itemCount: 20,
      env: {} as any,
    });
    expect(result.max_concurrent).toBe(5);
    expect(result.host_concurrency_limit).toBeNull();
  });

  it("max_concurrent never exceeds item count", async () => {
    const result = await scheduleWave({
      hostMaxConcurrent: 10,
      sessionConfig: null,
      itemCount: 3,
      env: {} as any,
    });
    expect(result.max_concurrent).toBe(3);
  });

  it("max_concurrent is always >= 1", async () => {
    const result = await scheduleWave({
      sessionConfig: null,
      itemCount: 0,
      env: {} as any,
    });
    expect(result.max_concurrent).toBe(1);
  });

  it("computes estimated_wave_tokens correctly", async () => {
    const result = await scheduleWave({
      hostMaxConcurrent: 4,
      sessionConfig: null,
      itemCount: 10,
      estimatedSlotTokens: Array.from({ length: 10 }, () => 600),
      env: {} as any,
    });
    expect(result.max_concurrent).toBe(4);
    expect(result.estimated_wave_tokens).toBe(2400);
  });

  it("estimated_wave_tokens is 0 when no estimate provided", async () => {
    const result = await scheduleWave({
      sessionConfig: null,
      itemCount: 5,
      env: {} as any,
    });
    expect(result.estimated_wave_tokens).toBe(0);
  });

  it("uses session config parallel_workers when no explicit limit", async () => {
    const result = await scheduleWave({
      sessionConfig: { parallel_workers: 7 },
      itemCount: 20,
      env: {} as any,
    });
    expect(result.max_concurrent).toBe(7);
  });

  it("roster handshake (quota disabled): honors the most capable rank's window", async () => {
    const result = await scheduleWave({
      sessionConfig: null,
      itemCount: 4,
      hostModels: [
        { rank: "small", context_tokens: 32_000, output_tokens: 8_000 },
        { rank: "deep", context_tokens: 200_000, output_tokens: 32_000 },
      ],
      env: {} as any,
    });
    expect(result.resolved_limits.context_tokens).toBe(200_000);
    expect(result.resolved_limits.output_tokens).toBe(32_000);
  });

  it("roster handshake (quota enabled): one capacity pool per rank, most capable first", async () => {
    const result = await scheduleWave({
      sessionConfig: { quota: { enabled: true } } as any,
      itemCount: 12,
      estimatedSlotTokens: Array.from({ length: 12 }, () => 500),
      hostModels: [
        { rank: "small", context_tokens: 32_000, output_tokens: 8_000 },
        { rank: "standard", context_tokens: 100_000, output_tokens: 16_000 },
        { rank: "deep", context_tokens: 200_000, output_tokens: 32_000 },
      ],
      env: {} as any,
    });
    const pools = result.capacity_pools ?? [];
    expect(pools.length).toBeGreaterThanOrEqual(1);
    expect(pools[0].rank).toBe("deep");
    expect(pools[0].resolved_limits.context_tokens).toBe(200_000);
    const ranks = pools.map((p) => p.rank);
    // Pools appear in most-capable-first order and never duplicate a rank.
    expect([...ranks]).toEqual(
      ["deep", "standard", "small"].filter((r) => ranks.includes(r as any)),
    );
  });

  it("opaque --host-model-id keys quota as provider/<id>; absent → provider/*", async () => {
    const withId = await scheduleWave({
      sessionConfig: { quota: { enabled: true } } as any,
      itemCount: 2,
      hostModelId: "opaque-x",
      env: {} as any,
    });
    expect(withId.capacity_pools?.[0].pool_id).toMatch(/\/opaque-x$/);
    const withoutId = await scheduleWave({
      sessionConfig: { quota: { enabled: true } } as any,
      itemCount: 2,
      env: {} as any,
    });
    expect(withoutId.capacity_pools?.[0].pool_id).toMatch(/\/\*$/);
  });

  it("per-rank model_id keys each roster pool independently", async () => {
    const result = await scheduleWave({
      sessionConfig: { quota: { enabled: true } } as any,
      itemCount: 8,
      estimatedSlotTokens: Array.from({ length: 8 }, () => 500),
      hostModels: [
        { rank: "standard", context_tokens: 100_000, output_tokens: 16_000, model_id: "rank-s" },
        { rank: "deep", context_tokens: 200_000, output_tokens: 32_000, model_id: "rank-d" },
      ],
      env: {} as any,
    });
    const pools = result.capacity_pools ?? [];
    expect(pools[0].pool_id).toMatch(/\/rank-d$/);
    if (pools.length > 1) {
      expect(pools[1].pool_id).toMatch(/\/rank-s$/);
    }
  });
});

describe("buildDispatchQuota", () => {
  it("assembles a valid quota object", async () => {
    const schedule = await scheduleWave({
      hostMaxConcurrent: 5,
      sessionConfig: null,
      itemCount: 10,
      estimatedSlotTokens: Array.from({ length: 10 }, () => 600),
      env: {} as any,
    });
    const quota = buildDispatchQuota("RUN-123", "document", schedule);
    expect(quota.contract_version).toBe("remediate-code-dispatch-quota/v1alpha2");
    expect(quota.run_id).toBe("RUN-123");
    expect(quota.phase).toBe("document");
    expect(quota.max_concurrent_agents).toBe(5);
    expect(quota.estimated_wave_tokens).toBe(3000);
    expect(quota.host_concurrency_limit!.active_subagents).toBe(5);
    expect(quota.confidence).toBeDefined();
    expect(quota.source).toBeDefined();
    expect(quota.resolved_limits).toBeDefined();
    expect(quota.binding_cap).toBe("host_concurrency");
    expect(quota.capacity_pools).toEqual([
      expect.objectContaining({
        pool_id: "claude-code/*",
        slots: 5,
        binding_cap: "host_concurrency",
      }),
    ]);
  });

  it("works for implement phase", async () => {
    const schedule = await scheduleWave({
      sessionConfig: null,
      itemCount: 3,
      env: {} as any,
    });
    const quota = buildDispatchQuota("RUN-456", "implement", schedule);
    expect(quota.phase).toBe("implement");
    expect(quota.max_concurrent_agents).toBe(3);
    expect(quota.host_concurrency_limit).toBeNull();
  });
});

function makeQuotaStateEntry(
  overrides: Partial<QuotaStateEntry> = {},
): QuotaStateEntry {
  return {
    updated_at: "2026-01-01T00:00:00.000Z",
    buckets: {},
    cooldown_until: null,
    last_429_at: null,
    ...overrides,
  };
}

async function makeScheduleResult(): Promise<WaveScheduleResult> {
  return await scheduleWave({
    hostMaxConcurrent: 4,
    sessionConfig: null,
    itemCount: 4,
    env: {} as any,
  });
}

describe("buildDispatchQuota — backoff state from learned quota entry", () => {
  it("populates backoff_state when consecutive_429_count > 0", async () => {
    const schedule = await makeScheduleResult();
    const entry = makeQuotaStateEntry({ consecutive_429_count: 3 });

    const quota = buildDispatchQuota("RUN-429", "document", schedule, entry);

    expect(quota.backoff_state).not.toBeNull();
    expect(quota.backoff_state!.consecutive_429_count).toBe(3);
    expect(quota.backoff_state!.current_cooldown_ms).toBe(
      computeBackoffCooldownMs(3),
    );
    expect(quota.backoff_state!.current_failure_weight).toBe(
      computeBackoffFailureWeight(3),
    );
  });

  it("leaves backoff_state null when consecutive_429_count is 0", async () => {
    const schedule = await makeScheduleResult();
    const entry = makeQuotaStateEntry({ consecutive_429_count: 0 });

    const quota = buildDispatchQuota("RUN-ok", "document", schedule, entry);

    expect(quota.backoff_state).toBeNull();
  });

  it("leaves backoff_state null when no quota entry is supplied", async () => {
    const schedule = await makeScheduleResult();

    const quota = buildDispatchQuota("RUN-none", "document", schedule);

    expect(quota.backoff_state).toBeNull();
  });

  it("passes quota_source_snapshot through from the schedule", async () => {
    const base = await makeScheduleResult();
    const snapshot = {
      remaining_pct: 42,
      reset_at: "2026-01-01T01:00:00.000Z",
      requests_remaining: 100,
      tokens_remaining: 50_000,
      captured_at: "2026-01-01T00:30:00.000Z",
      source: "test-source",
    };
    const schedule: WaveScheduleResult = {
      ...base,
      quota_source_snapshot: snapshot,
    };

    const quota = buildDispatchQuota("RUN-snap", "implement", schedule);

    expect(quota.quota_source_snapshot).toEqual(snapshot);
  });
});

describe("scheduleWave — quota-enabled path", () => {
  it("forwards estimatedSlotTokens to the quota scheduler and returns a usable schedule", async () => {
    const result = await scheduleWave({
      sessionConfig: { quota: { enabled: true } },
      itemCount: 3,
      estimatedSlotTokens: [1000, 2000, 3000],
      env: {} as any,
    });

    // The quota path (not the default early-return) was taken: a positive,
    // integral wave size with defined confidence/source comes back.
    expect(Number.isInteger(result.max_concurrent)).toBe(true);
    expect(result.max_concurrent).toBeGreaterThan(0);
    expect(result.confidence).toBeDefined();
    expect(result.source).toBeDefined();
    expect(result.capacity_pools).toEqual([
      expect.objectContaining({
        pool_id: "claude-code/*",
        slots: result.max_concurrent,
      }),
    ]);
  });
});

describe("scheduleWave — host capability handshake (N8)", () => {
  it("sizes resolved_limits to the host-reported window on the default path", async () => {
    const result = await scheduleWave({
      sessionConfig: null, // quota disabled → default early-return branch
      itemCount: 3,
      hostContextTokens: 200_000,
      hostOutputTokens: 32_000,
      env: {} as any,
    });
    expect(result.resolved_limits.context_tokens).toBe(200_000);
    expect(result.resolved_limits.output_tokens).toBe(32_000);
  });

  it("falls back to the conservative 32k floor when no window is reported", async () => {
    const result = await scheduleWave({
      sessionConfig: null,
      itemCount: 3,
      env: {} as any,
    });
    expect(result.resolved_limits.context_tokens).toBe(32_000);
    expect(result.resolved_limits.output_tokens).toBe(4_096);
  });

  it("lifts resolved_limits above the floor on the quota-enabled path", async () => {
    const floor = await scheduleWave({
      sessionConfig: { quota: { enabled: true } },
      itemCount: 3,
      estimatedSlotTokens: [1000, 2000, 3000],
      env: {} as any,
    });
    const discovered = await scheduleWave({
      sessionConfig: { quota: { enabled: true } },
      itemCount: 3,
      estimatedSlotTokens: [1000, 2000, 3000],
      hostContextTokens: 200_000,
      hostOutputTokens: 32_000,
      env: {} as any,
    });
    // Without a handshake the discovered_capability rung is absent → conservative
    // floor; reporting the real window sizes the budget up to it.
    expect(floor.resolved_limits.context_tokens).toBe(32_000);
    expect(discovered.resolved_limits.context_tokens).toBe(200_000);
  });
});

// ---------------------------------------------------------------------------
// F4 BrokeredRepairDispatch seam (CP-NODE-38) — single gated chokepoint.
// ---------------------------------------------------------------------------

function slot(slotId: string, payloadBytes: number): BrokeredDispatchSlot {
  return { slotId, payloadBytes };
}

describe("estimateSlotTokens (deterministic-local)", () => {
  it("is byte-derived plus a fixed prompt overhead and never an API call", () => {
    const a = estimateSlotTokens(slot("a", 4000));
    const b = estimateSlotTokens(slot("a", 4000));
    expect(a).toBe(b); // deterministic
    // 4000 bytes / 4 = 1000 tokens + 900 overhead
    expect(a).toBe(1900);
  });

  it("zero bytes estimates to just the prompt overhead", () => {
    expect(estimateSlotTokens(slot("z", 0))).toBe(900);
  });

  // F4 inv-2: the broker's per-wave token budget derives SOLELY from
  // estimateTokensFromBytes (BYTES_PER_TOKEN=4) + fixed prompt overhead — a
  // deterministic local arithmetic, never a network token-counting call. Feed
  // known byte sizes and assert the exact, reproducible estimatedWaveTokens with
  // no provider I/O: any global fetch/HTTP touch fails the test.
  it("broker estimatedWaveTokens is exact, reproducible, and performs no network I/O", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network token-count attempted — inv-2 violated");
    });
    const prevFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchSpy;
    try {
      const broker = createBrokeredRepairDispatch();
      const slots = [slot("n1", 4000), slot("n2", 8000), slot("n3", 2000)];
      // Per slot: ceil(bytes/4) + 900 overhead → n1=1900, n2=2900, n3=1400.
      // Host ceiling caps the wave at 2 slots; the budget fitter admits them in
      // input order (n1, n2) → estimatedWaveTokens = 1900 + 2900 = 4800.
      const expected = 1900 + 2900;
      const run = () =>
        broker.broker({
          providerName: "claude-code",
          sessionConfig: {},
          hostModel: null,
          slots,
          hostConcurrencyLimit: { active_subagents: 2, source: "session_config" } as any,
        });
      const a = run();
      const b = run();
      expect(a.estimatedWaveTokens).toBe(expected);
      expect(b.estimatedWaveTokens).toBe(a.estimatedWaveTokens); // reproducible
      expect(fetchSpy).not.toHaveBeenCalled(); // zero provider I/O
    } finally {
      (globalThis as any).fetch = prevFetch;
    }
  });
});

describe("classifyCapableHost (off the cold-start floor)", () => {
  it("a first-contact host with no signal is NOT capable", () => {
    expect(
      classifyCapableHost({ sessionConfig: {}, hostConcurrencyLimit: null, quotaStateEntry: null }),
    ).toBe(false);
  });

  it("a host reporting a ceiling above the floor IS capable", () => {
    expect(
      classifyCapableHost({
        sessionConfig: {},
        hostConcurrencyLimit: { active_subagents: 8, source: "session_config" } as any,
        quotaStateEntry: null,
      }),
    ).toBe(true);
  });

  it("a host reporting a ceiling at/below the floor is NOT capable", () => {
    expect(
      classifyCapableHost({
        sessionConfig: { quota: { first_contact_concurrency: 3 } } as any,
        hostConcurrencyLimit: { active_subagents: 3, source: "session_config" } as any,
        quotaStateEntry: null,
      }),
    ).toBe(false);
  });

  it("learned evidence above the floor lifts the host off it", () => {
    const entry = makeQuotaStateEntry({
      buckets: { "6": { weight: 5, last_success_at: "2026-01-01T00:00:00.000Z" } } as any,
    });
    expect(
      classifyCapableHost({ sessionConfig: {}, hostConcurrencyLimit: null, quotaStateEntry: entry }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F4 inv-7 (CP-NODE-45) — F4-owned classification + driver-tier selection.
//
// The broker derives its driver tier (Y-primary vs slot-pull, expressed as the
// capableHost classification) and cold-start classification from F4's OWN
// limits.ts `classifyProvider` + the host-concurrency handshake — it consults NO
// F3 descriptor. The BrokerDispatchInput surface carries no descriptor field; the
// only signals it reads are the host roster/concurrency the caller injects, and
// the driver tier follows F4's own classification of those signals.
// ---------------------------------------------------------------------------

describe("F4 inv-7 — F4-owned classification + driver-tier selection", () => {
  it("classifyProvider is F4-owned and maps hosted agent backends to 'hosted'", () => {
    // F4's own classifier — no F3 descriptor involved.
    expect(classifyProvider("claude-code")).toBe("hosted");
    expect(classifyProvider("codex")).toBe("hosted");
    expect(classifyProvider("local-subprocess")).toBe("local");
    expect(classifyProvider("antigravity")).toBe("unknown");
  });

  it("driver tier follows F4's classification of the INJECTED host concurrency signal", () => {
    const broker = createBrokeredRepairDispatch();
    const base = {
      providerName: "claude-code" as const,
      sessionConfig: {},
      hostModel: null,
      slots: [slot("n1", 500), slot("n2", 500)],
    };

    // Host roster reports a ceiling at/below the cold-start floor → slot-pull
    // tier (not yet capable): F4 classifies it off its OWN floor.
    const coldStart = broker.broker({
      ...base,
      hostConcurrencyLimit: { active_subagents: 1, source: "session_config" } as any,
    });
    expect(coldStart.capableHost).toBe(false);

    // Host roster reports head-room above the floor → Y-primary tier (capable):
    // the tier flips purely from F4's classification of the injected signal.
    const capable = broker.broker({
      ...base,
      hostConcurrencyLimit: { active_subagents: 8, source: "session_config" } as any,
    });
    expect(capable.capableHost).toBe(true);
  });

  it("the broker decision is identical regardless of any F3-style descriptor field (none is consulted)", () => {
    const broker = createBrokeredRepairDispatch();
    const input = {
      providerName: "claude-code" as const,
      sessionConfig: {},
      hostModel: null,
      slots: [slot("n1", 500), slot("n2", 500), slot("n3", 500)],
      hostConcurrencyLimit: { active_subagents: 8, source: "session_config" } as any,
    };
    const plain = broker.broker(input);
    // Inject an arbitrary F3-shaped descriptor as an extra field; the broker must
    // ignore it entirely — classification/tier come only from F4's own signals.
    const withDescriptor = broker.broker({
      ...input,
      f3Descriptor: { tier: "slot-pull", driver: "Y-secondary" },
    } as any);
    expect(withDescriptor.capableHost).toBe(plain.capableHost);
    expect(withDescriptor.admitted).toBe(plain.admitted);
    expect(withDescriptor.bindingCap).toBe(plain.bindingCap);
    expect(withDescriptor.schedule.max_concurrent).toBe(plain.schedule.max_concurrent);
  });
});

describe("createBrokeredRepairDispatch — broker()", () => {
  const broker = createBrokeredRepairDispatch();

  it("admits a sized wave under the host concurrency ceiling", () => {
    const decision = broker.broker({
      providerName: "claude-code",
      sessionConfig: {},
      hostModel: null,
      slots: [slot("n1", 1000), slot("n2", 1000), slot("n3", 1000)],
      hostConcurrencyLimit: { active_subagents: 2, source: "session_config" } as any,
    });
    expect(decision.admission).toBe("admitted");
    expect(decision.admitted).toBe(2);
    expect(decision.admittedSlotIds).toEqual(["n1", "n2"]);
    expect(decision.capableHost).toBe(false);
    expect(decision.estimatedWaveTokens).toBeGreaterThan(0);
  });

  it("refuses over-budget when even the top slot exceeds the usable window", () => {
    // Conservative 32k floor → usable budget ~ (32000-4096)*0.7 ≈ 19532 tokens.
    // A ~30MB payload estimates far above that, so the single slot is refused.
    const decision = broker.broker({
      providerName: "claude-code",
      sessionConfig: {},
      hostModel: null,
      slots: [slot("huge", 30_000_000)],
    });
    expect(decision.admission).toBe("refused_over_budget");
    expect(decision.admitted).toBe(0);
    expect(decision.admittedSlotIds).toEqual([]);
  });

  it("surfaces a persisted cooldown_until from the quota state entry", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const decision = broker.broker({
      providerName: "openai-compatible",
      sessionConfig: { quota: { enabled: true } } as any,
      hostModel: null,
      slots: [slot("n1", 500)],
      quotaStateEntry: makeQuotaStateEntry({ cooldown_until: future }),
    });
    expect(decision.cooldownUntil).toBe(future);
    expect(decision.bindingCap).toBe("cooldown");
  });
});

// ---------------------------------------------------------------------------
// F4 inv-5 (CP-NODE-43) — critical snapshot throttles to 1 AND persists cooldown;
// a later transiently-null snapshot reads the persisted cooldown and STAYS at 1
// (CE-010). The persistence happens WITHIN the decision and WITHOUT making
// broker() asynchronous (a sibling sync test reads estimatedWaveTokens directly).
// ---------------------------------------------------------------------------

describe("F4 inv-5 — critical snapshot throttles to 1 and persists cooldown (CE-010)", () => {
  it("critical→throttle-to-1+cooldown; subsequent null snapshot stays at 1", () => {
    const broker = createBrokeredRepairDispatch();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const args = {
      providerName: "openai-compatible" as const,
      sessionConfig: { quota: { enabled: true } } as any,
      hostModel: null,
      // Several cheap slots so, absent throttling, the wave would size > 1.
      slots: Array.from({ length: 6 }, (_, i) => slot(`n${i}`, 500)),
    };

    // Decision 1: a real-time snapshot below CRITICAL (remaining_pct < 0.1) must
    // throttle the wave to exactly 1 and surface the snapshot's reset_at cooldown.
    const critical = broker.broker({
      ...args,
      quotaSourceSnapshot: {
        remaining_pct: 0.05,
        reset_at: future,
        captured_at: new Date().toISOString(),
        source: "test",
      } as any,
    });
    expect(critical.schedule.max_concurrent).toBe(1);
    expect(critical.admitted).toBe(1);
    expect(critical.cooldownUntil).toBe(future);

    // Decision 2: a transiently-null snapshot for the SAME pool. The persisted
    // cooldown (recorded within decision 1) is read back, so the wave stays at 1.
    const followUp = broker.broker({
      ...args,
      quotaSourceSnapshot: null,
    });
    expect(followUp.schedule.max_concurrent).toBe(1);
    expect(followUp.admitted).toBe(1);
    expect(followUp.cooldownUntil).toBe(future);
    expect(followUp.bindingCap).toBe("cooldown");
  });

  it("broker() stays synchronous — the decision is a plain object, not a Promise", () => {
    const broker = createBrokeredRepairDispatch();
    const decision = broker.broker({
      providerName: "claude-code",
      sessionConfig: {},
      hostModel: null,
      slots: [slot("n1", 500), slot("n2", 500)],
      hostConcurrencyLimit: { active_subagents: 2, source: "session_config" } as any,
    });
    // A Promise would have no estimatedWaveTokens and would expose .then.
    expect((decision as any).then).toBeUndefined();
    expect(typeof decision.estimatedWaveTokens).toBe("number");
    expect(decision.estimatedWaveTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F4 inv-1 (CP-NODE-39) — single chokepoint, no over-dispatch.
//
// EVERY dispatch path sizes concurrency through the SAME shared scheduler:
//  - the wave/repair path: createBrokeredRepairDispatch().broker() -> scheduleWave
//  - the rolling engine path: computeDispatchCapacity (what reroutePackets calls)
//    -> schedulePool -> scheduleWave
// Both must clamp a request of N slots to the host concurrency cap (< N) and
// attribute the SAME binding_cap, so no path can over-dispatch past
// max_concurrent.
// ---------------------------------------------------------------------------

describe("F4 inv-1 — single chokepoint clamps N>cap to the host cap", () => {
  const HOST_CAP = 3;
  const N = 8; // requested slots, deliberately greater than the cap
  const hostLimit = {
    active_subagents: HOST_CAP,
    source: "session_config" as const,
  };

  it("repair entry (broker) returns admitted < N with binding_cap=host_concurrency", () => {
    const broker = createBrokeredRepairDispatch();
    const decision = broker.broker({
      providerName: "claude-code",
      sessionConfig: {},
      hostModel: null,
      // Small, equal payloads so the host cap (not the over-budget gate) binds.
      slots: Array.from({ length: N }, (_, i) => slot(`n${i}`, 500)),
      hostConcurrencyLimit: hostLimit as any,
    });
    expect(decision.admission).toBe("admitted");
    expect(decision.admitted).toBeLessThan(N);
    expect(decision.admitted).toBe(HOST_CAP);
    expect(decision.schedule.max_concurrent).toBe(HOST_CAP);
    expect(decision.bindingCap).toBe("host_concurrency");
  });

  it("rolling-engine entry (computeDispatchCapacity) routes the SAME cap", () => {
    const pool: CapacityPool = {
      id: "claude-code/*",
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: hostLimit,
    };
    const capacity = computeDispatchCapacity({
      pools: [pool],
      sessionConfig: {},
      // N pending items, each cheap — the host cap must bind the wave, not tokens.
      pendingItemTokens: Array.from({ length: N }, () => 500),
    });
    expect(capacity.total_slots).toBeLessThan(N);
    expect(capacity.total_slots).toBe(HOST_CAP);
    expect(capacity.primary.schedule.max_concurrent).toBe(HOST_CAP);
    expect(capacity.binding_cap).toBe("host_concurrency");
  });

  it("both entries agree on the same max_concurrent (one scheduling authority)", () => {
    const broker = createBrokeredRepairDispatch();
    const decision = broker.broker({
      providerName: "claude-code",
      sessionConfig: {},
      hostModel: null,
      slots: Array.from({ length: N }, (_, i) => slot(`n${i}`, 500)),
      hostConcurrencyLimit: hostLimit as any,
    });
    const capacity = computeDispatchCapacity({
      pools: [
        {
          id: "claude-code/*",
          providerName: "claude-code",
          hostModel: null,
          hostConcurrencyLimit: hostLimit,
        },
      ],
      sessionConfig: {},
      pendingItemTokens: Array.from({ length: N }, () => 500),
    });
    // Identical cap from both dispatch paths ⟹ a single scheduling chokepoint.
    expect(decision.schedule.max_concurrent).toBe(
      capacity.primary.schedule.max_concurrent,
    );
    expect(decision.bindingCap).toBe(capacity.binding_cap);
  });
});

// ---------------------------------------------------------------------------
// F4 inv-10 (CP-NODE-48) — O3 stage-2 patch + stage-3 re-dispatch arrive through
// the shared BrokeredRepairDispatch seam and flow through F4's broker, so EVERY
// dispatch (including a repair retry) passes the single chokepoint; land-order-
// safe (CE-002).
//
// O3's emit-validate-repair loop never calls scheduleWave / a provider directly:
// its stage-3 re-dispatch is issued ONLY via broker.broker(). This proves
//   (a) the re-dispatch sizes through the SAME scheduleWave authority — identical
//       max_concurrent + binding_cap as a direct scheduleWave call on the same
//       inputs (no second, drifting sizing path for repairs), and
//   (b) land-order safety: the admitted slots are a contiguous PREFIX of the
//       requested slots in priority order (a re-dispatched, higher-priority
//       repair slot lands before lower-priority work — never reordered/dropped
//       out from under an earlier slot).
// ---------------------------------------------------------------------------

describe("F4 inv-10 — O3 stage-3 re-dispatch flows through the broker chokepoint", () => {
  const HOST_CAP = 2;
  const hostLimit = { active_subagents: HOST_CAP, source: "session_config" as const };

  it("re-dispatch sizes through the broker's shared scheduleWave authority + buildConfirmedPools agree", () => {
    const broker = createBrokeredRepairDispatch();
    // Stage-3 re-dispatch: O3 re-issues the patched repair slot ahead of the
    // remaining work, all through the seam.
    const slots = [slot("repair-n1", 500), slot("n2", 500), slot("n3", 500)];

    const decision = broker.broker({
      providerName: "claude-code",
      sessionConfig: {},
      hostModel: null,
      slots,
      hostConcurrencyLimit: hostLimit as any,
    });

    // The re-dispatch passes the single chokepoint and sizes through the shared
    // wave-scheduling authority — no separate, drifting repair-only sizing path.
    expect(decision.admission).toBe("admitted");
    expect(decision.schedule.max_concurrent).toBe(HOST_CAP);
    expect(decision.bindingCap).toBe("host_concurrency");

    // The rolling-engine dispatch path (computeDispatchCapacity, the shape
    // buildConfirmedPools feeds) sizes the SAME re-dispatch identically — one
    // authority across the repair retry and the normal wave.
    const capacity = computeDispatchCapacity({
      pools: [
        {
          id: "claude-code/*",
          providerName: "claude-code",
          hostModel: null,
          hostConcurrencyLimit: hostLimit,
        },
      ],
      sessionConfig: {},
      pendingItemTokens: slots.map(estimateSlotTokens),
    });
    expect(decision.schedule.max_concurrent).toBe(
      capacity.primary.schedule.max_concurrent,
    );
    expect(decision.bindingCap).toBe(capacity.binding_cap);
  });

  it("is land-order-safe: admitted slots are a contiguous priority-order prefix (CE-002)", () => {
    const broker = createBrokeredRepairDispatch();
    // Re-dispatched repair slot is highest priority (index 0), followed by the
    // rest in priority order.
    const slots = [
      slot("repair-n1", 500),
      slot("n2", 500),
      slot("n3", 500),
      slot("n4", 500),
    ];

    const decision = broker.broker({
      providerName: "claude-code",
      sessionConfig: {},
      hostModel: null,
      slots,
      hostConcurrencyLimit: hostLimit as any,
    });

    // The admitted ids are exactly the leading `admitted` slots, in order — the
    // repair slot lands first and nothing is reordered or skipped.
    const expectedPrefix = slots.slice(0, decision.admitted).map((s) => s.slotId);
    expect(decision.admittedSlotIds).toEqual(expectedPrefix);
    expect(decision.admittedSlotIds[0]).toBe("repair-n1");
    expect(decision.admitted).toBe(HOST_CAP);
  });
});

// ---------------------------------------------------------------------------
// F4 fail-8 (CP-NODE-56) — O3 repair re-dispatch is NEVER issued outside the
// broker. Issuing it outside escapes the single gated chokepoint (quota read,
// deterministic-local estimate, over-budget refusal, await-completion handoff)
// and the cap / await-completion accounting. The seam PREVENTS that escape by
// being the SOLE dispatch surface: createBrokeredRepairDispatch() exposes only
// broker() + awaitNextCompletion(), with no second sizing path or provider
// handle to reach around. This asserts the NEGATIVE (no escape hatch) that
// inv-10 (positive: flows-through-and-sizes-identically) does not.
// ---------------------------------------------------------------------------

describe("F4 fail-8 — O3 repair re-dispatch never escapes the broker chokepoint", () => {
  it("the seam exposes ONLY the gated chokepoint methods — no escape hatch", () => {
    const broker = createBrokeredRepairDispatch();
    // The entire public dispatch surface is the two gated methods. Anything else
    // (a raw scheduleWave handle, a provider, a second repair-only sizing path)
    // would let O3's re-dispatch bypass the cap / await-completion accounting.
    expect(Object.keys(broker).sort()).toEqual(
      ["awaitNextCompletion", "broker"].sort(),
    );
    expect(typeof broker.broker).toBe("function");
    expect(typeof broker.awaitNextCompletion).toBe("function");
    // No provider / scheduler escape handle leaked onto the seam.
    expect((broker as any).scheduleWave).toBeUndefined();
    expect((broker as any).provider).toBeUndefined();
    expect((broker as any).dispatch).toBeUndefined();
  });

  it("a re-dispatch routed through broker() is gated identically to the first dispatch — one chokepoint, no drift", () => {
    const broker = createBrokeredRepairDispatch();
    const hostLimit = { active_subagents: 2, source: "session_config" as const };
    const slots = [slot("repair-n1", 500), slot("n2", 500), slot("n3", 500)];
    const args = {
      providerName: "claude-code" as const,
      sessionConfig: {},
      hostModel: null,
      slots,
      hostConcurrencyLimit: hostLimit as any,
    };
    // The "first" dispatch and the O3 stage-3 re-dispatch both pass through the
    // SAME broker() chokepoint — so a re-dispatch cannot escape to a separate,
    // unaccounted path: identical admission, sizing, and binding cap.
    const first = broker.broker(args);
    const reDispatch = broker.broker(args);
    expect(reDispatch.admission).toBe(first.admission);
    expect(reDispatch.admitted).toBe(first.admitted);
    expect(reDispatch.schedule.max_concurrent).toBe(first.schedule.max_concurrent);
    expect(reDispatch.bindingCap).toBe(first.bindingCap);
    expect(reDispatch.estimatedWaveTokens).toBe(first.estimatedWaveTokens);
  });
});

describe("createBrokeredRepairDispatch — awaitNextCompletion()", () => {
  it("passes the raw worker result straight through (no validation)", () => {
    const broker = createBrokeredRepairDispatch();
    const raw = { id: "n1", arbitrary: { nested: true }, missing_required: undefined };
    const out = broker.awaitNextCompletion({ slotId: "n1", rawResult: raw });
    expect(out.slotId).toBe("n1");
    expect(out.rawResult).toBe(raw); // identity — untouched
  });
});

describe("normalizeSlotTokens", () => {
  it("truncates a too-long array to count", () => {
    expect(normalizeSlotTokens([100, 200, 300], 2)).toEqual([100, 200]);
  });

  it("zero-pads a too-short array to count", () => {
    expect(normalizeSlotTokens([100], 3)).toEqual([100, 0, 0]);
  });

  it("passes through an exactly-matching array unchanged", () => {
    expect(normalizeSlotTokens([100, 200], 2)).toEqual([100, 200]);
  });

  it("returns all-zeros when tokens is undefined", () => {
    expect(normalizeSlotTokens(undefined, 3)).toEqual([0, 0, 0]);
  });

  it("returns all-zeros when tokens is an empty array", () => {
    expect(normalizeSlotTokens([], 3)).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// scheduleWave logs to stderr when readQuotaState throws
// ---------------------------------------------------------------------------

describe("scheduleWave — logs to stderr when readQuotaState throws", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a [waveScheduler] message to stderr and still returns a valid WaveScheduleResult", async () => {
    // Intercept process.stderr.write to capture output
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      (chunk: unknown, ...args: unknown[]): boolean => {
        written.push(String(chunk));
        return original(chunk, ...(args as Parameters<typeof original>));
      },
    );

    // Force readQuotaState to throw by pointing its state directory at a
    // path that cannot be read (a directory used as if it were a file).
    // We use setQuotaStateDir (re-exported from audit-tools/shared) to aim
    // the state reader at a path that will fail with a non-ENOENT error.
    // Simpler: supply an invalid path segment so the JSON.parse will throw
    // inside readQuotaState — but readQuotaState handles that internally.
    //
    // The most reliable approach: mock the shared module's readQuotaState
    // via vi.spyOn on the quota index re-export, which scheduleWave accesses.
    // Because ESM live bindings make vi.spyOn on a re-export work in vitest.
    const quotaModule = await import("../../src/remediate/quota/index.js");
    const readQuotaStateSpy = vi
      .spyOn(quotaModule, "readQuotaState")
      .mockRejectedValue(new Error("simulated quota state read failure"));

    let result: WaveScheduleResult | undefined;
    try {
      result = await scheduleWave({
        sessionConfig: { quota: { enabled: true } },
        itemCount: 3,
        env: {} as any,
      });
    } finally {
      stderrSpy.mockRestore();
      readQuotaStateSpy.mockRestore();
    }

    // scheduleWave must not throw — it falls back gracefully
    expect(result).toBeDefined();
    expect(result!.max_concurrent).toBeGreaterThan(0);

    // stderr must have received the diagnostic message
    const stderrOutput = written.join("");
    expect(stderrOutput).toContain("[waveScheduler] readQuotaState failed");
    expect(stderrOutput).toContain("simulated quota state read failure");
  });
});

// ---------------------------------------------------------------------------
// F4 fail-2 (CP-NODE-50) — no capable/unknown host mis-classification.
//
// The cold-start floor and capability tier are decided SOLELY by F4's own
// classifyProvider + the host-concurrency handshake (classifyCapableHost), never
// by an external/F3 descriptor. Two symmetric mis-classifications must be
// impossible:
//   (a) a CAPABLE host (reports an 8-wide ceiling above the floor) must NOT be
//       collapsed back to the first-contact floor — its real ceiling binds the
//       wave (8) and it classifies as capable; and
//   (b) an UNKNOWN host (first contact, no reported ceiling, no learned
//       evidence) must NOT escape the floor — it stays NOT capable and its wave
//       is held at the conservative first-contact floor.
// Both verdicts come from F4's own classifyProvider/host-concurrency signals.
// ---------------------------------------------------------------------------

describe("F4 fail-2 [CP-NODE-50]: capable host off the floor, unknown host stays at floor", () => {
  const FLOOR = 3; // DEFAULT_FIRST_CONTACT_CONCURRENCY
  const CAPABLE_CEILING = 8;

  it("a capable host is NOT collapsed to the first-contact floor (8-wide ceiling binds, classified capable)", () => {
    const broker = createBrokeredRepairDispatch();
    // classifyProvider is F4's OWN classifier; capability, however, is decided by
    // the injected host ceiling (8 > floor), not the provider type or any
    // external descriptor. antigravity classifies "unknown" yet a reported
    // ceiling above the floor still makes it capable and sizes the wave to 8.
    expect(classifyProvider("antigravity")).toBe("unknown");

    const slots = Array.from({ length: CAPABLE_CEILING }, (_, i) =>
      slot(`n${i}`, 500),
    );
    const decision = broker.broker({
      providerName: "antigravity",
      sessionConfig: {},
      hostModel: null,
      slots,
      hostConcurrencyLimit: {
        active_subagents: CAPABLE_CEILING,
        source: "session_config",
      } as any,
    });

    // The real ceiling binds the wave — it is NOT collapsed down to the floor.
    expect(decision.capableHost).toBe(true);
    expect(decision.schedule.max_concurrent).toBe(CAPABLE_CEILING);
    expect(decision.schedule.max_concurrent).toBeGreaterThan(FLOOR);
    // And F4's own capability classifier agrees, off the SAME floor.
    expect(
      classifyCapableHost({
        sessionConfig: {},
        hostConcurrencyLimit: {
          active_subagents: CAPABLE_CEILING,
          source: "session_config",
        } as any,
        quotaStateEntry: null,
      }),
    ).toBe(true);
  });

  it("an unknown host (first contact, no signal) does NOT escape the capability floor (classified not-capable)", () => {
    const broker = createBrokeredRepairDispatch();
    // An unknown provider with NO reported ceiling and NO learned evidence is a
    // first-contact host: classifyProvider is F4-owned, and with no head-room
    // signal the capability classifier must hold it at the floor (not capable).
    expect(classifyProvider("antigravity")).toBe("unknown");

    const slots = Array.from({ length: CAPABLE_CEILING }, (_, i) =>
      slot(`n${i}`, 500),
    );
    const decision = broker.broker({
      providerName: "antigravity",
      sessionConfig: {},
      hostModel: null,
      slots,
      // No hostConcurrencyLimit, no quotaStateEntry → pure first contact.
    });

    // It is NOT classified capable and its wave never escapes above the floor —
    // an unknown first-contact host stays conservatively sized.
    expect(decision.capableHost).toBe(false);
    expect(decision.schedule.max_concurrent).toBeLessThanOrEqual(FLOOR);
    // F4's own capability classifier agrees: no reported ceiling, no learned
    // evidence → stays at the floor.
    expect(
      classifyCapableHost({
        sessionConfig: {},
        hostConcurrencyLimit: null,
        quotaStateEntry: null,
      }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// waveScheduler.ts shim removed (CP-BLOCK-N-rolling-scheduler atomic-replace).
// The wave-batch re-export shim was deleted together with the wave-batch
// dispatch path; the quota primitives (scheduleWave / buildDispatchQuota /
// normalizeSlotTokens / concurrency helpers) are single-sourced in dispatch.ts
// and the rolling scheduler consumes them directly. The former TST-aebbb698
// shim-identity tests were removed with the shim.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F4 fail-3 (CP-NODE-51) — token estimate is local estimateTokensFromBytes,
// NEVER a provider token-counting API call.
//
// The per-slot/per-wave token estimate must be pure local arithmetic over the
// shared estimateTokensFromBytes primitive (BYTES_PER_TOKEN=4) plus a fixed
// prompt overhead — deterministic, offline, non-billable. It must NEVER drift to
// a provider's network token-counting endpoint. This pins both halves: (a) the
// estimate equals the local primitive exactly, and (b) a global fetch spy is
// never touched while estimating a whole brokered wave.
// ---------------------------------------------------------------------------

describe("F4 fail-3 [CP-NODE-51]: token estimate is local estimateTokensFromBytes, never a provider API call", () => {
  it("estimateSlotTokens equals estimateTokensFromBytes(bytes) + fixed prompt overhead (local arithmetic, no API)", () => {
    for (const bytes of [0, 1, 3, 4, 4000, 8001, 1_000_000]) {
      expect(estimateSlotTokens(slot("s", bytes))).toBe(
        estimateTokensFromBytes(bytes) + ESTIMATED_PROMPT_OVERHEAD_TOKENS,
      );
    }
  });

  it("a full brokered wave estimate performs ZERO network I/O (fetch spy not called)", () => {
    const fetchSpy = vi.fn(() => {
      throw new Error(
        "provider token-counting API attempted — fail-3 violated (must use local estimateTokensFromBytes)",
      );
    });
    const prevFetch = (globalThis as any).fetch;
    (globalThis as any).fetch = fetchSpy;
    try {
      const broker = createBrokeredRepairDispatch();
      const slots = [slot("n1", 4000), slot("n2", 8000), slot("n3", 2000)];
      // Host cap admits the first two slots in input order; the wave estimate is
      // the SUM of the local per-slot estimates — never a remote token count.
      const expectedWave =
        estimateTokensFromBytes(4000) +
        ESTIMATED_PROMPT_OVERHEAD_TOKENS +
        estimateTokensFromBytes(8000) +
        ESTIMATED_PROMPT_OVERHEAD_TOKENS;
      const decision = broker.broker({
        providerName: "claude-code",
        sessionConfig: {},
        hostModel: null,
        slots,
        hostConcurrencyLimit: { active_subagents: 2, source: "session_config" } as any,
      });
      expect(decision.estimatedWaveTokens).toBe(expectedWave);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).fetch = prevFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// F4 inv-9 (CP-NODE-47) — await-completion records the just-finished wave's
// outcome BEFORE the next scheduling decision: each ObservedWaveOutcome is
// persisted to QuotaState via recordWaveOutcome, so the learned concurrency the
// next schedule reads back reflects that finished wave. A `success` outcome
// lifts the learned safe concurrency to the observed wave width; a follow-up
// `rate_limited` outcome bumps consecutive_429_count, stamps last_429_at, sets a
// cooldown_until, and drives the learned safe concurrency back down — all read
// back from the SAME persisted QuotaState. (The inv-5 cooldown_until persists
// earlier and independently of this outcome accounting.)
// ---------------------------------------------------------------------------

describe("F4 inv-9 [CP-NODE-47]: success/rate_limited outcome via recordWaveOutcome updates learned state; next schedule reflects it", () => {
  it("persists each wave outcome to QuotaState so the next decision's learned concurrency reflects the just-finished wave", async () => {
    const {
      setQuotaStateDir,
      recordWaveOutcome,
      readQuotaState,
      computeMaxSafeConcurrency,
    } = await import("../../src/remediate/quota/index.js");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = await mkdtemp(join(tmpdir(), "cp-node-47-quota-"));
    const HALF_LIFE = 24;
    const KEY = "claude-code/*";
    const WAVE = 4;
    try {
      setQuotaStateDir(dir);

      // Cold start: no learned evidence → safe concurrency floors at 1.
      const cold = await readQuotaState();
      expect(computeMaxSafeConcurrency(cold.entries[KEY] ?? { updated_at: "", buckets: {}, cooldown_until: null, last_429_at: null }, HALF_LIFE)).toBe(1);

      // A wave of width 4 finishes successfully. await-completion records the
      // outcome BEFORE the next decision: it is persisted to QuotaState.
      await recordWaveOutcome(
        KEY,
        { concurrency: WAVE, estimated_tokens: 1000, outcome: "success" },
        HALF_LIFE,
      );

      // The NEXT decision reads the persisted state back: every bucket 1..4 now
      // carries success evidence, so learned safe concurrency reflects the
      // just-finished wave width.
      const afterSuccess = await readQuotaState();
      const successEntry = afterSuccess.entries[KEY];
      expect(successEntry).toBeDefined();
      expect(successEntry.consecutive_429_count ?? 0).toBe(0);
      expect(successEntry.cooldown_until).toBeNull();
      expect(successEntry.buckets[String(WAVE)].success_weight).toBeGreaterThanOrEqual(1);
      expect(computeMaxSafeConcurrency(successEntry, HALF_LIFE)).toBe(WAVE);

      // The same wave then hits a 429. Recording the rate_limited outcome bumps
      // consecutive_429_count, stamps last_429_at, sets a cooldown, and spreads
      // failure evidence onto the bucket — all persisted to the SAME state.
      await recordWaveOutcome(
        KEY,
        { concurrency: WAVE, estimated_tokens: 1000, outcome: "rate_limited" },
        HALF_LIFE,
      );

      const afterRateLimit = await readQuotaState();
      const rlEntry = afterRateLimit.entries[KEY];
      expect(rlEntry.consecutive_429_count).toBe(1);
      expect(rlEntry.last_429_at).not.toBeNull();
      expect(rlEntry.cooldown_until).not.toBeNull();
      expect(rlEntry.buckets[String(WAVE)].failure_weight).toBeGreaterThan(0);
      // The next decision now reads a LOWER learned safe concurrency: the bucket
      // at the throttled width is poisoned by failure evidence, so the scan
      // stops below it — the just-finished rate-limited wave shaped the decision.
      expect(computeMaxSafeConcurrency(rlEntry, HALF_LIFE)).toBeLessThan(WAVE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F4 inv-6 (CP-NODE-44) — an active cooldown forces a single-slot wave.
//
// A quotaStateEntry.cooldown_until in the FUTURE is an active cooldown: the
// shared scheduler throttles to max_concurrent=1, stamps binding_cap="cooldown",
// and SKIPS all cap computation (RPM/TPM/learned/fallback). This is the path the
// persisted critical-snapshot cooldown (inv-5) feeds into — many cheap slots that
// would otherwise size a wide wave are collapsed to one solely by the cooldown.
// ---------------------------------------------------------------------------

describe("F4 inv-6 [CP-NODE-44]: future cooldown_until => max_concurrent=1, binding_cap=cooldown", () => {
  it("an active (future) cooldown collapses an otherwise-wide wave to a single slot and skips cap computation", () => {
    const broker = createBrokeredRepairDispatch();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    // Enough cheap slots that, absent the cooldown, the wave would size well
    // above 1 — proving the single-slot result comes from the cooldown branch,
    // not from a slot/budget cap.
    const decision = broker.broker({
      providerName: "openai-compatible",
      sessionConfig: { quota: { enabled: true } } as any,
      hostModel: null,
      slots: Array.from({ length: 8 }, (_, i) => slot(`n${i}`, 500)),
      quotaStateEntry: makeQuotaStateEntry({ cooldown_until: future }),
    });

    // The schedule itself — not just the rolled-up decision — is the cooldown
    // branch: a single-slot wave bound by cooldown, carrying the cooldown_until.
    expect(decision.schedule.max_concurrent).toBe(1);
    expect(decision.schedule.binding_cap).toBe("cooldown");
    expect(decision.schedule.cooldown_until).toBe(future);
    // And the admission honors it: exactly one slot is admitted under cooldown.
    expect(decision.admitted).toBe(1);
    expect(decision.bindingCap).toBe("cooldown");
    expect(decision.cooldownUntil).toBe(future);
  });

  it("an EXPIRED cooldown_until is NOT active — the wave is sized normally (cap computation runs)", () => {
    const broker = createBrokeredRepairDispatch();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const decision = broker.broker({
      providerName: "openai-compatible",
      sessionConfig: { quota: { enabled: true } } as any,
      hostModel: null,
      slots: Array.from({ length: 8 }, (_, i) => slot(`n${i}`, 500)),
      quotaStateEntry: makeQuotaStateEntry({ cooldown_until: past }),
    });

    // A past cooldown is inactive: the cooldown branch is skipped, cap
    // computation runs, and nothing is bound by cooldown.
    expect(decision.schedule.binding_cap).not.toBe("cooldown");
    expect(decision.schedule.cooldown_until).toBeNull();
    expect(decision.bindingCap).not.toBe("cooldown");
  });
});
