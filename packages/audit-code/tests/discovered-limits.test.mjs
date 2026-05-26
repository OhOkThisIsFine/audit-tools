import test from "node:test";
import assert from "node:assert/strict";

const { mergeDiscoveredLimits } = await import("../dist/quota/discoveredLimits.js");

// ── mergeDiscoveredLimits ───────────────────────────────────────────────────

test("mergeDiscoveredLimits returns null for no sources", () => {
  assert.equal(mergeDiscoveredLimits(), null);
  assert.equal(mergeDiscoveredLimits(null, undefined), null);
});

test("mergeDiscoveredLimits returns single source unchanged", () => {
  const source = { requests_per_minute: 50, source: "provider_query" };
  const result = mergeDiscoveredLimits(source);
  assert.deepEqual(result, { ...source });
});

test("mergeDiscoveredLimits prefers earlier sources", () => {
  const provider = { requests_per_minute: 50, source: "provider_query" };
  const cached = {
    requests_per_minute: 30,
    input_tokens_per_minute: 100000,
    source: "header_extraction",
  };

  const result = mergeDiscoveredLimits(provider, cached);
  assert.equal(result.requests_per_minute, 50);
  assert.equal(result.input_tokens_per_minute, 100000);
});

test("mergeDiscoveredLimits fills nulls from later sources", () => {
  const provider = { requests_per_minute: null, source: "provider_query" };
  const cached = {
    requests_per_minute: 30,
    input_tokens_per_minute: 100000,
    source: "header_extraction",
  };

  const result = mergeDiscoveredLimits(provider, cached);
  assert.equal(result.requests_per_minute, 30);
  assert.equal(result.input_tokens_per_minute, 100000);
});

test("mergeDiscoveredLimits skips null sources in the chain", () => {
  const provider = null;
  const cached = {
    requests_per_minute: 30,
    source: "header_extraction",
  };

  const result = mergeDiscoveredLimits(provider, cached);
  assert.equal(result.requests_per_minute, 30);
});

// ── scheduleWave with discoveredLimits ──────────────────────────────────────

const { scheduleWave } = await import("../dist/quota/scheduler.js");

test("scheduleWave caps by discovered RPM", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 30,
    discoveredLimits: { requests_per_minute: 10, source: "header_extraction" },
  });
  // 10 * 0.8 safety margin = 8
  assert.equal(schedule.wave_size, 8);
});

test("scheduleWave caps by discovered TPM", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 30,
    estimatedPacketTokens: 10000,
    discoveredLimits: {
      input_tokens_per_minute: 50000,
      source: "header_extraction",
    },
  });
  // 50000 * 0.8 / 10000 = 4
  assert.equal(schedule.wave_size, 4);
});

test("scheduleWave explicit config overrides discovered limits", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {
      quota: {
        models: {
          "test-model": { requests_per_minute: 5 },
        },
      },
    },
    hostModel: "test-model",
    requestedConcurrency: 30,
    discoveredLimits: { requests_per_minute: 50, source: "header_extraction" },
  });
  // explicit config RPM (5) wins: 5 * 0.8 = 4
  assert.equal(schedule.wave_size, 4);
});

test("scheduleWave first-contact cap does not fire when discoveredLimits provide RPM", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
    discoveredLimits: { requests_per_minute: 100, source: "header_extraction" },
  });
  // RPM cap: 100 * 0.8 = 80, requestedConcurrency = 22 → wave = 22 (no first-contact)
  assert.equal(schedule.wave_size, 22);
});

test("scheduleWave first-contact cap applies with custom value", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: { quota: { first_contact_concurrency: 5 } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
  });
  assert.equal(schedule.wave_size, 5);
});
