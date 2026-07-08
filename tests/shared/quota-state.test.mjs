import { test, expect } from "vitest";
import { mkdtemp, mkdir, rm, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const {
  setQuotaStateDir,
  getQuotaStatePath,
  readQuotaState,
  readQuotaStateOrDegrade,
  writeQuotaState,
  emptyQuotaState,
  QuotaStateUnavailableError,
  recordWaveOutcome,
  clearBucketFailureEvidence,
  applyDecayToEntry,
  computeRampUpConcurrency,
  computeMaxSafeConcurrency,
  MAX_BUCKET_LEVEL,
  foldTokensPerPctObservation,
  recordTokensPerPctObservation,
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
      expect(buckets[String(n)]?.failure_weight > 0, `bucket ${n} should have failure_weight`).toBeTruthy();
    }
    // One past the spread must not be touched.
    expect(buckets["7"]?.failure_weight ?? 0).toBe(0);
    // Below the starting concurrency must not be touched either.
    expect(buckets["1"]?.failure_weight ?? 0).toBe(0);
  });
});

test("failure spread starts at the reported concurrency for rate_limited outcomes", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "rate_limited" }, 24);

    const state = await readQuotaState();
    const buckets = state.entries[KEY].buckets;
    // concurrency (1) through concurrency + 4 (5) inclusive => 5 buckets.
    for (const n of [1, 2, 3, 4, 5]) {
      expect(buckets[String(n)]?.failure_weight > 0, `bucket ${n} should have failure_weight`).toBeTruthy();
    }
    expect(buckets["6"]?.failure_weight ?? 0).toBe(0);
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
      expect(buckets[String(n)]?.success_weight > 0, `bucket ${n} should have success_weight`).toBeTruthy();
    }
    // Bucket 4 (above the reported concurrency) is not credited a success.
    expect(buckets["4"]?.success_weight ?? 0).toBe(0);
    // The success path resets the consecutive 429 counter.
    expect(entry.consecutive_429_count).toBe(0);

    // Disk round-trip: a fresh readQuotaState() returns the same persisted
    // buckets/weights, confirming withFileLock + writeQuotaState wrote state.
    const reread = await readQuotaState();
    expect(reread.entries[KEY].buckets).toEqual(buckets);
  });
});

test("recordWaveOutcome success clears cooldown_until", async () => {
  await withTempStateDir(async () => {
    // Case 1: cooldown_until is set from a prior 429 — a success clears it.
    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "rate_limited" }, 24);
    {
      const stateAfter429 = await readQuotaState();
      expect(stateAfter429.entries[KEY].cooldown_until !== null, "cooldown_until should be set after a rate_limited outcome").toBeTruthy();
    }

    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "success" }, 24);
    {
      const stateAfterSuccess = await readQuotaState();
      const entry = stateAfterSuccess.entries[KEY];
      expect(entry.cooldown_until, "cooldown_until must be null after a success outcome").toBe(null);
      // consecutive_429_count must also be cleared.
      expect(entry.consecutive_429_count).toBe(0);
    }
  });

  await withTempStateDir(async () => {
    // Case 2: no prior 429 — success keeps cooldown_until null (no regression).
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "success" }, 24);
    const state = await readQuotaState();
    expect(state.entries[KEY].cooldown_until, "cooldown_until should remain null when no prior cooldown existed").toBe(null);
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
  expect(result, "should return the identical object reference when elapsed < 0.001h").toBe(entry);
  // No bucket mutation.
  expect(entry.buckets["1"].success_weight).toBe(2.0);
  expect(entry.buckets["1"].failure_weight).toBe(1.0);
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
  expect(result.buckets["1"].success_weight < 1e-6, `success_weight should be near-zero after 30 half-lives, got ${result.buckets["1"].success_weight}`).toBeTruthy();
  expect(result.buckets["1"].failure_weight < 1e-6, `failure_weight should be near-zero after 30 half-lives, got ${result.buckets["1"].failure_weight}`).toBeTruthy();
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
  expect(result, "should return a new object after decay").not.toBe(entry);
  // Weights halved (within 1% tolerance to account for sub-millisecond clock drift).
  expect(Math.abs(result.buckets["1"].success_weight - 2.0) < 0.01, `success_weight should be ~2.0 after one half-life, got ${result.buckets["1"].success_weight}`).toBeTruthy();
  expect(Math.abs(result.buckets["1"].failure_weight - 1.0) < 0.01, `failure_weight should be ~1.0 after one half-life, got ${result.buckets["1"].failure_weight}`).toBeTruthy();
  // Other fields preserved.
  expect(result.updated_at, "updated_at should be preserved").toBe(entry.updated_at);
  expect(result.cooldown_until, "cooldown_until should be preserved").toBe(null);
  // Original not mutated.
  expect(entry.buckets["1"].success_weight, "original success_weight must not be mutated").toBe(4.0);
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
  expect(result, "failure_weight 0.1 < MIN_EVIDENCE_WEIGHT should permit ramp-up to N+1").toBe(2);
});

test("computeRampUpConcurrency: suppresses ramp-up when failure_weight equals MIN_EVIDENCE_WEIGHT", () => {
  // failure_weight exactly 0.5 (at threshold boundary) → ramp-up suppressed: returns N
  const entry = makeEntryWithBucket(1, 3.0, 0.5);
  const result = computeRampUpConcurrency(entry, 24);
  expect(result, "failure_weight === MIN_EVIDENCE_WEIGHT should suppress ramp-up").toBe(1);
});

test("computeRampUpConcurrency: suppresses ramp-up when failure_weight exceeds MIN_EVIDENCE_WEIGHT", () => {
  // failure_weight = 1.0 (above threshold) → ramp-up suppressed: returns N
  const entry = makeEntryWithBucket(1, 3.0, 1.0);
  const result = computeRampUpConcurrency(entry, 24);
  expect(result, "failure_weight > MIN_EVIDENCE_WEIGHT should suppress ramp-up").toBe(1);
});

test("computeRampUpConcurrency: allows ramp-up when failure_weight is exactly zero (no failures ever)", () => {
  // failure_weight = 0 (never any failures) → ramp-up permitted: returns N+1
  const entry = makeEntryWithBucket(1, 3.0, 0);
  const result = computeRampUpConcurrency(entry, 24);
  expect(result, "failure_weight === 0 should permit ramp-up to N+1").toBe(2);
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
    expect(aboveCeiling.length, `success path wrote buckets above MAX_BUCKET_LEVEL (${MAX_BUCKET_LEVEL}): ${aboveCeiling.join(",")} — ARC-09b7ce76-2 regression`).toBe(0);
    // Buckets 1..MAX_BUCKET_LEVEL must be written (proof that success evidence is recorded).
    expect(buckets[String(MAX_BUCKET_LEVEL)]?.success_weight > 0, `bucket ${MAX_BUCKET_LEVEL} (the ceiling) must have success evidence`).toBeTruthy();
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
    expect(aboveCeiling.length, `failure spread wrote buckets above ceiling ${failureCeiling}: ${aboveCeiling.join(",")} — ARC-09b7ce76-2 regression`).toBe(0);
  });
});

test("ARC-09b7ce76-2: normal failure spread within range still writes all expected buckets", async () => {
  await withTempStateDir(async () => {
    // Failure at concurrency 2 → spread 2..6 inclusive (FAILURE_SPREAD_BUCKETS=4).
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "timeout" }, 24);

    const state = await readQuotaState();
    const buckets = state.entries[KEY].buckets;
    for (const n of [2, 3, 4, 5, 6]) {
      expect(buckets[String(n)]?.failure_weight > 0, `bucket ${n} must have failure evidence after spread`).toBeTruthy();
    }
    expect(buckets["7"]?.failure_weight ?? 0, "bucket 7 must not be touched").toBe(0);
  });
});

// ── ARC-09b7ce76-2 regression: clearBucketFailureEvidence recovery ─────────────

test("ARC-09b7ce76-2: clearBucketFailureEvidence zeros failure_weight on the target bucket only", async () => {
  await withTempStateDir(async () => {
    // Record a failure at concurrency 3 → spread 3..7.
    await recordWaveOutcome(KEY, { concurrency: 3, estimated_tokens: 0, outcome: "timeout" }, 24);

    // Verify the failure is there.
    const before = await readQuotaState();
    expect(before.entries[KEY].buckets["3"].failure_weight > 0, "bucket 3 must have failure evidence").toBeTruthy();
    expect(before.entries[KEY].buckets["4"].failure_weight > 0, "bucket 4 must have failure evidence").toBeTruthy();

    // Clear failure evidence at level 3 only.
    await clearBucketFailureEvidence(KEY, 3);

    const after = await readQuotaState();
    expect(after.entries[KEY].buckets["3"].failure_weight, "clearBucketFailureEvidence must zero failure_weight on bucket 3").toBe(0);
    // Bucket 4 must be unchanged — only the targeted bucket is cleared.
    expect(after.entries[KEY].buckets["4"].failure_weight > 0, "bucket 4 failure_weight must be unchanged after clearing only bucket 3").toBeTruthy();
  });
});

test("ARC-09b7ce76-2: clearBucketFailureEvidence preserves success_weight", async () => {
  await withTempStateDir(async () => {
    // Record a success at 3 then a failure at 3.
    await recordWaveOutcome(KEY, { concurrency: 3, estimated_tokens: 0, outcome: "success" }, 24);
    await recordWaveOutcome(KEY, { concurrency: 3, estimated_tokens: 0, outcome: "timeout" }, 24);

    const before = await readQuotaState();
    const successWeightBefore = before.entries[KEY].buckets["3"].success_weight;
    expect(successWeightBefore > 0, "bucket 3 must have success evidence before clearing").toBeTruthy();

    await clearBucketFailureEvidence(KEY, 3);

    const after = await readQuotaState();
    expect(after.entries[KEY].buckets["3"].failure_weight, "failure_weight must be zeroed").toBe(0);
    expect(after.entries[KEY].buckets["3"].success_weight, "success_weight must be preserved after clearing failure evidence").toBe(successWeightBefore);
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
    expect(entry.buckets["2"]?.failure_weight > 0, "error outcome must record failure_weight on the bucket").toBeTruthy();

    // consecutive_429_count must NOT be incremented — errors are not rate limits.
    expect(entry.consecutive_429_count ?? 0, "error outcome must not increment consecutive_429_count").toBe(0);

    // cooldown_until must NOT be set — only rate_limited triggers exponential backoff cooldown.
    expect(entry.cooldown_until, "error outcome must not set cooldown_until (was collapased to timeout — COR-d528d2cd regression)").toBe(null);

    // last_429_at must NOT be stamped — an 'error' is not a rate-limit signal
    // (COR-610ddf2c: the field meant "last 429" but was stamped on every failure).
    expect(entry.last_429_at ?? null, "error outcome must not stamp last_429_at (COR-610ddf2c regression)").toBe(null);
  });
});

test("COR-d528d2cd: 'timeout' outcome records failure weight and does NOT set rate-limit cooldown", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "timeout" }, 24);

    const state = await readQuotaState();
    const entry = state.entries[KEY];
    expect(entry.buckets["2"]?.failure_weight > 0, "timeout outcome must record failure_weight").toBeTruthy();
    expect(entry.consecutive_429_count ?? 0, "timeout must not increment consecutive_429_count").toBe(0);
    expect(entry.cooldown_until, "timeout must not set cooldown_until").toBe(null);
    // COR-610ddf2c: a timeout is not a 429 — last_429_at must stay null.
    expect(entry.last_429_at ?? null, "timeout outcome must not stamp last_429_at (COR-610ddf2c)").toBe(null);
  });
});

test("COR-610ddf2c: only a 'rate_limited' outcome stamps last_429_at", async () => {
  await withTempStateDir(async () => {
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "rate_limited" }, 24);
    const entry = (await readQuotaState()).entries[KEY];
    expect(typeof entry.last_429_at === "string" && entry.last_429_at.length > 0, "a rate_limited outcome must stamp last_429_at with an ISO timestamp").toBeTruthy();
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
    expect(errEntry.buckets["3"]?.failure_weight, "error and timeout must produce identical failure_weight at the observed concurrency").toBe(tmoEntry.buckets["3"]?.failure_weight);
    expect(errEntry.cooldown_until, "error: no cooldown").toBe(null);
    expect(tmoEntry.cooldown_until, "timeout: no cooldown").toBe(null);
    expect(errEntry.consecutive_429_count ?? 0, "error: no 429 count").toBe(0);
    expect(tmoEntry.consecutive_429_count ?? 0, "timeout: no 429 count").toBe(0);
  });
});

test("COR-d528d2cd: 'rate_limited' outcome correctly increments 429 count and sets cooldown", async () => {
  await withTempStateDir(async () => {
    // Confirm rate_limited is not confused with error/timeout.
    await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "rate_limited" }, 24);

    const state = await readQuotaState();
    const entry = state.entries[KEY];
    expect(entry.consecutive_429_count > 0, "rate_limited must increment consecutive_429_count").toBeTruthy();
    expect(entry.cooldown_until !== null, "rate_limited must set cooldown_until").toBeTruthy();
  });
});

test("ARC-09b7ce76-2: clearBucketFailureEvidence on missing key or bucket is a no-op", async () => {
  await withTempStateDir(async () => {
    // No-op when key does not exist yet.
    await clearBucketFailureEvidence("nonexistent/key", 5);
    const state = await readQuotaState();
    expect(Object.keys(state.entries).length, "state must remain empty after no-op clear").toBe(0);

    // No-op when bucket does not exist for a known key.
    await recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "success" }, 24);
    await clearBucketFailureEvidence(KEY, 99); // bucket 99 was never written
    const stateAfter = await readQuotaState();
    expect(stateAfter.entries[KEY], "key entry must still exist").toBeTruthy();
    expect(stateAfter.entries[KEY].buckets["1"]?.success_weight > 0, "existing bucket must be unaffected").toBeTruthy();
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
    expect(maxBefore, "scan must stop at the failed bucket before recovery").toBe(1);

    // Clear the blocking failure at level 2.
    await clearBucketFailureEvidence(KEY, 2);

    const stateAfter = await readQuotaState();
    const entryAfter = stateAfter.entries[KEY];
    const maxAfter = computeMaxSafeConcurrency(entryAfter, 24);
    expect(maxAfter >= 2, `maxSafe must advance past the cleared bucket — got ${maxAfter}`).toBeTruthy();
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
  expect(computeMaxSafeConcurrency(entry, 24), "default scan must reach MAX_BUCKET_LEVEL when every bucket up to it is safe").toBe(MAX_BUCKET_LEVEL);
  // An explicit lower ceiling stops earlier — proves the default is the cap, not
  // a hidden internal constant.
  expect(computeMaxSafeConcurrency(entry, 24, 5), "an explicit maxToCheck must override the default ceiling").toBe(5);
});

// ── Token-budget slope learning (tokens_per_pct) ────────────────────────────

test("foldTokensPerPctObservation seeds a new window slope from the first sample", () => {
  // 5000 tokens over a 5-percent drop (0.50 → 0.45) → slope 1000 tokens/percent.
  const updated = foldTokensPerPctObservation(undefined, "session", 0.5, 0.45, 5000);
  expect(Math.abs(updated.session - 1000) < 1, `expected ~1000, got ${updated.session}`).toBeTruthy();
});

test("foldTokensPerPctObservation blends into the prior EWMA and learns per label", () => {
  const prior = { session: 1000, weekly: 40 };
  // New session sample: 3000 tokens over 0.10 → 0.05 (5 percent) → 600/pct sample.
  const updated = foldTokensPerPctObservation(prior, "session", 0.1, 0.05, 3000);
  // EWMA(alpha 0.3): 1000*0.7 + 600*0.3 = 880. weekly untouched.
  expect(Math.abs(updated.session - 880) < 1, `expected ~880, got ${updated.session}`).toBeTruthy();
  expect(updated.weekly).toBe(40);
});

test("foldTokensPerPctObservation ignores a below-threshold or non-positive delta (degrade-safe)", () => {
  const prior = { session: 1000 };
  // Δpercent = 0.3 (< 0.5 floor) → unchanged.
  expect(foldTokensPerPctObservation(prior, "session", 0.5, 0.497, 5000)).toEqual(prior);
  // Non-positive tokens → unchanged.
  expect(foldTokensPerPctObservation(prior, "session", 0.5, 0.4, 0)).toEqual(prior);
  // Percent went UP (no consumption) → unchanged.
  expect(foldTokensPerPctObservation(prior, "session", 0.4, 0.5, 5000)).toEqual(prior);
});

test("recordTokensPerPctObservation persists a per-window slope to quota-state", async () => {
  await withTempStateDir(async () => {
    await recordTokensPerPctObservation("prov/model", "weekly", 0.2, 0.1, 2000);
    const state = await readQuotaState();
    const entry = state.entries["prov/model"];
    expect(entry, "entry created").toBeTruthy();
    // 2000 tokens / (0.2-0.1)*100 = 10 percent → 200 tokens/pct.
    expect(Math.abs(entry.tokens_per_pct.weekly - 200) < 1e-9).toBeTruthy();
  });
});

// ── INV-QD-15: an unusable quota-state file must never masquerade as cold start ──
//
// `refreshQuotaStateIfNeeded` reads quota-state.json WITHOUT the writer's lock.
// The old `writeQuotaState` truncated in place, so a co-located peer could read a
// prefix; `readQuotaState` swallowed the JSON.parse throw and returned an EMPTY
// state — no cooldown_until, no learned limits — i.e. the degrade direction was
// FAIL-OPEN (unbounded dispatch). Two properties close it: writes are atomic
// (rename-over-destination, so no torn read exists), and an unusable file throws
// rather than silently becoming `{}`.

const __testDir = dirname(fileURLToPath(import.meta.url));
const STATE_SRC = resolve(__testDir, "../../src/shared/quota/state.ts");

test("INV-QD-15: writeQuotaState delegates to the shared atomic writer, never a truncating writeFile", async () => {
  const source = await readFile(STATE_SRC, "utf8");
  expect(source).toContain("writeJsonFile");
  // A bare `writeFile(` here reintroduces the in-place truncation the lock-free
  // reader is exposed to. `readFile` is fine — only the write path must be atomic.
  expect(/\bwriteFile\s*\(/.test(source)).toBe(false);
});

test("INV-QD-15: an ABSENT state file is cold start, not an error", async () => {
  await withTempStateDir(async () => {
    expect(await readQuotaState()).toEqual(emptyQuotaState());
  });
});

test("INV-QD-15: a torn/invalid-JSON state file throws instead of degrading to empty", async () => {
  await withTempStateDir(async () => {
    // A truncated prefix — exactly what a torn read of a large state file yields.
    await writeFile(getQuotaStatePath(), '{"version":2,"entries":{"a/b":{"buck', "utf8");
    await expect(readQuotaState()).rejects.toThrow(QuotaStateUnavailableError);
  });
});

test("INV-QD-15: a well-formed-JSON but wrong-shape state file throws", async () => {
  await withTempStateDir(async () => {
    await writeFile(getQuotaStatePath(), '{"version":99,"entries":{}}', "utf8");
    await expect(readQuotaState()).rejects.toThrow(QuotaStateUnavailableError);
  });
});

test("INV-QD-15: readQuotaStateOrDegrade is the ONE opt-in degrade, and it is loud", async () => {
  await withTempStateDir(async () => {
    await writeFile(getQuotaStatePath(), "not json at all", "utf8");
    const written = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    try {
      expect(await readQuotaStateOrDegrade("unit test")).toEqual(emptyQuotaState());
    } finally {
      process.stderr.write = original;
    }
    expect(written.join("")).toContain("unit test");
  });
});

test("INV-QD-15: a lock-free reader never observes a torn file while writes are in flight", async () => {
  await withTempStateDir(async () => {
    // A payload big enough that a non-atomic write would be observably partial.
    const entries = {};
    for (let i = 0; i < 400; i++) {
      entries[`provider-${i}/model-${i}`] = {
        updated_at: new Date().toISOString(),
        buckets: { 1: { success_weight: i, failure_weight: 0 } },
        cooldown_until: null,
        last_429_at: null,
      };
    }
    await writeQuotaState({ version: 2, entries });

    let stop = false;
    const reader = (async () => {
      // Reads take NO lock — atomicity of the write is the only thing protecting them.
      while (!stop) {
        const state = await readQuotaState();
        expect(Object.keys(state.entries).length).toBe(400);
      }
    })();
    for (let round = 0; round < 25; round++) {
      await writeQuotaState({ version: 2, entries });
    }
    stop = true;
    await reader;
  });
});

test("INV-QD-15: a lock-held RMW quarantines a CORRUPT file, preserves the bytes, and heals", async () => {
  await withTempStateDir(async (dir) => {
    const corrupt = '{"version":2,"entries":{"a/b":{"buck';
    await writeFile(getQuotaStatePath(), corrupt, "utf8");

    const stderrSpy = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => (stderrSpy.push(String(chunk)), true);
    try {
      // Without a repair path a corrupt file is TERMINAL: cooldown persistence and
      // limit learning stay dead for the life of that file.
      await recordWaveOutcome(KEY, { concurrency: 2, estimated_tokens: 0, outcome: "success" }, 24);
    } finally {
      process.stderr.write = original;
    }

    // Healed: the live file is valid again and carries the new outcome.
    const healed = await readQuotaState();
    expect(healed.entries[KEY].buckets["1"].success_weight).toBe(1.0);

    // Evidence preserved, never deleted.
    const quarantined = (await readdir(dir)).filter((f) => f.includes(".corrupt-"));
    expect(quarantined.length).toBe(1);
    expect(await readFile(join(dir, quarantined[0]), "utf8")).toBe(corrupt);

    // And it said so.
    expect(stderrSpy.join("")).toContain("quarantined");
  });
});

test("INV-QD-15: a transient-UNREADABLE file is never quarantined and never silently emptied", async () => {
  await withTempStateDir(async (dir) => {
    // A directory where the state file should be → EISDIR/EPERM on read, not ENOENT.
    // The bytes of a real state file in this situation may be perfectly good, so the
    // RMW must reject rather than destroy them.
    await mkdir(getQuotaStatePath());

    await expect(
      recordWaveOutcome(KEY, { concurrency: 1, estimated_tokens: 0, outcome: "success" }, 24),
    ).rejects.toThrow(QuotaStateUnavailableError);

    // Nothing was quarantined; the path is untouched.
    expect((await readdir(dir)).filter((f) => f.includes(".corrupt-")).length).toBe(0);
    expect((await stat(getQuotaStatePath())).isDirectory()).toBe(true);
  });
});
