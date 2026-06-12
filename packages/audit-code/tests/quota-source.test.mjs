import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setQuotaStateDir } = await import("@audit-tools/shared/quota/state");
setQuotaStateDir(join(tmpdir(), ".audit-code-test"));

const { LearnedQuotaSource } = await import("@audit-tools/shared/quota/learnedQuotaSource");
const { CompositeQuotaSource, buildQuotaSource } = await import("@audit-tools/shared/quota/compositeQuotaSource");
const { scheduleWave } = await import("@audit-tools/shared/quota/scheduler");

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

test("scheduleWave throttles to 1 when remaining_pct < 10%", () => {
  const snapshot = {
    remaining_pct: 0.05,
    reset_at: new Date(Date.now() + 60_000).toISOString(),
    requests_remaining: 2,
    tokens_remaining: null,
    captured_at: new Date().toISOString(),
    source: "test",
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { unknown_hosted_concurrency: 10 } },
    hostModel: null,
    requestedConcurrency: 10,
    quotaSourceSnapshot: snapshot,
  });
  assert.equal(schedule.max_concurrent, 1);
  assert.equal(schedule.cooldown_until, snapshot.reset_at);
  assert.deepEqual(schedule.quota_source_snapshot, snapshot);
});

test("scheduleWave halves wave when remaining_pct < 30%", () => {
  const snapshot = {
    remaining_pct: 0.25,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date().toISOString(),
    source: "test",
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { unknown_hosted_concurrency: 10 } },
    hostModel: null,
    requestedConcurrency: 10,
    quotaSourceSnapshot: snapshot,
  });
  assert.equal(schedule.max_concurrent, 5);
});

test("scheduleWave does not throttle when remaining_pct >= 30%", () => {
  const snapshot = {
    remaining_pct: 0.5,
    reset_at: null,
    requests_remaining: null,
    tokens_remaining: null,
    captured_at: new Date().toISOString(),
    source: "test",
  };
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { unknown_hosted_concurrency: 10 } },
    hostModel: null,
    requestedConcurrency: 10,
    quotaSourceSnapshot: snapshot,
  });
  assert.equal(schedule.max_concurrent, 10);
});
