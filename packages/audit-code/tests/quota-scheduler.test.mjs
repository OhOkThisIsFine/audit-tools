import test from "node:test";
import assert from "node:assert/strict";

const { scheduleWave, buildProviderModelKey } = await import(
  "../dist/quota/scheduler.js"
);
const { detectHostActiveSubagentLimit, resolveHostActiveSubagentLimit } = await import(
  "../dist/quota/hostLimits.js"
);
const {
  decayWeight,
  computeMaxSafeConcurrency,
  computeRampUpConcurrency,
  computeBackoffCooldownMs,
  computeBackoffFailureWeight,
} = await import("@audit-tools/shared/quota/state");

// Helper to build a quota state entry with preset bucket weights
function makeEntry(buckets, overrides = {}) {
  return {
    updated_at: new Date().toISOString(),
    buckets,
    cooldown_until: null,
    last_429_at: null,
    ...overrides,
  };
}

// ── buildProviderModelKey ────────────────────────────────────────────────────

test("buildProviderModelKey uses provider/* when no model given", () => {
  assert.equal(buildProviderModelKey("claude-code", null), "claude-code/*");
  assert.equal(buildProviderModelKey("claude-code", undefined), "claude-code/*");
});

test("buildProviderModelKey includes model when provided", () => {
  assert.equal(
    buildProviderModelKey("anthropic", "claude-sonnet-4-6"),
    "anthropic/claude-sonnet-4-6",
  );
});

// ── decayWeight ──────────────────────────────────────────────────────────────

test("decayWeight returns original value with zero elapsed time", () => {
  assert.equal(decayWeight(10, 0, 24), 10);
});

test("decayWeight halves weight after one half-life", () => {
  const result = decayWeight(10, 24, 24);
  assert.ok(Math.abs(result - 5) < 0.001, `expected ~5, got ${result}`);
});

test("decayWeight returns 0 for non-positive halfLifeHours", () => {
  assert.equal(decayWeight(10, 1, 0), 0);
});

// ── computeMaxSafeConcurrency ────────────────────────────────────────────────

test("computeMaxSafeConcurrency returns 1 when no buckets", () => {
  const entry = makeEntry({});
  assert.equal(computeMaxSafeConcurrency(entry, 24), 1);
});

test("computeMaxSafeConcurrency returns highest safe bucket", () => {
  const entry = makeEntry({
    "1": { success_weight: 5, failure_weight: 0.1 },
    "2": { success_weight: 4, failure_weight: 0.1 },
    "3": { success_weight: 3, failure_weight: 0.1 },
    "4": { success_weight: 0.1, failure_weight: 5 }, // unsafe
  });
  assert.equal(computeMaxSafeConcurrency(entry, 24), 3);
});

test("computeMaxSafeConcurrency stops at first unsafe bucket", () => {
  const entry = makeEntry({
    "1": { success_weight: 5, failure_weight: 0 },
    "2": { success_weight: 0.1, failure_weight: 5 }, // unsafe — should stop here
    "3": { success_weight: 5, failure_weight: 0 },   // won't reach this
  });
  assert.equal(computeMaxSafeConcurrency(entry, 24), 1);
});

test("computeMaxSafeConcurrency requires minimum evidence weight", () => {
  const entry = makeEntry({
    "1": { success_weight: 0.1, failure_weight: 0 }, // below MIN_EVIDENCE_WEIGHT of 0.5
  });
  // Even though success > failure, there's not enough evidence
  assert.equal(computeMaxSafeConcurrency(entry, 24), 1);
});

// ── scheduleWave ─────────────────────────────────────────────────────────────

test("scheduleWave returns requestedConcurrency when quota is disabled", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { enabled: false } },
    hostModel: null,
    requestedConcurrency: 22,
  });
  assert.equal(schedule.wave_size, 22);
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
        unknown_hosted_concurrency: 100,
      },
    },
    hostModel: "anthropic/claude-sonnet-4-6",
    requestedConcurrency: 22,
  });
  // floor(10 * 0.8) = 8
  assert.equal(schedule.wave_size, 8);
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
        unknown_hosted_concurrency: 100,
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 5,
    // Slot estimates: [8000, 6000, 4000, 2000, 1000]. Top-3 = 18000 > 10000, top-2 = 14000 > 10000, top-1 = 8000 < 10000
    estimatedSlotTokens: [8000, 6000, 4000, 2000, 1000],
  });
  assert.equal(schedule.wave_size, 1);
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
        unknown_hosted_concurrency: 100,
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 5,
    // Slot estimates: [3000, 3000, 3000, 3000, 3000]. Top-5 = 15000 < 20000
    estimatedSlotTokens: [3000, 3000, 3000, 3000, 3000],
  });
  assert.equal(schedule.wave_size, 5);
});

test("scheduleWave estimated_wave_tokens uses actual slot sums", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { enabled: false } },
    hostModel: null,
    requestedConcurrency: 3,
    estimatedSlotTokens: [5000, 3000, 1000],
  });
  assert.equal(schedule.wave_size, 3);
  assert.equal(schedule.estimated_wave_tokens, 9000);
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
        unknown_hosted_concurrency: 100,
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 10,
    estimatedPacketTokens: 3_000,
  });
  // floor(10_000 / 3_000) = 3
  assert.equal(schedule.wave_size, 3);
});

test("scheduleWave caps wave size by host active subagent limit", () => {
  const hostConcurrencyLimit = {
    active_subagents: 6,
    source: "environment",
    description: "Codex Desktop active subagent limit.",
  };
  // Provide quota state so first-contact cap doesn't interfere
  const quotaStateEntry = makeEntry({
    "1": { success_weight: 5, failure_weight: 0 },
    "2": { success_weight: 5, failure_weight: 0 },
    "3": { success_weight: 5, failure_weight: 0 },
    "4": { success_weight: 5, failure_weight: 0 },
    "5": { success_weight: 5, failure_weight: 0 },
    "6": { success_weight: 5, failure_weight: 0 },
    "7": { success_weight: 5, failure_weight: 0 },
    "8": { success_weight: 5, failure_weight: 0 },
  });
  const schedule = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 36,
    hostConcurrencyLimit,
    quotaStateEntry,
  });
  assert.equal(schedule.wave_size, 6);
  assert.deepEqual(schedule.host_concurrency_limit, hostConcurrencyLimit);
});

test("scheduleWave applies host active subagent limit even when quota is disabled", () => {
  const schedule = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: { quota: { enabled: false } },
    hostModel: null,
    requestedConcurrency: 36,
    hostConcurrencyLimit: {
      active_subagents: 6,
      source: "cli_flags",
      description: "Host active subagent limit reported by the conversation host.",
    },
  });
  assert.equal(schedule.wave_size, 6);
});

test("scheduleWave clamps unknown hosted providers to configured fallback concurrency", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { unknown_hosted_concurrency: 3 } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
  });
  assert.equal(schedule.wave_size, 3);

  const belowCap = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { unknown_hosted_concurrency: 10 } },
    hostModel: null,
    requestedConcurrency: 4,
    quotaStateEntry: null,
  });
  assert.equal(belowCap.wave_size, 4);
});

test("scheduleWave clamps unknown local providers to configured fallback concurrency", () => {
  const schedule = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: { quota: { unknown_local_concurrency: 5 } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
  });
  assert.equal(schedule.wave_size, 5);

  const belowCap = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: { quota: { unknown_local_concurrency: 10 } },
    hostModel: null,
    requestedConcurrency: 4,
    quotaStateEntry: null,
  });
  assert.equal(belowCap.wave_size, 4);
});

test("scheduleWave respects unlimited local concurrency without clamping", () => {
  const schedule = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: { quota: { unknown_local_concurrency: "unlimited" } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
  });
  assert.equal(schedule.wave_size, 22);
});

test("scheduleWave still applies host limit when local concurrency is unlimited", () => {
  const schedule = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: { quota: { unknown_local_concurrency: "unlimited" } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
    hostConcurrencyLimit: {
      active_subagents: 8,
      source: "cli_flags",
      description: "Host active subagent limit.",
    },
  });
  assert.equal(schedule.wave_size, 8);
});

test("scheduleWave applies first-contact cap for unconfigured local providers", () => {
  for (const providerName of ["opencode", "local-subprocess"]) {
    const schedule = scheduleWave({
      providerName,
      sessionConfig: {},
      hostModel: null,
      requestedConcurrency: 22,
      quotaStateEntry: null,
    });
    assert.equal(schedule.wave_size, 3, `expected first-contact cap for ${providerName}`);
  }
});

test("scheduleWave bypasses first-contact cap when discovered limits exist", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
    discoveredLimits: { requests_per_minute: 20, source: "header_extraction" },
  });
  assert.equal(schedule.wave_size, 16); // 20 * 0.8 safety margin = 16
});

test("scheduleWave bypasses first-contact cap when quota state exists", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: makeEntry({
      "1": { success_weight: 5, failure_weight: 0 },
      "2": { success_weight: 5, failure_weight: 0 },
      "3": { success_weight: 5, failure_weight: 0 },
      "4": { success_weight: 5, failure_weight: 0 },
      "5": { success_weight: 5, failure_weight: 0 },
    }),
  });
  assert.equal(schedule.wave_size, 6); // ramp-up: 5 succeeded + 1
});

test("scheduleWave uses full local concurrency when unknown_local_concurrency is unlimited", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: { quota: { unknown_local_concurrency: "unlimited" } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
  });
  assert.equal(schedule.wave_size, 22);
});

test("scheduleWave respects learned concurrency cap (ramp-up disabled)", () => {
  const entry = makeEntry({
    "1": { success_weight: 5, failure_weight: 0 },
    "2": { success_weight: 5, failure_weight: 0 },
    "3": { success_weight: 5, failure_weight: 0 },
    "4": { success_weight: 5, failure_weight: 0 },
    "5": { success_weight: 0, failure_weight: 5 },
  });
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { ramp_up_enabled: false } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: entry,
  });
  assert.equal(schedule.wave_size, 4);
});

test("scheduleWave reduces to 1 during active cooldown", () => {
  const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
  const entry = makeEntry({}, { cooldown_until: cooldownUntil });
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: entry,
  });
  assert.equal(schedule.wave_size, 1);
  assert.equal(schedule.cooldown_until, cooldownUntil);
});

test("scheduleWave ignores expired cooldown", () => {
  const expiredCooldown = new Date(Date.now() - 1000).toISOString();
  const entry = makeEntry(
    {
      "1": { success_weight: 5, failure_weight: 0 },
      "2": { success_weight: 5, failure_weight: 0 },
    },
    { cooldown_until: expiredCooldown },
  );
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: entry,
  });
  assert.ok(schedule.wave_size > 1, "expired cooldown should not reduce wave size to 1");
  assert.equal(schedule.cooldown_until, null);
});

test("scheduleWave wave_size is always at least 1", () => {
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
  assert.equal(schedule.wave_size, 1);
});

test("scheduleWave source and confidence reflect the limit origin", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: "anthropic/claude-sonnet-4-6",
    requestedConcurrency: 1,
  });
  assert.equal(schedule.source, "known_metadata");
  assert.equal(schedule.confidence, "medium");
  assert.equal(schedule.model, "anthropic/claude-sonnet-4-6");
});

test("detectHostActiveSubagentLimit detects Codex Desktop limit", () => {
  const limit = detectHostActiveSubagentLimit({
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
  });
  assert.equal(limit?.active_subagents, 6);
  assert.equal(limit?.source, "environment");
});

test("resolveHostActiveSubagentLimit prefers explicit host report over environment", () => {
  const limit = resolveHostActiveSubagentLimit({
    explicitLimit: 4,
    sessionConfig: {},
    env: {
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
    },
  });
  assert.equal(limit?.active_subagents, 4);
  assert.equal(limit?.source, "cli_flags");
});

// ── Exponential backoff ─────────────────────────────────────────────────────

test("computeBackoffCooldownMs escalates exponentially", () => {
  assert.equal(computeBackoffCooldownMs(1), 60_000);
  assert.equal(computeBackoffCooldownMs(2), 120_000);
  assert.equal(computeBackoffCooldownMs(3), 240_000);
  assert.equal(computeBackoffCooldownMs(4), 480_000);
});

test("computeBackoffCooldownMs caps at 15 minutes", () => {
  assert.equal(computeBackoffCooldownMs(10), 15 * 60_000);
  assert.equal(computeBackoffCooldownMs(100), 15 * 60_000);
});

test("computeBackoffCooldownMs handles count 0 gracefully", () => {
  assert.equal(computeBackoffCooldownMs(0), 60_000);
});

test("computeBackoffFailureWeight escalates with consecutive failures", () => {
  assert.equal(computeBackoffFailureWeight(1), 1.0);
  assert.equal(computeBackoffFailureWeight(2), 1.5);
  assert.equal(computeBackoffFailureWeight(3), 2.0);
  assert.equal(computeBackoffFailureWeight(5), 3.0);
});

test("computeBackoffFailureWeight handles count 0 gracefully", () => {
  assert.equal(computeBackoffFailureWeight(0), 1.0);
});

// ── Cold-start ramp-up ──────────────────────────────────────────────────────

test("computeRampUpConcurrency returns maxSafe+1 with sufficient consecutive successes", () => {
  const entry = makeEntry({
    "1": { success_weight: 5, failure_weight: 0 },
    "2": { success_weight: 3, failure_weight: 0 },
  });
  assert.equal(computeRampUpConcurrency(entry, 24), 3);
});

test("computeRampUpConcurrency stays at maxSafe with insufficient evidence", () => {
  const entry = makeEntry({
    "1": { success_weight: 1, failure_weight: 0 },
  });
  assert.equal(computeRampUpConcurrency(entry, 24), 1);
});

test("computeRampUpConcurrency stays at maxSafe when top bucket has failures", () => {
  const entry = makeEntry({
    "1": { success_weight: 5, failure_weight: 0 },
    "2": { success_weight: 5, failure_weight: 0.1 },
  });
  // maxSafe=2 (bucket 2: success 5 > failure 0.1), but bucket 2 has non-zero failure so no ramp-up
  assert.equal(computeMaxSafeConcurrency(entry, 24), 2);
  assert.equal(computeRampUpConcurrency(entry, 24), 2);
});

test("scheduleWave uses ramp-up by default with quota state", () => {
  const entry = makeEntry({
    "1": { success_weight: 5, failure_weight: 0 },
    "2": { success_weight: 5, failure_weight: 0 },
  });
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: entry,
  });
  // maxSafe=2, ramp-up gives 3
  assert.equal(schedule.wave_size, 3);
});

test("scheduleWave disables ramp-up when ramp_up_enabled is false", () => {
  const entry = makeEntry({
    "1": { success_weight: 5, failure_weight: 0 },
    "2": { success_weight: 5, failure_weight: 0 },
  });
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { ramp_up_enabled: false } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: entry,
  });
  assert.equal(schedule.wave_size, 2);
});
