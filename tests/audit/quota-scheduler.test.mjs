import { test, expect } from "vitest";

const {
  scheduleWave,
  buildProviderModelKey,
  computeBackoffCooldownMs,
} = await import("audit-tools/shared");
const { detectHostActiveSubagentLimit, resolveHostActiveSubagentLimit } = await import("../../src/audit/quota/hostLimits.ts");
const { resolveHostModel } = await import("../../src/audit/quota/index.ts");

/** A quota-state entry: reactive backoff state only — no concurrency evidence. */
function makeEntry(overrides = {}) {
  return {
    updated_at: new Date().toISOString(),
    cooldown_until: null,
    last_429_at: null,
    consecutive_429_count: 0,
    ...overrides,
  };
}

// ── buildProviderModelKey ────────────────────────────────────────────────────

test("buildProviderModelKey uses provider/* when no model given", () => {
  expect(buildProviderModelKey("claude-code", null)).toBe("claude-code/*");
  expect(buildProviderModelKey("claude-code", undefined)).toBe("claude-code/*");
});

test("buildProviderModelKey includes model when provided", () => {
  expect(buildProviderModelKey("anthropic", "claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4-6");
});

test("scheduleWave returns requestedConcurrency when quota is disabled", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 22,
  });
  expect(schedule.max_concurrent).toBe(22);
});

test("scheduleWave caps wave size by RPM limit", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: {
          "anthropic/claude-sonnet-4-6": { requests_per_minute: 10 },
        },
        safety_margin: 0.8,
      },
    },
    hostModel: "anthropic/claude-sonnet-4-6",
    requestedConcurrency: 22,
  });
  // floor(10 * 0.8) = 8
  expect(schedule.max_concurrent).toBe(8);
});

test("scheduleWave caps wave size by TPM limit using per-slot estimates", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: {
          "test/model": { input_tokens_per_minute: 10_000 },
        },
        safety_margin: 1.0,
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 5,
    // Slot estimates: [8000, 6000, 4000, 2000, 1000]. Top-3 = 18000 > 10000, top-2 = 14000 > 10000, top-1 = 8000 < 10000
    estimatedSlotTokens: [8000, 6000, 4000, 2000, 1000],
  });
  expect(schedule.max_concurrent).toBe(1);
});

test("scheduleWave per-slot TPM allows more slots when they fit budget", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: {
          "test/model": { input_tokens_per_minute: 20_000 },
        },
        safety_margin: 1.0,
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 5,
    // Slot estimates: [3000, 3000, 3000, 3000, 3000]. Top-5 = 15000 < 20000
    estimatedSlotTokens: [3000, 3000, 3000, 3000, 3000],
  });
  expect(schedule.max_concurrent).toBe(5);
});

test("scheduleWave estimated_wave_tokens uses actual slot sums", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 3,
    estimatedSlotTokens: [5000, 3000, 1000],
  });
  expect(schedule.max_concurrent).toBe(3);
  expect(schedule.estimated_wave_tokens).toBe(9000);
});

test("scheduleWave caps wave size by TPM limit", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: {
          "test/model": { input_tokens_per_minute: 10_000 },
        },
        safety_margin: 1.0,
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 10,
    estimatedSlotTokens: [3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000, 3_000],
  });
  // sumTopN of 4 slots (4*3000=12000) > 10000, sumTopN of 3 slots (3*3000=9000) <= 10000 → wave = 3
  expect(schedule.max_concurrent).toBe(3);
});

test("scheduleWave caps wave size by host active subagent limit", () => {
  const hostConcurrencyLimit = {
    active_subagents: 6,
    source: "environment",
    description: "Codex Desktop active subagent limit.",
  };
  // Provide quota state so first-contact cap doesn't interfere
  const quotaStateEntry = makeEntry();
  const schedule = scheduleWave({
    providerName: "worker-command",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 36,
    hostConcurrencyLimit,
    quotaStateEntry,
  });
  expect(schedule.max_concurrent).toBe(6);
  expect(schedule.host_concurrency_limit).toEqual(hostConcurrencyLimit);
});

test("scheduleWave applies host active subagent limit even when quota is disabled", () => {
  const schedule = scheduleWave({
    providerName: "worker-command",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 36,
    hostConcurrencyLimit: {
      active_subagents: 6,
      source: "cli_flags",
      description: "Host active subagent limit reported by the conversation host.",
    },
  });
  expect(schedule.max_concurrent).toBe(6);
});

test("scheduleWave: a reported host limit supersedes the conservative unknown-hosted fallback", () => {
  // Hosted provider, no learned quota state, and no explicit
  // unknown_hosted_concurrency (so it would otherwise use the agent-host
  // fallback default). A host that reports its active-subagent capacity should
  // get waves up to that capacity instead, even when that is lower.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 96,
    quotaStateEntry: null,
    hostConcurrencyLimit: {
      active_subagents: 4,
      source: "cli_flags",
      description: "Host active subagent limit reported by the conversation host.",
    },
  });
  expect(schedule.max_concurrent).toBe(4);
});

test("scheduleWave: a reported host limit never raises waves above a known RPM cap", () => {
  // Even with a generous reported host limit and no learned state, a discovered
  // RPM ceiling still binds — the host limit supersedes only the *fallback*, not
  // real rate limits.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { safety_margin: 1 } },
    hostModel: null,
    requestedConcurrency: 96,
    quotaStateEntry: null,
    hostConcurrencyLimit: {
      active_subagents: 8,
      source: "cli_flags",
      description: "Host active subagent limit reported by the conversation host.",
    },
    discoveredLimits: { requests_per_minute: 3, source: "provider_query" },
  });
  expect(schedule.max_concurrent).toBe(3);
});

test("scheduleWave invents NO ceiling for an unconfigured provider (no host limit, no rpm/tpm, no budget)", () => {
  // New model (token-budget gate): the former invented unknown-hosted / cold-start
  // fallback caps are gone. With no learned state, no host-reported cap, no RPM/TPM,
  // and no live quota snapshot, concurrency is governed ONLY by the requested wave.
  const wide = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 96,
    quotaStateEntry: null,
  });
  expect(wide.max_concurrent).toBe(96);
  expect(wide.binding_cap).toBe("none");

  // A genuinely unknown (non-agent-host) provider is ALSO uncapped now — no floor.
  const unknown = scheduleWave({
    providerName: "subprocess-template",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 96,
    quotaStateEntry: null,
  });
  expect(unknown.max_concurrent).toBe(96);
  expect(unknown.binding_cap).toBe("none");
});

test("resolveHostModel: explicit -> config -> env -> null", () => {
  // Explicit override wins over everything.
  expect(resolveHostModel({
      providerName: "claude-code",
      sessionConfig: { block_quota: { host_model: "x/cfg" } },
      explicitModel: "x/explicit",
      env: { AUDIT_CODE_HOST_MODEL: "x/env" },
      envVar: "AUDIT_CODE_HOST_MODEL",
    })).toBe("x/explicit");
  // Then session-config block_quota.host_model.
  expect(resolveHostModel({
      providerName: "claude-code",
      sessionConfig: { block_quota: { host_model: "x/cfg" } },
      env: {},
    })).toBe("x/cfg");
  // Then the env hint.
  expect(resolveHostModel({
      providerName: "claude-code",
      sessionConfig: {},
      env: { AUDIT_CODE_HOST_MODEL: "x/env" },
      envVar: "AUDIT_CODE_HOST_MODEL",
    })).toBe("x/env");
  // No signal → null (genuinely unknown model — no hardcoded per-provider
  // default; the real window comes from the dispatch-time handshake).
  expect(resolveHostModel({ providerName: "claude-code", sessionConfig: {}, env: {} })).toBe(null);
  expect(resolveHostModel({ providerName: "subprocess-template", sessionConfig: {}, env: {} })).toBe(null);
});

test("scheduleWave invents NO ceiling for an unconfigured local provider", () => {
  // No fallback / cold-start cap anymore: an unconfigured local provider with no
  // learned state and no rate limits dispatches the full requested wave.
  for (const providerName of ["opencode", "worker-command"]) {
    const schedule = scheduleWave({
      providerName,
      sessionConfig: {},
      hostModel: null,
      requestedConcurrency: 22,
      quotaStateEntry: null,
    });
    expect(schedule.max_concurrent, `expected uncapped wave for ${providerName}`).toBe(22);
    expect(schedule.binding_cap).toBe("none");
  }
});

test("scheduleWave still applies host limit for an unconfigured local provider", () => {
  const schedule = scheduleWave({
    providerName: "worker-command",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
    hostConcurrencyLimit: {
      active_subagents: 8,
      source: "cli_flags",
      description: "Host active subagent limit.",
    },
  });
  expect(schedule.max_concurrent).toBe(8);
});

test("scheduleWave dispatches the full wave when discovered limits are generous", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
    discoveredLimits: { requests_per_minute: 20, source: "header_extraction" },
  });
  expect(schedule.max_concurrent).toBe(16); // 20 * 0.8 safety margin = 16
});

test("scheduleWave reduces to 1 during active cooldown", () => {
  const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
  const entry = makeEntry({ cooldown_until: cooldownUntil });
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: entry,
  });
  expect(schedule.max_concurrent).toBe(1);
  expect(schedule.cooldown_until).toBe(cooldownUntil);
});

test("scheduleWave ignores expired cooldown", () => {
  const expiredCooldown = new Date(Date.now() - 1000).toISOString();
  const entry = makeEntry({ cooldown_until: expiredCooldown });
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: entry,
  });
  expect(schedule.max_concurrent > 1, "expired cooldown should not reduce max_concurrent to 1").toBeTruthy();
  expect(schedule.cooldown_until).toBe(null);
});

test("scheduleWave max_concurrent is always at least 1", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: { "test/model": { requests_per_minute: 0 } },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 0,
  });
  expect(schedule.max_concurrent).toBe(1);
});

test("scheduleWave source and confidence reflect the limit origin", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "anthropic/claude-sonnet-4-6",
    discoveredLimits: { context_tokens: 200_000, output_tokens: 8_192 },
    requestedConcurrency: 1,
  });
  expect(schedule.source).toBe("discovered_capability");
  expect(schedule.confidence).toBe("high");
  expect(schedule.model).toBe("anthropic/claude-sonnet-4-6");
});

test("detectHostActiveSubagentLimit falls back to Codex documented default when config silent", () => {
  const limit = detectHostActiveSubagentLimit(
    { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
    () => null,
  );
  expect(limit !== null, "expected a non-null limit for Codex Desktop").toBeTruthy();
  expect(limit.active_subagents).toBe(6);
  expect(limit.source).toBe("known_default");
});

test("detectHostActiveSubagentLimit discovers Codex agents.max_threads from config", () => {
  const limit = detectHostActiveSubagentLimit(
    { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop" },
    () => 12,
  );
  expect(limit !== null, "expected a non-null discovered limit").toBeTruthy();
  expect(limit.active_subagents).toBe(12);
  expect(limit.source).toBe("discovered_config");
});

test("detectHostActiveSubagentLimit respects AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS env var", () => {
  const limit = detectHostActiveSubagentLimit({
    AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "3",
  });
  expect(limit !== null, "expected a non-null limit from env var").toBeTruthy();
  expect(limit.active_subagents).toBe(3);
  expect(limit.source).toBe("environment");
});

test("detectHostActiveSubagentLimit returns null for non-numeric AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
  const limit = detectHostActiveSubagentLimit({
    AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "abc",
  });
  expect(limit).toBe(null);
});

test("detectHostActiveSubagentLimit returns null for zero AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
  const limit = detectHostActiveSubagentLimit({
    AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "0",
  });
  expect(limit).toBe(null);
});

test("detectHostActiveSubagentLimit returns null for negative AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS", () => {
  const limit = detectHostActiveSubagentLimit({
    AUDIT_CODE_HOST_MAX_ACTIVE_SUBAGENTS: "-1",
  });
  expect(limit).toBe(null);
});

test("resolveHostActiveSubagentLimit prefers explicit host report over environment", () => {
  const limit = resolveHostActiveSubagentLimit({
    explicitLimit: 4,
    sessionConfig: {},
    env: {
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    },
  });
  expect(limit?.active_subagents).toBe(4);
  expect(limit?.source).toBe("cli_flags");
});

// ── Exponential backoff ─────────────────────────────────────────────────────

test("computeBackoffCooldownMs escalates exponentially", () => {
  expect(computeBackoffCooldownMs(1)).toBe(60_000);
  expect(computeBackoffCooldownMs(2)).toBe(120_000);
  expect(computeBackoffCooldownMs(3)).toBe(240_000);
  expect(computeBackoffCooldownMs(4)).toBe(480_000);
});

test("computeBackoffCooldownMs caps at 15 minutes", () => {
  expect(computeBackoffCooldownMs(10)).toBe(15 * 60_000);
  expect(computeBackoffCooldownMs(100)).toBe(15 * 60_000);
});

test("computeBackoffCooldownMs handles count 0 gracefully", () => {
  expect(computeBackoffCooldownMs(0)).toBe(60_000);
});

test("scheduleWave reports binding_cap='rpm' when the RPM limit binds", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: { "anthropic/claude-sonnet-4-6": { requests_per_minute: 10 } },
        safety_margin: 0.8,
      },
    },
    hostModel: "anthropic/claude-sonnet-4-6",
    requestedConcurrency: 22,
  });
  expect(schedule.max_concurrent).toBe(8);
  expect(schedule.binding_cap).toBe("rpm");
});

test("scheduleWave reports binding_cap='tpm' when the TPM limit binds", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        models: { "test/model": { input_tokens_per_minute: 10_000 } },
        safety_margin: 1.0,
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 5,
    estimatedSlotTokens: [8000, 6000, 4000, 2000, 1000],
  });
  expect(schedule.max_concurrent).toBe(1);
  expect(schedule.binding_cap).toBe("tpm");
});

test("scheduleWave reports binding_cap='token_budget' when a small learned budget binds", () => {
  // A pool near a window wall with a learned slope: the token budget caps the wave
  // below the requested size and attributes token_budget.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { safety_margin: 1 } },
    hostModel: null,
    requestedConcurrency: 10,
    // 100 tokens per percent; window at 40% remaining (well above the near-wall
    // floor) → budget = 40*100 = 4000.
    quotaStateEntry: makeEntry({ tokens_per_pct: { session: 100 } }),
    // Each slot ~2000 tokens → only 2 fit in 4000.
    estimatedSlotTokens: [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000],
    quotaSourceSnapshot: {
      remaining_pct: 0.4,
      reset_at: null,
      requests_remaining: null,
      tokens_remaining: null,
      captured_at: new Date().toISOString(),
      source: "test",
      windows: [{ label: "session", scope: "account", remaining_pct: 0.4, reset_at: null }],
    },
  });
  expect(schedule.binding_cap).toBe("token_budget");
  expect(schedule.max_concurrent < 10, `expected budget to cap below 10, got ${schedule.max_concurrent}`).toBeTruthy();
});

test("scheduleWave reports binding_cap='cooldown' during an active cooldown", () => {
  const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
  const entry = makeEntry({ cooldown_until: cooldownUntil });
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: entry,
  });
  expect(schedule.binding_cap).toBe("cooldown");
});

test("scheduleWave reports binding_cap='host_concurrency' when the host limit binds", () => {
  const schedule = scheduleWave({
    providerName: "worker-command",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 36,
    hostConcurrencyLimit: {
      active_subagents: 6,
      source: "cli_flags",
      description: "Host active subagent limit.",
    },
  });
  expect(schedule.max_concurrent).toBe(6);
  expect(schedule.binding_cap).toBe("host_concurrency");
});

test("F4 inv-3: a reported host limit binds; with no handshake signal nothing invents a floor", () => {
  // Capable host: F4's own handshake (resolveHostActiveSubagentLimit) yields a
  // reported active-subagent ceiling — that host limit binds.
  const capableLimit = resolveHostActiveSubagentLimit({
    sessionConfig: { quota: { host_active_subagent_limit: 8 } },
    env: {},
  });
  expect(capableLimit).not.toBe(null);
  const capable = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 96,
    quotaStateEntry: null,
    hostConcurrencyLimit: capableLimit,
  });
  expect(capable.max_concurrent).toBe(8);
  expect(capable.binding_cap).toBe("host_concurrency");

  // No handshake signal → resolveHostActiveSubagentLimit returns null and, with
  // no learned/rpm/tpm/budget signal, the wave is uncapped (no invented floor).
  const unknownLimit = resolveHostActiveSubagentLimit({
    sessionConfig: { quota: {} },
    env: {},
  });
  expect(unknownLimit).toBe(null);
  const unknown = scheduleWave({
    providerName: "worker-command",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 96,
    quotaStateEntry: null,
    hostConcurrencyLimit: unknownLimit,
  });
  expect(unknown.binding_cap).toBe("none");
  expect(unknown.max_concurrent).toBe(96);
});

test("scheduleWave reports binding_cap='none' when nothing reduces the requested wave", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 4,
  });
  expect(schedule.max_concurrent).toBe(4);
  expect(schedule.binding_cap).toBe("none");
});

test("a quotaStateEntry NEVER caps the wave — concurrency is declared or absent", () => {
  // The learned-concurrency inference (safe/failure buckets → maxSafe/ramp-up cap)
  // was deleted: a rate-limit signal cannot teach a concurrency number. What
  // survives on the entry is reactive backoff (cooldown_until / 429 streak), and
  // an entry with no ACTIVE cooldown narrows nothing.
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: {
      updated_at: new Date().toISOString(),
      cooldown_until: null,
      last_429_at: null,
      consecutive_429_count: 0,
    },
  });
  expect(schedule.max_concurrent).toBe(22);
  expect(schedule.binding_cap).toBe("none");
});


// ── D1: binding window surfaced on the schedule ──────────────────────────────

test("scheduleWave surfaces the binding window (the MIN-budget window) with its reset", () => {
  const weeklyReset = "2026-07-18T00:00:00.000Z";
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 8,
    quotaSourceSnapshot: {
      remaining_pct: 0.02,
      reset_at: weeklyReset,
      requests_remaining: null,
      tokens_remaining: 1200,
      captured_at: "2026-07-15T00:00:00.000Z",
      source: "test",
      windows: [
        // Session window is fresh (huge budget) but the weekly window is nearly
        // empty — the weekly window binds, and days out.
        { label: "session", scope: "account", remaining_pct: 0.96, reset_at: "2026-07-15T05:00:00.000Z", tokens_remaining: 500000 },
        { label: "weekly", scope: "account", remaining_pct: 0.02, reset_at: weeklyReset, tokens_remaining: 1200 },
      ],
    },
  });
  expect(schedule.binding_window).toEqual({ label: "weekly", reset_at: weeklyReset, budget: 1200 });
});

test("scheduleWave binding_window is null with no live snapshot", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 8,
  });
  expect(schedule.binding_window ?? null).toBeNull();
});
