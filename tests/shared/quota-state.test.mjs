import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  setQuotaStateDir,
  readQuotaState,
  recordWaveOutcome,
  clearBucketFailureEvidence,
  applyDecayToEntry,
  computeRampUpConcurrency,
  computeMaxSafeConcurrency,
  MAX_BUCKET_LEVEL,
} = await import("../../src/shared/quota/state.ts");

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

test("recordWaveOutcome success clears cooldown_until", async () => {
  await withTempStateDir(async () => {
    // Case 1: cooldown_until is set from a prior 429 — a success clears it.
    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "rate_limited" }, 24);
    {
      const stateAfter429 = await readQuotaState();
      assert.ok(
        stateAfter429.entries[KEY].cooldown_until !== null,
        "cooldown_until should be set after a rate_limited outcome",
      );
    }

    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "success" }, 24);
    {
      const stateAfterSuccess = await readQuotaState();
      const entry = stateAfterSuccess.entries[KEY];
      assert.equal(
        entry.cooldown_until,
        null,
        "cooldown_until must be null after a success outcome",
      );
      // consecutive_429_count must also be cleared.
      assert.equal(entry.consecutive_429_count, 0);
    }
  });

  await withTempStateDir(async () => {
    // Case 2: no prior 429 — success keeps cooldown_until null (no regression).
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "success" }, 24);
    const state = await readQuotaState();
    assert.equal(
      state.entries[KEY].cooldown_until,
      null,
      "cooldown_until should remain null when no prior cooldown existed",
    );
  });
});

test("applyDecayToEntry returns the same entry reference when elapsed time is below 0.001 hours", () => {
  const entry = {
    updated_at: new Date().toISOString(),
    buckets: { "1": { success_weight: 2.0, failure_weight: 1.0 } },
    cooldown_until: null,
    last_429_at: null,
    consecutive_429_count: 0,
  };
  const result = applyDecayToEntry(entry, 24);
  // The early-exit guard (elapsedHours < 0.001) must return the exact same reference.
  assert.strictEqual(result, entry, "should return the identical object reference when elapsed < 0.001h");
  // No bucket mutation.
  assert.equal(entry.buckets["1"].success_weight, 2.0);
  assert.equal(entry.buckets["1"].failure_weight, 1.0);
});

test("applyDecayToEntry decays all bucket weights to near-zero after many half-lives", () => {
  const entry = {
    updated_at: new Date(Date.now() - 720 * 3600000).toISOString(), // 30 half-lives ago
    buckets: { "1": { success_weight: 0.001, failure_weight: 0.001 } },
    cooldown_until: null,
    last_429_at: null,
    consecutive_429_count: 0,
  };
  const result = applyDecayToEntry(entry, 24);
  assert.ok(
    result.buckets["1"].success_weight < 1e-6,
    `success_weight should be near-zero after 30 half-lives, got ${result.buckets["1"].success_weight}`,
  );
  assert.ok(
    result.buckets["1"].failure_weight < 1e-6,
    `failure_weight should be near-zero after 30 half-lives, got ${result.buckets["1"].failure_weight}`,
  );
});

test("applyDecayToEntry halves weights after exactly one half-life and preserves other fields", () => {
  const entry = {
    updated_at: new Date(Date.now() - 24 * 3600000).toISOString(), // 24 hours ago = 1 half-life
    buckets: { "1": { success_weight: 4.0, failure_weight: 2.0 } },
    cooldown_until: null,
    last_429_at: null,
    consecutive_429_count: 0,
  };
  const result = applyDecayToEntry(entry, 24);
  // Must be a new object, not the same reference.
  assert.notStrictEqual(result, entry, "should return a new object after decay");
  // Weights halved (within 1% tolerance to account for sub-millisecond clock drift).
  assert.ok(
    Math.abs(result.buckets["1"].success_weight - 2.0) < 0.01,
    `success_weight should be ~2.0 after one half-life, got ${result.buckets["1"].success_weight}`,
  );
  assert.ok(
    Math.abs(result.buckets["1"].failure_weight - 1.0) < 0.01,
    `failure_weight should be ~1.0 after one half-life, got ${result.buckets["1"].failure_weight}`,
  );
  // Other fields preserved.
  assert.equal(result.updated_at, entry.updated_at, "updated_at should be preserved");
  assert.equal(result.cooldown_until, null, "cooldown_until should be preserved");
  // Original not mutated.
  assert.equal(entry.buckets["1"].success_weight, 4.0, "original success_weight must not be mutated");
});

// Helper: build a minimal QuotaStateEntry with a single bucket at level N.
function makeEntryWithBucket(n, success_weight, failure_weight) {
  return {
    updated_at: new Date().toISOString(),
    buckets: { [String(n)]: { success_weight, failure_weight } },
    cooldown_until: null,
    last_429_at: null,
    consecutive_429_count: 0,
  };
}

test("computeRampUpConcurrency: allows ramp-up when failure_weight has decayed below MIN_EVIDENCE_WEIGHT", () => {
  // RAMP_UP_MIN_SUCCESSES = 2; MIN_EVIDENCE_WEIGHT = 0.5
  // failure_weight = 0.1 (below threshold) → ramp-up permitted: returns N+1
  const entry = makeEntryWithBucket(1, 3.0, 0.1);
  const result = computeRampUpConcurrency(entry, 24);
  assert.equal(result, 2, "failure_weight 0.1 < MIN_EVIDENCE_WEIGHT should permit ramp-up to N+1");
});

test("computeRampUpConcurrency: suppresses ramp-up when failure_weight equals MIN_EVIDENCE_WEIGHT", () => {
  // failure_weight exactly 0.5 (at threshold boundary) → ramp-up suppressed: returns N
  const entry = makeEntryWithBucket(1, 3.0, 0.5);
  const result = computeRampUpConcurrency(entry, 24);
  assert.equal(result, 1, "failure_weight === MIN_EVIDENCE_WEIGHT should suppress ramp-up");
});

test("computeRampUpConcurrency: suppresses ramp-up when failure_weight exceeds MIN_EVIDENCE_WEIGHT", () => {
  // failure_weight = 1.0 (above threshold) → ramp-up suppressed: returns N
  const entry = makeEntryWithBucket(1, 3.0, 1.0);
  const result = computeRampUpConcurrency(entry, 24);
  assert.equal(result, 1, "failure_weight > MIN_EVIDENCE_WEIGHT should suppress ramp-up");
});

test("computeRampUpConcurrency: allows ramp-up when failure_weight is exactly zero (no failures ever)", () => {
  // failure_weight = 0 (never any failures) → ramp-up permitted: returns N+1
  const entry = makeEntryWithBucket(1, 3.0, 0);
  const result = computeRampUpConcurrency(entry, 24);
  assert.equal(result, 2, "failure_weight === 0 should permit ramp-up to N+1");
});

// ── ARC-09b7ce76-2 regression: bucket map growth cap ──────────────────────────

test("ARC-09b7ce76-2: success at very high concurrency does not write buckets above MAX_BUCKET_LEVEL", async () => {
  await withTempStateDir(async () => {
    // Report a success at a concurrency far above the scan ceiling (MAX_BUCKET_LEVEL=32).
    const highConcurrency = MAX_BUCKET_LEVEL + 20; // e.g. 52
    await recordWaveOutcome(KEY, { concurrency: highConcurrency, estimated_tokens: 0, outcome: "success" }, 24);

    const state = await readQuotaState();
    const buckets = state.entries[KEY].buckets;
    const keys = Object.keys(buckets).map(Number);

    // No bucket key must exceed MAX_BUCKET_LEVEL — those entries are never read
    // back and would grow the file indefinitely.
    const aboveCeiling = keys.filter((k) => k > MAX_BUCKET_LEVEL);
    assert.equal(
      aboveCeiling.length,
      0,
      `success path wrote buckets above MAX_BUCKET_LEVEL (${MAX_BUCKET_LEVEL}): ${aboveCeiling.join(",")} — ARC-09b7ce76-2 regression`,
    );
    // Buckets 1..MAX_BUCKET_LEVEL must be written (proof that success evidence is recorded).
    assert.ok(
      buckets[String(MAX_BUCKET_LEVEL)]?.success_weight > 0,
      `bucket ${MAX_BUCKET_LEVEL} (the ceiling) must have success evidence`,
    );
  });
});

test("ARC-09b7ce76-2: failure spread does not write buckets above MAX_BUCKET_LEVEL + FAILURE_SPREAD_BUCKETS", async () => {
  await withTempStateDir(async () => {
    // Failure at a concurrency so high that the spread would go far past the scan ceiling.
    const highConcurrency = MAX_BUCKET_LEVEL + 10; // 42 — spread would go to 46
    await recordWaveOutcome(KEY, { concurrency: highConcurrency, estimated_tokens: 0, outcome: "timeout" }, 24);

    const state = await readQuotaState();
    const buckets = state.entries[KEY].buckets;
    const keys = Object.keys(buckets).map(Number);

    // FAILURE_SPREAD_BUCKETS = 4 → ceiling is MAX_BUCKET_LEVEL + 4 = 36
    // No key must exceed that ceiling.
    const failureCeiling = MAX_BUCKET_LEVEL + 4; // 36
    const aboveCeiling = keys.filter((k) => k > failureCeiling);
    assert.equal(
      aboveCeiling.length,
      0,
      `failure spread wrote buckets above ceiling ${failureCeiling}: ${aboveCeiling.join(",")} — ARC-09b7ce76-2 regression`,
    );
  });
});

test("ARC-09b7ce76-2: normal failure spread within range still writes all expected buckets", async () => {
  await withTempStateDir(async () => {
    // Failure at concurrency 2 → spread 2..6 inclusive (FAILURE_SPREAD_BUCKETS=4).
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "timeout" }, 24);

    const state = await readQuotaState();
    const buckets = state.entries[KEY].buckets;
    for (const n of [2, 3, 4, 5, 6]) {
      assert.ok(buckets[String(n)]?.failure_weight > 0, `bucket ${n} must have failure evidence after spread`);
    }
    assert.equal(buckets["7"]?.failure_weight ?? 0, 0, "bucket 7 must not be touched");
  });
});

// ── ARC-09b7ce76-2 regression: clearBucketFailureEvidence recovery ─────────────

test("ARC-09b7ce76-2: clearBucketFailureEvidence zeros failure_weight on the target bucket only", async () => {
  await withTempStateDir(async () => {
    // Record a failure at concurrency 3 → spread 3..7.
    await recordWaveOutcome(KEY, { concurrency: 3, estimated_tokens: 0, outcome: "timeout" }, 24);

    // Verify the failure is there.
    const before = await readQuotaState();
    assert.ok(before.entries[KEY].buckets["3"].failure_weight > 0, "bucket 3 must have failure evidence");
    assert.ok(before.entries[KEY].buckets["4"].failure_weight > 0, "bucket 4 must have failure evidence");

    // Clear failure evidence at level 3 only.
    await clearBucketFailureEvidence(KEY, 3);

    const after = await readQuotaState();
    assert.equal(
      after.entries[KEY].buckets["3"].failure_weight,
      0,
      "clearBucketFailureEvidence must zero failure_weight on bucket 3",
    );
    // Bucket 4 must be unchanged — only the targeted bucket is cleared.
    assert.ok(
      after.entries[KEY].buckets["4"].failure_weight > 0,
      "bucket 4 failure_weight must be unchanged after clearing only bucket 3",
    );
  });
});

test("ARC-09b7ce76-2: clearBucketFailureEvidence preserves success_weight", async () => {
  await withTempStateDir(async () => {
    // Record a success at 3 then a failure at 3.
    await recordWaveOutcome(KEY, { concurrency: 3, estimated_tokens: 0, outcome: "success" }, 24);
    await recordWaveOutcome(KEY, { concurrency: 3, estimated_tokens: 0, outcome: "timeout" }, 24);

    const before = await readQuotaState();
    const successWeightBefore = before.entries[KEY].buckets["3"].success_weight;
    assert.ok(successWeightBefore > 0, "bucket 3 must have success evidence before clearing");

    await clearBucketFailureEvidence(KEY, 3);

    const after = await readQuotaState();
    assert.equal(
      after.entries[KEY].buckets["3"].failure_weight,
      0,
      "failure_weight must be zeroed",
    );
    assert.equal(
      after.entries[KEY].buckets["3"].success_weight,
      successWeightBefore,
      "success_weight must be preserved after clearing failure evidence",
    );
  });
});

// ── COR-d528d2cd: 'error' outcome must be distinct from 'timeout' ─────────────

test("COR-d528d2cd: 'error' outcome records failure weight but does NOT set rate-limit cooldown", async () => {
  await withTempStateDir(async () => {
    // Record an 'error' outcome (non-quota failure).
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "error" }, 24);

    const state = await readQuotaState();
    const entry = state.entries[KEY];

    // Failure weight must be present (error is penalised like timeout).
    assert.ok(entry.buckets["2"]?.failure_weight > 0, "error outcome must record failure_weight on the bucket");

    // consecutive_429_count must NOT be incremented — errors are not rate limits.
    assert.equal(
      entry.consecutive_429_count ?? 0,
      0,
      "error outcome must not increment consecutive_429_count",
    );

    // cooldown_until must NOT be set — only rate_limited triggers exponential backoff cooldown.
    assert.equal(
      entry.cooldown_until,
      null,
      "error outcome must not set cooldown_until (was collapased to timeout — COR-d528d2cd regression)",
    );

    // last_429_at must NOT be stamped — an 'error' is not a rate-limit signal
    // (COR-610ddf2c: the field meant "last 429" but was stamped on every failure).
    assert.equal(
      entry.last_429_at ?? null,
      null,
      "error outcome must not stamp last_429_at (COR-610ddf2c regression)",
    );
  });
});

test("COR-d528d2cd: 'timeout' outcome records failure weight and does NOT set rate-limit cooldown", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "timeout" }, 24);

    const state = await readQuotaState();
    const entry = state.entries[KEY];
    assert.ok(entry.buckets["2"]?.failure_weight > 0, "timeout outcome must record failure_weight");
    assert.equal(entry.consecutive_429_count ?? 0, 0, "timeout must not increment consecutive_429_count");
    assert.equal(entry.cooldown_until, null, "timeout must not set cooldown_until");
    // COR-610ddf2c: a timeout is not a 429 — last_429_at must stay null.
    assert.equal(entry.last_429_at ?? null, null, "timeout outcome must not stamp last_429_at (COR-610ddf2c)");
  });
});

test("COR-610ddf2c: only a 'rate_limited' outcome stamps last_429_at", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "rate_limited" }, 24);
    const entry = (await readQuotaState()).entries[KEY];
    assert.ok(
      typeof entry.last_429_at === "string" && entry.last_429_at.length > 0,
      "a rate_limited outcome must stamp last_429_at with an ISO timestamp",
    );
  });
});

test("COR-d528d2cd: 'error' and 'timeout' produce identical quota state (both are non-quota failures)", async () => {
  const KEY_ERR = "provider/model-error";
  const KEY_TMO = "provider/model-timeout";

  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY_ERR, { concurrency: 3, estimated_tokens: 0, outcome: "error" }, 24);
    await recordWaveOutcome(KEY_TMO, { concurrency: 3, estimated_tokens: 0, outcome: "timeout" }, 24);

    const state = await readQuotaState();
    const errEntry = state.entries[KEY_ERR];
    const tmoEntry = state.entries[KEY_TMO];

    // Both should have identical failure_weight and zero cooldown.
    assert.equal(
      errEntry.buckets["3"]?.failure_weight,
      tmoEntry.buckets["3"]?.failure_weight,
      "error and timeout must produce identical failure_weight at the observed concurrency",
    );
    assert.equal(errEntry.cooldown_until, null, "error: no cooldown");
    assert.equal(tmoEntry.cooldown_until, null, "timeout: no cooldown");
    assert.equal(errEntry.consecutive_429_count ?? 0, 0, "error: no 429 count");
    assert.equal(tmoEntry.consecutive_429_count ?? 0, 0, "timeout: no 429 count");
  });
});

test("COR-d528d2cd: 'rate_limited' outcome correctly increments 429 count and sets cooldown", async () => {
  await withTempStateDir(async () => {
    // Confirm rate_limited is not confused with error/timeout.
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "rate_limited" }, 24);

    const state = await readQuotaState();
    const entry = state.entries[KEY];
    assert.ok(entry.consecutive_429_count > 0, "rate_limited must increment consecutive_429_count");
    assert.ok(entry.cooldown_until !== null, "rate_limited must set cooldown_until");
  });
});

test("ARC-09b7ce76-2: clearBucketFailureEvidence on missing key or bucket is a no-op", async () => {
  await withTempStateDir(async () => {
    // No-op when key does not exist yet.
    await clearBucketFailureEvidence("nonexistent/key", 5);
    const state = await readQuotaState();
    assert.equal(Object.keys(state.entries).length, 0, "state must remain empty after no-op clear");

    // No-op when bucket does not exist for a known key.
    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "success" }, 24);
    await clearBucketFailureEvidence(KEY, 99); // bucket 99 was never written
    const stateAfter = await readQuotaState();
    assert.ok(stateAfter.entries[KEY], "key entry must still exist");
    assert.ok(stateAfter.entries[KEY].buckets["1"]?.success_weight > 0, "existing bucket must be unaffected");
  });
});

test("ARC-09b7ce76-2: clearing blocking failure unblocks computeMaxSafeConcurrency for higher levels", async () => {
  await withTempStateDir(async () => {
    // Build evidence: success at levels 1 and 2, then a failure at 2 that blocks further scan.
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "success" }, 24);
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "success" }, 24);
    // Failure at 2 adds failure_weight to 2..6, which dominates at level 2 and breaks the scan.
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "timeout" }, 24);

    const stateBlocked = await readQuotaState();
    const entryBlocked = stateBlocked.entries[KEY];
    // Failure weight at bucket 2 dominates → scan breaks at 2 → maxSafe = 1.
    const maxBefore = computeMaxSafeConcurrency(entryBlocked, 24);
    assert.equal(maxBefore, 1, "scan must stop at the failed bucket before recovery");

    // Clear the blocking failure at level 2.
    await clearBucketFailureEvidence(KEY, 2);

    const stateAfter = await readQuotaState();
    const entryAfter = stateAfter.entries[KEY];
    const maxAfter = computeMaxSafeConcurrency(entryAfter, 24);
    assert.ok(maxAfter >= 2, `maxSafe must advance past the cleared bucket — got ${maxAfter}`);
  });
});

// ── default scan ceiling is MAX_BUCKET_LEVEL (MNT-ba639774 / COR-ba639774) ─────
// computeMaxSafeConcurrency / computeRampUpConcurrency previously defaulted
// `maxToCheck` to a bare literal 32 while MAX_BUCKET_LEVEL = 32 is the documented
// write ceiling. They now default to the named constant so the scan range and the
// persisted bucket range cannot silently drift apart.

test("MNT-ba639774: computeMaxSafeConcurrency default scan ceiling tracks MAX_BUCKET_LEVEL", () => {
  // Contiguous all-success buckets 1..MAX_BUCKET_LEVEL → the default scan must
  // reach the ceiling (maxSafe === MAX_BUCKET_LEVEL). A scan capped below the
  // write ceiling would stop short and under-report safe concurrency.
  const buckets = {};
  for (let n = 1; n <= MAX_BUCKET_LEVEL; n++) {
    buckets[String(n)] = { success_weight: 1.0, failure_weight: 0 };
  }
  const entry = { updated_at: new Date().toISOString(), buckets, cooldown_until: null, last_429_at: null, consecutive_429_count: 0 };
  // Default maxToCheck (= MAX_BUCKET_LEVEL): reaches the ceiling.
  assert.equal(
    computeMaxSafeConcurrency(entry, 24),
    MAX_BUCKET_LEVEL,
    "default scan must reach MAX_BUCKET_LEVEL when every bucket up to it is safe",
  );
  // An explicit lower ceiling stops earlier — proves the default is the cap, not
  // a hidden internal constant.
  assert.equal(
    computeMaxSafeConcurrency(entry, 24, 5),
    5,
    "an explicit maxToCheck must override the default ceiling",
  );
});
