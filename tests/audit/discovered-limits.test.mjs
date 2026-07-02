import { test, expect } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mergeDiscoveredLimits } = await import("../../src/audit/quota/discoveredLimits.ts");

// ── mergeDiscoveredLimits ───────────────────────────────────────────────────

test("mergeDiscoveredLimits returns null for no sources", () => {
  expect(mergeDiscoveredLimits()).toBe(null);
  expect(mergeDiscoveredLimits(null, undefined)).toBe(null);
});

test("mergeDiscoveredLimits returns single source unchanged", () => {
  const source = { requests_per_minute: 50, source: "provider_query" };
  const result = mergeDiscoveredLimits(source);
  expect(result).toEqual({ ...source });
});

test("mergeDiscoveredLimits prefers earlier sources", () => {
  const provider = { requests_per_minute: 50, source: "provider_query" };
  const cached = {
    requests_per_minute: 30,
    input_tokens_per_minute: 100000,
    source: "header_extraction",
  };

  const result = mergeDiscoveredLimits(provider, cached);
  expect(result.requests_per_minute).toBe(50);
  expect(result.input_tokens_per_minute).toBe(100000);
});

test("mergeDiscoveredLimits fills nulls from later sources", () => {
  const provider = { requests_per_minute: null, source: "provider_query" };
  const cached = {
    requests_per_minute: 30,
    input_tokens_per_minute: 100000,
    source: "header_extraction",
  };

  const result = mergeDiscoveredLimits(provider, cached);
  expect(result.requests_per_minute).toBe(30);
  expect(result.input_tokens_per_minute).toBe(100000);
});

test("mergeDiscoveredLimits skips null sources in the chain", () => {
  const provider = null;
  const cached = {
    requests_per_minute: 30,
    source: "header_extraction",
  };

  const result = mergeDiscoveredLimits(provider, cached);
  expect(result.requests_per_minute).toBe(30);
});

// ── scheduleWave with discoveredLimits ──────────────────────────────────────

const { scheduleWave } = await import("audit-tools/shared/quota/scheduler");

test("scheduleWave caps by discovered RPM", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 30,
    discoveredLimits: { requests_per_minute: 10, source: "header_extraction" },
  });
  // 10 * 0.8 safety margin = 8
  expect(schedule.max_concurrent).toBe(8);
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
  expect(schedule.max_concurrent).toBe(4);
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
  expect(schedule.max_concurrent).toBe(4);
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
  expect(schedule.max_concurrent).toBe(22);
});

test("scheduleWave leaves an unconfigured provider uncapped (no cold-start floor)", () => {
  const schedule = scheduleWave({
    providerName: "opencode",
    sessionConfig: {},
    hostModel: null,
    requestedConcurrency: 22,
    quotaStateEntry: null,
  });
  expect(schedule.max_concurrent).toBe(22);
  expect(schedule.binding_cap).toBe("none");
});

// ── File-backed I/O functions ────────────────────────────────────────────────

const { setQuotaStateDir } = await import("audit-tools/shared");
const {
  readDiscoveredLimitsCache,
  writeDiscoveredLimitsCache,
  updateDiscoveredLimits,
  lookupDiscoveredLimits,
} = await import("../../src/audit/quota/discoveredLimits.ts");

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
    expect(result.version).toBe(1);
    expect(Object.keys(result.entries).length).toBe(0);
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
    expect(result.entries["provider:model"], "entry should exist").toBeTruthy();
    expect(result.entries["provider:model"].requests_per_minute).toBe(60);
    expect(result.entries["provider:model"].source).toBe("header_extraction");
  });
});

test("readDiscoveredLimitsCache returns empty cache and does not throw for malformed file", async () => {
  await withTempQuotaDir(async (dir) => {
    await writeFile(join(dir, "discovered-limits.json"), "not valid json", "utf8");
    const result = await readDiscoveredLimitsCache();
    expect(result.version).toBe(1);
    expect(Object.keys(result.entries).length).toBe(0);
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
    expect(result.version).toBe(1);
    expect(Object.keys(result.entries).length).toBe(0);
    // Diagnostic must include the cache file path
    const combined = chunks.join("");
    expect(combined.includes("discovered-limits.json"), `expected cache path in stderr diagnostic, got: ${combined}`).toBeTruthy();
    // Diagnostic must also include the error message text
    expect(combined.includes("[quota] ignoring unreadable discovered-limits cache"), `expected diagnostic prefix in stderr, got: ${combined}`).toBeTruthy();
  });
});

test("readDiscoveredLimitsCache returns empty cache for file with wrong version", async () => {
  await withTempQuotaDir(async (dir) => {
    const wrongVersion = { version: 2, entries: { "x:y": { source: "s" } } };
    await writeFile(join(dir, "discovered-limits.json"), JSON.stringify(wrongVersion) + "\n", "utf8");
    const result = await readDiscoveredLimitsCache();
    expect(result.version).toBe(1);
    expect(Object.keys(result.entries).length).toBe(0);
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
    expect(roundTripped.version).toBe(1);
    expect(roundTripped.entries["provider:model"].requests_per_minute).toBe(30);
    const raw = await readFile(join(dir, "discovered-limits.json"), "utf8");
    expect(raw.endsWith("\n"), "file content should end with newline").toBeTruthy();
  });
});

test("updateDiscoveredLimits writes a new entry when none exists", async () => {
  await withTempQuotaDir(async () => {
    await updateDiscoveredLimits("new:model", {
      requests_per_minute: 50,
      source: "header_extraction",
    });
    const result = await lookupDiscoveredLimits("new:model");
    expect(result !== null, "lookup should return non-null").toBeTruthy();
    expect(result.requests_per_minute).toBe(50);
    expect(result.source).toBe("header_extraction");
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
    expect(result !== null).toBeTruthy();
    expect(result.requests_per_minute, "requests_per_minute from prior entry should be preserved").toBe(40);
    expect(result.input_tokens_per_minute, "input_tokens_per_minute should be updated").toBe(100000);
    expect(result.source, "source should be updated to new value").toBe("provider_query");
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
    expect(result !== null).toBeTruthy();
    expect(result.requests_per_minute, "existing requests_per_minute should be preserved when incoming is null").toBe(60);
    expect(result.input_tokens_per_minute, "existing input_tokens_per_minute should be preserved when incoming is null").toBe(50000);
  });
});

test("lookupDiscoveredLimits returns null for unknown providerModelKey", async () => {
  await withTempQuotaDir(async () => {
    const result = await lookupDiscoveredLimits("no:such:key");
    expect(result).toBe(null);
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
    expect(result).toBe(null);
  });
});

test("lookupDiscoveredLimits returns DiscoveredRateLimits when at least one field is set", async () => {
  await withTempQuotaDir(async () => {
    await updateDiscoveredLimits("prov:m", {
      requests_per_minute: 60,
      source: "header_extraction",
    });
    const result = await lookupDiscoveredLimits("prov:m");
    expect(result !== null).toBeTruthy();
    expect(result.requests_per_minute).toBe(60);
    expect(result.input_tokens_per_minute).toBe(null);
    expect(result.output_tokens_per_minute).toBe(null);
    expect(result.source).toBe("header_extraction");
  });
});

// ── getCachePath path-derivation invariants ──────────────────────────────────

const { getQuotaStatePath } = await import("audit-tools/shared");
const { dirname } = await import("node:path");

test("getCachePath returns a path distinct from getQuotaStatePath", async () => {
  await withTempQuotaDir(async (dir) => {
    // writeDiscoveredLimitsCache exercises getCachePath internally.
    // The written file must be discovered-limits.json, not quota-state.json.
    const cache = { version: /** @type {1} */ (1), entries: {} };
    await writeDiscoveredLimitsCache(cache);
    const statePath = getQuotaStatePath();
    const expectedCachePath = join(dir, "discovered-limits.json");
    expect(expectedCachePath).not.toBe(statePath);
  });
});

test("getCachePath ends with discovered-limits.json", async () => {
  await withTempQuotaDir(async (dir) => {
    const expectedCachePath = join(dir, "discovered-limits.json");
    const cache = { version: /** @type {1} */ (1), entries: {} };
    await writeDiscoveredLimitsCache(cache);
    // After a write, discovered-limits.json must exist in the temp dir.
    const raw = await readFile(expectedCachePath, "utf8");
    expect(raw.includes('"version"'), "cache file should contain JSON with version field").toBeTruthy();
  });
});

test("getCachePath shares the same dirname as getQuotaStatePath", async () => {
  await withTempQuotaDir(async (dir) => {
    const statePath = getQuotaStatePath();
    expect(dirname(statePath), "quota state dirname should equal the temp dir").toBe(dir);
    // The cache file is written inside the same dir — confirm by writing and reading.
    const cache = { version: /** @type {1} */ (1), entries: {} };
    await writeDiscoveredLimitsCache(cache);
    const cacheContents = await readFile(join(dir, "discovered-limits.json"), "utf8");
    expect(cacheContents.length > 0, "discovered-limits.json should be non-empty").toBeTruthy();
  });
});
