import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { setQuotaStateDir, readQuotaState, recordWaveOutcome } = await import(
  "../dist/quota/state.js"
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
