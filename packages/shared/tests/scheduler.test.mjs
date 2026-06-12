import test from "node:test";
import assert from "node:assert/strict";

const { scheduleWave } = await import("../src/quota/scheduler.ts");

// A minimal session-config that keeps quota enabled.
function baseSessionConfig(overrides = {}) {
  return {
    quota: {
      enabled: true,
      safety_margin: 0.8,
      empirical_half_life_hours: 24,
      ...overrides,
    },
  };
}

// computeUncappedWaveSize input object — transposition safety
// Each sub-test exercises a distinct cap branch and confirms that the named-input
// refactor did not silently swap any of the 10 arguments.

test("rpm cap: scheduleWave respects requests_per_minute limit", () => {
  // Provide an RPM limit that is tighter than the requested concurrency.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 1.0, // no safety shrinkage so cap is exact
        empirical_half_life_hours: 24,
        models: {
          "test/model": { requests_per_minute: 4 },
        },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 20,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  assert.equal(schedule.max_concurrent, 4, "max_concurrent should be capped by rpm");
  assert.equal(schedule.binding_cap, "rpm");
});

test("tpm cap: scheduleWave respects input_tokens_per_minute limit", () => {
  // 10 slots each costing 1000 tokens = 10_000 total; budget allows only 5_000
  // at safety_margin=1.0, so max_concurrent should be 5.
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 1.0,
        empirical_half_life_hours: 24,
        models: {
          "test/model": { input_tokens_per_minute: 5000 },
        },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 10,
    estimatedSlotTokens: new Array(10).fill(1000),
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  assert.equal(schedule.max_concurrent, 5, "max_concurrent should be capped by tpm");
  assert.equal(schedule.binding_cap, "tpm");
});

test("learned cap: scheduleWave uses quotaStateEntry when provided", () => {
  // A quota-state entry with a very low success score drives the learned cap.
  // Inject a state entry with a single success at concurrency 1 and no higher
  // evidence — computeRampUpConcurrency will return 1.
  const quotaStateEntry = {
    buckets: {
      "1": { success_weight: 1, failure_weight: 0 },
    },
    consecutive_429_count: 0,
    cooldown_until: null,
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: baseSessionConfig(),
    hostModel: null,
    requestedConcurrency: 10,
    quotaStateEntry,
    hostConcurrencyLimit: null,
  });
  assert.equal(schedule.max_concurrent, 1, "max_concurrent should be capped by learned history");
  assert.equal(schedule.binding_cap, "learned");
});

test("fallback cap: scheduleWave applies unknown_hosted_concurrency when no learned history", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 0.8,
        empirical_half_life_hours: 24,
        unknown_hosted_concurrency: 2,
      },
    },
    hostModel: null,
    requestedConcurrency: 20,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  assert.equal(schedule.max_concurrent, 2, "max_concurrent should be capped by fallback");
  assert.equal(schedule.binding_cap, "fallback");
});

test("first_contact cap: scheduleWave applies first_contact_concurrency for unconfigured local provider", () => {
  // A local provider with no learned history, no RPM/TPM limits, no fallback
  // (unknown_local_concurrency undefined) should hit the first-contact ceiling.
  const schedule = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 0.8,
        empirical_half_life_hours: 24,
        first_contact_concurrency: 2,
        // unknown_local_concurrency intentionally absent
      },
    },
    hostModel: null,
    requestedConcurrency: 20,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
  });
  assert.equal(schedule.max_concurrent, 2, "max_concurrent should be capped by first_contact");
  assert.equal(schedule.binding_cap, "first_contact");
});

// ── Discovered-capability context window (N5a) ───────────────────────────────
// A host that reports its real context window at the dispatch handshake must
// outrank the conservative default AND the static known-model table.

test("discovered capability: context window overrides the 32k default for a null model", () => {
  // model:null normally falls to the 32k provider/default floor. A discovered
  // 200k window must take over so the partition sizes to the real model.
  const schedule = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: baseSessionConfig(),
    hostModel: null,
    requestedConcurrency: 4,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
    discoveredLimits: { context_tokens: 200_000, output_tokens: 32_000 },
  });
  assert.equal(schedule.resolved_limits.context_tokens, 200_000);
  assert.equal(schedule.resolved_limits.output_tokens, 32_000);
  assert.equal(schedule.source, "discovered_capability");
});

test("discovered capability: explicit per-model config still wins over discovery", () => {
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {
      quota: {
        enabled: true,
        safety_margin: 0.8,
        empirical_half_life_hours: 24,
        models: { "test/model": { context_tokens: 128_000, output_tokens: 8_192 } },
      },
    },
    hostModel: "test/model",
    requestedConcurrency: 4,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
    discoveredLimits: { context_tokens: 200_000, output_tokens: 32_000 },
  });
  assert.equal(schedule.resolved_limits.context_tokens, 128_000);
  assert.equal(schedule.source, "explicit_config");
});

test("discovered capability: absent context window leaves resolution unchanged", () => {
  // Only RPM/TPM discovered (no context window) → context still resolves from
  // the existing rungs, not the discovered channel.
  const schedule = scheduleWave({
    providerName: "local-subprocess",
    sessionConfig: baseSessionConfig(),
    hostModel: null,
    requestedConcurrency: 4,
    quotaStateEntry: null,
    hostConcurrencyLimit: null,
    discoveredLimits: { requests_per_minute: 10 },
  });
  assert.equal(schedule.resolved_limits.context_tokens, 32_000);
  assert.notEqual(schedule.source, "discovered_capability");
});
