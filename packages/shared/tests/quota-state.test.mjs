import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setQuotaStateDir, readQuotaState, recordWaveOutcome } = await import(
  "../src/quota/state.ts"
);

async function withTempStateDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-quota-"));
  setQuotaStateDir(dir);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const KEY = "provider/model";

test("failure spread applies weight to exactly FAILURE_SPREAD_BUCKETS+1 buckets starting at concurrency", async () => {
  await withTempStateDir(async () => {
    // A timeout is a non-success outcome that runs the failure-spread branch
    // with a flat weight of 1.0 (no 429 backoff math involved).
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "timeout" }, 24);

    const state = await readQuotaState();
    const buckets = state.entries[KEY].buckets;
    // concurrency (2) through concurrency + 4 (6) inclusive => 5 buckets.
    for (const n of [2, 3, 4, 5, 6]) {
      assert.ok(buckets[String(n)]?.failure_weight > 0, `bucket ${n} should have failure_weight`);
    }
    // One past the spread must not be touched.
    assert.equal(buckets["7"]?.failure_weight ?? 0, 0);
    // Below the starting concurrency must not be touched either.
    assert.equal(buckets["1"]?.failure_weight ?? 0, 0);
  });
});

test("failure spread starts at the reported concurrency for rate_limited outcomes", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "rate_limited" }, 24);

    const state = await readQuotaState();
    const buckets = state.entries[KEY].buckets;
    // concurrency (1) through concurrency + 4 (5) inclusive => 5 buckets.
    for (const n of [1, 2, 3, 4, 5]) {
      assert.ok(buckets[String(n)]?.failure_weight > 0, `bucket ${n} should have failure_weight`);
    }
    assert.equal(buckets["6"]?.failure_weight ?? 0, 0);
  });
});

test("success increments buckets 1..concurrency and persists across a reload", async () => {
  await withTempStateDir(async () => {
    // First record a 429 so consecutive_429_count is non-zero, then prove a
    // success resets it to 0.
    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "rate_limited" }, 24);
    await recordWaveOutcome(KEY, { concurrency: 3, estimated_tokens: 0, outcome: "success" }, 24);

    const state = await readQuotaState();
    const entry = state.entries[KEY];
    const buckets = entry.buckets;
    // Success at concurrency 3 increments success_weight on buckets 1..3.
    for (const n of [1, 2, 3]) {
      assert.ok(buckets[String(n)]?.success_weight > 0, `bucket ${n} should have success_weight`);
    }
    // Bucket 4 (above the reported concurrency) is not credited a success.
    assert.equal(buckets["4"]?.success_weight ?? 0, 0);
    // The success path resets the consecutive 429 counter.
    assert.equal(entry.consecutive_429_count, 0);

    // Disk round-trip: a fresh readQuotaState() returns the same persisted
    // buckets/weights, confirming withFileLock + writeQuotaState wrote state.
    const reread = await readQuotaState();
    assert.deepEqual(reread.entries[KEY].buckets, buckets);
  });
});
