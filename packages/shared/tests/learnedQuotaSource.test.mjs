import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { LearnedQuotaSource } = await import("../src/quota/learnedQuotaSource.ts");
const { setQuotaStateDir } = await import("../src/quota/state.ts");

const KEY = "provider/model";

async function withTempStateDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "learned-quota-test-"));
  setQuotaStateDir(dir);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Write a quota-state.json containing a single entry for KEY.
 * Callers only need to specify the fields they care about.
 */
async function writeEntryState(dir, entry) {
  const state = {
    version: 2,
    entries: { [KEY]: entry },
  };
  await writeFile(join(dir, "quota-state.json"), JSON.stringify(state), "utf8");
}

test("returns null when no state entry exists for the given key", async () => {
  await withTempStateDir(async (dir) => {
    // Write a state file that has no entry for KEY.
    const state = { version: 2, entries: {} };
    await writeFile(join(dir, "quota-state.json"), JSON.stringify(state), "utf8");

    const source = new LearnedQuotaSource();
    const result = await source.queryCurrentUsage(KEY);
    assert.equal(result, null);
  });
});

test("returns remaining_pct=0 and reset_at when an active cooldown is present", async () => {
  await withTempStateDir(async (dir) => {
    const cooldownUntil = new Date(Date.now() + 60_000).toISOString();
    await writeEntryState(dir, {
      updated_at: new Date().toISOString(),
      buckets: {},
      cooldown_until: cooldownUntil,
      last_429_at: null,
      consecutive_429_count: 1,
    });

    const source = new LearnedQuotaSource();
    const snapshot = await source.queryCurrentUsage(KEY);

    assert.ok(snapshot !== null, "snapshot should not be null");
    assert.equal(snapshot.remaining_pct, 0, "remaining_pct must be 0 during active cooldown");
    assert.equal(snapshot.reset_at, cooldownUntil, "reset_at must equal cooldown_until");
    assert.equal(snapshot.source, "learned");
  });
});

test("returns remaining_pct=null and reset_at=null when cooldown has expired", async () => {
  await withTempStateDir(async (dir) => {
    const expiredCooldown = new Date(Date.now() - 60_000).toISOString();
    await writeEntryState(dir, {
      updated_at: new Date().toISOString(),
      buckets: {},
      cooldown_until: expiredCooldown,
      last_429_at: null,
      consecutive_429_count: 0,
    });

    const source = new LearnedQuotaSource();
    const snapshot = await source.queryCurrentUsage(KEY);

    assert.ok(snapshot !== null, "snapshot should not be null for an existing entry");
    assert.equal(snapshot.remaining_pct, null, "remaining_pct must be null when cooldown has expired");
    assert.equal(snapshot.reset_at, null, "reset_at must be null when cooldown has expired");
    assert.equal(snapshot.source, "learned");
  });
});

test("returns remaining_pct=null and reset_at=null when cooldown_until is null", async () => {
  await withTempStateDir(async (dir) => {
    await writeEntryState(dir, {
      updated_at: new Date().toISOString(),
      buckets: {},
      cooldown_until: null,
      last_429_at: null,
      consecutive_429_count: 0,
    });

    const source = new LearnedQuotaSource();
    const snapshot = await source.queryCurrentUsage(KEY);

    assert.ok(snapshot !== null, "snapshot should not be null for an existing entry");
    assert.equal(snapshot.remaining_pct, null, "remaining_pct must be null when cooldown_until is null");
    assert.equal(snapshot.reset_at, null, "reset_at must be null when cooldown_until is null");
  });
});
