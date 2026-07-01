import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setQuotaStateDir } = await import("audit-tools/shared/quota/state");
setQuotaStateDir(join(tmpdir(), ".audit-code-test"));

const { LearnedQuotaSource } = await import("audit-tools/shared/quota/learnedQuotaSource");
const { CompositeQuotaSource, buildQuotaSource } = await import("audit-tools/shared/quota/compositeQuotaSource");
const { scheduleWave } = await import("audit-tools/shared/quota/scheduler");

// Success buckets 1..n so the learned-concurrency cap does not clamp below n —
// lets the token-budget gate be exercised in isolation. In production an entry
// accrues both its buckets and its tokens_per_pct slope together.
function fullBuckets(n) {
  const buckets = {};
  for (let i = 1; i <= n; i++) buckets[String(i)] = { success_weight: 5, failure_weight: 0 };
  return buckets;
}

// ── LearnedQuotaSource ──────────────────────────────────────────────────────

test("LearnedQuotaSource returns null for unknown provider", async () => {
  const source = new LearnedQuotaSource(24);
  const snapshot = await source.queryCurrentUsage("nonexistent/model");
  assert.equal(snapshot, null);
});

test("LearnedQuotaSource.name is 'learned'", () => {
  const source = new LearnedQuotaSource();
  assert.equal(source.name, "learned");
});

// ── CompositeQuotaSource ────────────────────────────────────────────────────

test("CompositeQuotaSource returns first non-null snapshot", async () => {
  const source1 = {
    name: "empty",
    queryCurrentUsage: async () => null,
  };
  const source2 = {
    name: "has-data",
    queryCurrentUsage: async () => ({
      remaining_pct: 0.5,
      reset_at: null,
      requests_remaining: 10,
      tokens_remaining: null,
      captured_at: new Date().toISOString(),
      source: "test",
    }),
  };
  const composite = new CompositeQuotaSource([source1, source2]);
  const snapshot = await composite.queryCurrentUsage("test/model");
  assert.equal(snapshot?.source, "test");
  assert.equal(snapshot?.remaining_pct, 0.5);
});

test("CompositeQuotaSource returns null when all sources return null", async () => {
  const source1 = { name: "a", queryCurrentUsage: async () => null };
  const source2 = { name: "b", queryCurrentUsage: async () => null };
  const composite = new CompositeQuotaSource([source1, source2]);
  const snapshot = await composite.queryCurrentUsage("test/model");
  assert.equal(snapshot, null);
});

test("CompositeQuotaSource skips failing sources", async () => {
  const failingSource = {
    name: "broken",
    queryCurrentUsage: async () => { throw new Error("connection failed"); },
  };
  const goodSource = {
    name: "good",
    queryCurrentUsage: async () => ({
      remaining_pct: 0.8,
      reset_at: null,
      requests_remaining: 5,
      tokens_remaining: null,
      captured_at: new Date().toISOString(),
      source: "good",
    }),
  };
  const composite = new CompositeQuotaSource([failingSource, goodSource]);
  const snapshot = await composite.queryCurrentUsage("test/model");
  assert.equal(snapshot?.source, "good");
});

test("buildQuotaSource prefers additional sources before learned fallback", async () => {
  const providerSource = {
    name: "provider",
    queryCurrentUsage: async () => ({
      remaining_pct: 0.4,
      reset_at: null,
      requests_remaining: 4,
      tokens_remaining: null,
      captured_at: new Date().toISOString(),
      source: "provider",
    }),
  };
  const source = buildQuotaSource({ additionalSources: [providerSource] });
  const snapshot = await source.queryCurrentUsage("test/model");

  assert.equal(snapshot?.source, "provider");
});

test("buildQuotaSource skips failing additional sources and falls back cleanly", async () => {
  const source = buildQuotaSource({
    additionalSources: [
      {
        name: "broken",
        queryCurrentUsage: async () => { throw new Error("failed"); },
      },
    ],
  });
  const snapshot = await source.queryCurrentUsage("missing/model");

  assert.equal(snapshot, null);
});

// ── Scheduler integration with quotaSourceSnapshot ──────────────────────────

test("token-budget gate: a genuinely exhausted window (remaining 0) throttles to 1 with cooldown at reset_at", () => {
  // Only a GENUINELY empty window (remaining fraction 0 — a known-zero budget for
  // any slope) throttles + persists a cooldown; the removed 0.1 cliff no longer
  // collapses a merely-low window (that path admits the cold-start calibration
  // batch instead — see the cold-start test).
  const reset = new Date(Date.now() + 60_000).toISOString();
  const snapshot = {
    remaining_pct: 0,
    reset_at: reset,
    requests_remaining: 2,
    tokens_remaining: null,
    captured_at: new Date().toISOString(),
    source: "test",
    windows: [{ label: "session", remaining_pct: 0, reset_at: reset }],
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 10,
    quotaSourceSnapshot: snapshot,
  });
  assert.equal(schedule.max_concurrent, 1);
  assert.equal(schedule.cooldown_until, reset);
  assert.deepEqual(schedule.quota_source_snapshot, snapshot);
});

test("token-budget gate: absolute tokens_remaining caps the wave directly", () => {
  const snapshot = {
    remaining_pct: 0.5,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: 3000, // top-level absolute budget
    captured_at: new Date().toISOString(),
    source: "test",
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { safety_margin: 1 } },
    hostModel: null,
    requestedConcurrency: 10,
    estimatedSlotTokens: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
    quotaSourceSnapshot: snapshot,
  });
  // 3000 budget / 1000 per slot → 3 slots fit.
  assert.equal(schedule.max_concurrent, 3);
  assert.equal(schedule.binding_cap, "token_budget");
});

test("token-budget gate: cold start (no absolute, no learned slope) admits a small calibration batch", () => {
  const snapshot = {
    remaining_pct: 0.5,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date().toISOString(),
    source: "test",
    windows: [{ label: "session", remaining_pct: 0.5, reset_at: null }],
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 10,
    quotaStateEntry: null, // no learned tokens_per_pct
    quotaSourceSnapshot: snapshot,
  });
  assert.equal(schedule.binding_cap, "token_budget");
  assert.ok(schedule.max_concurrent <= 3, `cold-start batch should be small, got ${schedule.max_concurrent}`);
});

test("token-budget gate: a healthy learned budget does not reduce the wave", () => {
  const snapshot = {
    remaining_pct: 0.9,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date().toISOString(),
    source: "test",
    windows: [{ label: "session", remaining_pct: 0.9, reset_at: null }],
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { safety_margin: 1 } },
    hostModel: null,
    requestedConcurrency: 10,
    quotaStateEntry: {
      updated_at: new Date().toISOString(),
      buckets: fullBuckets(10),
      cooldown_until: null,
      last_429_at: null,
      tokens_per_pct: { session: 100000 }, // huge slope → huge budget
    },
    estimatedSlotTokens: [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000],
    quotaSourceSnapshot: snapshot,
  });
  assert.equal(schedule.max_concurrent, 10);
  assert.equal(schedule.binding_cap, "none");
});

test("token-budget gate: weekly-binding vs session-binding pools use distinct slopes (MIN over windows)", () => {
  // A pool where the WEEKLY window is the binding (smaller) budget: its learned
  // slope × its remaining_pct gives a smaller token budget than the session window,
  // so the MIN-over-windows reduction picks weekly.
  const snapshot = {
    remaining_pct: 0.2, // min binding window surfaced flat
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date().toISOString(),
    source: "test",
    windows: [
      { label: "session", remaining_pct: 0.8, reset_at: null },
      { label: "weekly", remaining_pct: 0.2, reset_at: null },
    ],
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { safety_margin: 1 } },
    hostModel: null,
    requestedConcurrency: 10,
    quotaStateEntry: {
      updated_at: new Date().toISOString(),
      buckets: fullBuckets(10),
      cooldown_until: null,
      last_429_at: null,
      // session: 80% × 1000 = 80000 budget; weekly: 20% × 50 = 1000 budget → weekly binds.
      tokens_per_pct: { session: 1000, weekly: 50 },
    },
    estimatedSlotTokens: [500, 500, 500, 500, 500, 500, 500, 500, 500, 500],
    quotaSourceSnapshot: snapshot,
  });
  // weekly budget 1000 / 500 per slot → 2 slots; NOT the session budget's ~many.
  assert.equal(schedule.max_concurrent, 2);
  assert.equal(schedule.binding_cap, "token_budget");
});
