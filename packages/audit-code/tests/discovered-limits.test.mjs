import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mergeDiscoveredLimits } = await import("../src/quota/discoveredLimits.ts");

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

const { scheduleWave } = await import("@audit-tools/shared/quota/scheduler");

test("scheduleWave caps by discovered RPM", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 30,
    discoveredLimits: { requests_per_minute: 10, source: "header_extraction" },
  });
  // 10 * 0.8 safety margin = 8
  assert.equal(schedule.max_concurrent, 8);
});

test("scheduleWave caps by discovered TPM", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 30,
    estimatedSlotTokens: [10000, 10000, 10000, 10000, 10000],
    discoveredLimits: {
      input_tokens_per_minute: 50000,
      source: "header_extraction",
    },
  });
  // sumTopN of 5 slots (50000) > 40000 budget, sumTopN of 4 slots (40000) <= 40000 → wave = 4
  assert.equal(schedule.max_concurrent, 4);
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
  assert.equal(schedule.max_concurrent, 4);
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
  assert.equal(schedule.max_concurrent, 22);
});

test("scheduleWave first-contact cap applies with custom value", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: { quota: { first_contact_concurrency: 5 } },
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
  });
  assert.equal(schedule.max_concurrent, 5);
});

// ── File-backed I/O functions ────────────────────────────────────────────────

const { setQuotaStateDir } = await import("@audit-tools/shared");
const {
  readDiscoveredLimitsCache,
  writeDiscoveredLimitsCache,
  updateDiscoveredLimits,
  lookupDiscoveredLimits,
} = await import("../src/quota/discoveredLimits.ts");

async function withTempQuotaDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "discovered-limits-"));
  setQuotaStateDir(dir);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readDiscoveredLimitsCache returns empty cache when file is absent", async () => {
  await withTempQuotaDir(async () => {
    const result = await readDiscoveredLimitsCache();
    assert.equal(result.version, 1);
    assert.equal(Object.keys(result.entries).length, 0);
  });
});

test("readDiscoveredLimitsCache returns parsed cache for valid version-1 file", async () => {
  await withTempQuotaDir(async (dir) => {
    const cache = {
      version: 1,
      entries: {
        "provider:model": {
          requests_per_minute: 60,
          discovered_at: "2026-01-01T00:00:00.000Z",
          source: "header_extraction",
        },
      },
    };
    await writeFile(join(dir, "discovered-limits.json"), JSON.stringify(cache) + "\n", "utf8");
    const result = await readDiscoveredLimitsCache();
    assert.ok(result.entries["provider:model"], "entry should exist");
    assert.equal(result.entries["provider:model"].requests_per_minute, 60);
    assert.equal(result.entries["provider:model"].source, "header_extraction");
  });
});

test("readDiscoveredLimitsCache returns empty cache and does not throw for malformed file", async () => {
  await withTempQuotaDir(async (dir) => {
    await writeFile(join(dir, "discovered-limits.json"), "not valid json", "utf8");
    const result = await readDiscoveredLimitsCache();
    assert.equal(result.version, 1);
    assert.equal(Object.keys(result.entries).length, 0);
  });
});

// ── OBS-3a012ab3: cache-read error includes file path in diagnostic ──────────

test("readDiscoveredLimitsCache logs path when cache file is unreadable", async () => {
  await withTempQuotaDir(async (dir) => {
    await writeFile(join(dir, "discovered-limits.json"), "not valid json at all", "utf8");
    const chunks = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
    let result;
    try {
      result = await readDiscoveredLimitsCache();
    } finally {
      process.stderr.write = origWrite;
    }
    // Should still return empty cache
    assert.equal(result.version, 1);
    assert.equal(Object.keys(result.entries).length, 0);
    // Diagnostic must include the cache file path
    const combined = chunks.join("");
    assert.ok(
      combined.includes("discovered-limits.json"),
      `expected cache path in stderr diagnostic, got: ${combined}`,
    );
    // Diagnostic must also include the error message text
    assert.ok(
      combined.includes("[quota] ignoring unreadable discovered-limits cache"),
      `expected diagnostic prefix in stderr, got: ${combined}`,
    );
  });
});

test("readDiscoveredLimitsCache returns empty cache for file with wrong version", async () => {
  await withTempQuotaDir(async (dir) => {
    const wrongVersion = { version: 2, entries: { "x:y": { source: "s" } } };
    await writeFile(join(dir, "discovered-limits.json"), JSON.stringify(wrongVersion) + "\n", "utf8");
    const result = await readDiscoveredLimitsCache();
    assert.equal(result.version, 1);
    assert.equal(Object.keys(result.entries).length, 0);
  });
});

test("writeDiscoveredLimitsCache writes valid JSON that round-trips through readDiscoveredLimitsCache", async () => {
  await withTempQuotaDir(async (dir) => {
    const cache = {
      version: /** @type {1} */ (1),
      entries: {
        "provider:model": {
          requests_per_minute: 30,
          discovered_at: "2026-01-01T00:00:00.000Z",
          source: "header_extraction",
        },
      },
    };
    await writeDiscoveredLimitsCache(cache);
    const roundTripped = await readDiscoveredLimitsCache();
    assert.equal(roundTripped.version, 1);
    assert.equal(roundTripped.entries["provider:model"].requests_per_minute, 30);
    const raw = await readFile(join(dir, "discovered-limits.json"), "utf8");
    assert.ok(raw.endsWith("\n"), "file content should end with newline");
  });
});

test("updateDiscoveredLimits writes a new entry when none exists", async () => {
  await withTempQuotaDir(async () => {
    await updateDiscoveredLimits("new:model", {
      requests_per_minute: 50,
      source: "header_extraction",
    });
    const result = await lookupDiscoveredLimits("new:model");
    assert.ok(result !== null, "lookup should return non-null");
    assert.equal(result.requests_per_minute, 50);
    assert.equal(result.source, "header_extraction");
  });
});

test("updateDiscoveredLimits merges into existing entry, carrying forward untouched fields", async () => {
  await withTempQuotaDir(async () => {
    await updateDiscoveredLimits("prov:m", {
      requests_per_minute: 40,
      source: "header_extraction",
    });
    await updateDiscoveredLimits("prov:m", {
      input_tokens_per_minute: 100000,
      source: "provider_query",
    });
    const result = await lookupDiscoveredLimits("prov:m");
    assert.ok(result !== null);
    assert.equal(result.requests_per_minute, 40, "requests_per_minute from prior entry should be preserved");
    assert.equal(result.input_tokens_per_minute, 100000, "input_tokens_per_minute should be updated");
    assert.equal(result.source, "provider_query", "source should be updated to new value");
  });
});

test("updateDiscoveredLimits does not overwrite existing fields when incoming value is null", async () => {
  await withTempQuotaDir(async () => {
    await updateDiscoveredLimits("prov:m", {
      requests_per_minute: 60,
      input_tokens_per_minute: 50000,
      source: "header_extraction",
    });
    await updateDiscoveredLimits("prov:m", {
      requests_per_minute: null,
      input_tokens_per_minute: null,
      source: "provider_query",
    });
    const result = await lookupDiscoveredLimits("prov:m");
    assert.ok(result !== null);
    assert.equal(result.requests_per_minute, 60, "existing requests_per_minute should be preserved when incoming is null");
    assert.equal(result.input_tokens_per_minute, 50000, "existing input_tokens_per_minute should be preserved when incoming is null");
  });
});

test("lookupDiscoveredLimits returns null for unknown providerModelKey", async () => {
  await withTempQuotaDir(async () => {
    const result = await lookupDiscoveredLimits("no:such:key");
    assert.equal(result, null);
  });
});

test("lookupDiscoveredLimits returns null when all three limit fields are null/undefined", async () => {
  await withTempQuotaDir(async (dir) => {
    const cache = {
      version: 1,
      entries: {
        "prov:m": {
          discovered_at: "2026-01-01T00:00:00.000Z",
          source: "header_extraction",
          // no rpm / tpm / otpm fields
        },
      },
    };
    await writeFile(join(dir, "discovered-limits.json"), JSON.stringify(cache) + "\n", "utf8");
    const result = await lookupDiscoveredLimits("prov:m");
    assert.equal(result, null);
  });
});

test("lookupDiscoveredLimits returns DiscoveredRateLimits when at least one field is set", async () => {
  await withTempQuotaDir(async () => {
    await updateDiscoveredLimits("prov:m", {
      requests_per_minute: 60,
      source: "header_extraction",
    });
    const result = await lookupDiscoveredLimits("prov:m");
    assert.ok(result !== null);
    assert.equal(result.requests_per_minute, 60);
    assert.equal(result.input_tokens_per_minute, null);
    assert.equal(result.output_tokens_per_minute, null);
    assert.equal(result.source, "header_extraction");
  });
});

// ── getCachePath path-derivation invariants ──────────────────────────────────

const { getQuotaStatePath } = await import("@audit-tools/shared");
const { dirname } = await import("node:path");

test("getCachePath returns a path distinct from getQuotaStatePath", async () => {
  await withTempQuotaDir(async (dir) => {
    // writeDiscoveredLimitsCache exercises getCachePath internally.
    // The written file must be discovered-limits.json, not quota-state.json.
    const cache = { version: /** @type {1} */ (1), entries: {} };
    await writeDiscoveredLimitsCache(cache);
    const statePath = getQuotaStatePath();
    const expectedCachePath = join(dir, "discovered-limits.json");
    assert.notEqual(expectedCachePath, statePath);
  });
});

test("getCachePath ends with discovered-limits.json", async () => {
  await withTempQuotaDir(async (dir) => {
    const expectedCachePath = join(dir, "discovered-limits.json");
    const cache = { version: /** @type {1} */ (1), entries: {} };
    await writeDiscoveredLimitsCache(cache);
    // After a write, discovered-limits.json must exist in the temp dir.
    const raw = await readFile(expectedCachePath, "utf8");
    assert.ok(raw.includes('"version"'), "cache file should contain JSON with version field");
  });
});

test("getCachePath shares the same dirname as getQuotaStatePath", async () => {
  await withTempQuotaDir(async (dir) => {
    const statePath = getQuotaStatePath();
    assert.equal(dirname(statePath), dir, "quota state dirname should equal the temp dir");
    // The cache file is written inside the same dir — confirm by writing and reading.
    const cache = { version: /** @type {1} */ (1), entries: {} };
    await writeDiscoveredLimitsCache(cache);
    const cacheContents = await readFile(join(dir, "discovered-limits.json"), "utf8");
    assert.ok(cacheContents.length > 0, "discovered-limits.json should be non-empty");
  });
});
