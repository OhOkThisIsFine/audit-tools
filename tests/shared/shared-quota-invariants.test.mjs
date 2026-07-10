/**
 * Regression tests for shared-quota module invariants.
 * INV-shared-quota-01 through INV-shared-quota-11, and CRIT-name-canonical-tier-field.
 *
 * Each test block is tagged with the invariant ID it covers.
 */
import { test, expect } from "vitest";
import assert from "node:assert/strict";

// ── INV-shared-quota-01: Global host limit partitioned across pools ──────────
// FRIC-001: computeDispatchCapacity must not multiply the global host concurrency
// limit by pool count. When all pools carry the SAME host limit (same
// active_subagents + source), the total slots across all pools must not exceed
// that shared global limit.

test("INV-shared-quota-01: shared global host limit is partitioned across pools (FRIC-001)", async () => {
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
  function hostLimit(n) {
    return { active_subagents: n, source: "cli_flags", description: "host" };
  }
  function pool(id, limit) {
    return { id, providerName: "claude-code", hostModel: null, hostConcurrencyLimit: limit,
             quotaStateEntry: null, discoveredLimits: null, quotaSourceSnapshot: null };
  }
  // 3 pools all sharing the same global limit of 2 — total must be ≤ 2.
  const capacity = computeDispatchCapacity({
    pools: [pool("small", hostLimit(2)), pool("standard", hostLimit(2)), pool("deep", hostLimit(2))],
    sessionConfig: {},
    pendingItemTokens: new Array(20).fill(30_000),
  });
  expect(capacity.total_slots <= 2, `total_slots ${capacity.total_slots} must not exceed shared host limit 2 — FRIC-001 regression`).toBeTruthy();
  expect(capacity.total_slots, "total_slots must equal the shared global limit of 2").toBe(2);
  expect(capacity.binding_cap, "binding_cap must record host_concurrency when the global limit binds").toBe("host_concurrency");
});

test("INV-shared-quota-01: shared limit 1 with 3 pools dispatches exactly 1 total slot", async () => {
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
  function hostLimit(n) {
    return { active_subagents: n, source: "host_reported", description: "host" };
  }
  function pool(id, limit) {
    return { id, providerName: "claude-code", hostModel: null, hostConcurrencyLimit: limit,
             quotaStateEntry: null, discoveredLimits: null, quotaSourceSnapshot: null };
  }
  const capacity = computeDispatchCapacity({
    pools: [pool("a", hostLimit(1)), pool("b", hostLimit(1)), pool("c", hostLimit(1))],
    sessionConfig: {},
    pendingItemTokens: new Array(10).fill(5_000),
  });
  expect(capacity.total_slots, "shared limit of 1 must not over-dispatch").toBe(1);
});

// ── INV-shared-quota-02: Pool ID as lane identity — different limits = independent ─
// When pools carry DIFFERENT hostConcurrencyLimits they represent independent
// backends and their limits are NOT shared. Total slots must sum independently.

test("INV-shared-quota-02: independent pools with different limits sum independently", async () => {
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
  function pool(id, n) {
    return { id, providerName: "claude-code", hostModel: null,
             hostConcurrencyLimit: { active_subagents: n, source: "cli_flags", description: "t" },
             quotaStateEntry: null, discoveredLimits: null, quotaSourceSnapshot: null };
  }
  const capacity = computeDispatchCapacity({
    pools: [pool("cli", 2), pool("ide", 3)],
    sessionConfig: {},
    pendingItemTokens: [900, 800, 700, 600, 500, 400],
  });
  // cli gets 2 slots, ide gets 3 — independent, so total is 5.
  expect(capacity.total_slots, "independent pools with limits 2+3 must sum to 5").toBe(5);
  expect(capacity.pools.map((p) => [p.pool_id, p.slots])).toEqual([["cli", 2], ["ide", 3]]);
});

test("INV-shared-quota-02: pools with no host limits are fully independent — no global cap applied", async () => {
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
  function pool(id) {
    return { id, providerName: "claude-code", hostModel: null, hostConcurrencyLimit: null,
             quotaStateEntry: null, discoveredLimits: null, quotaSourceSnapshot: null };
  }
  const capacity = computeDispatchCapacity({
    pools: [pool("a"), pool("b")],
    sessionConfig: {},
    pendingItemTokens: new Array(20).fill(1_000),
  });
  // No global limit and no invented floor: each pool fans out independently.
  expect(capacity.total_slots > 1, "pools with no host limit must fan out, not serialize").toBeTruthy();
});

test("INV-shared-quota-02: mixed pools (one with limit, one without) are independent — no global cap", async () => {
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
  const poolWithLimit = {
    id: "limited", providerName: "claude-code", hostModel: null,
    hostConcurrencyLimit: { active_subagents: 4, source: "cli_flags", description: "t" },
    quotaStateEntry: null, discoveredLimits: null, quotaSourceSnapshot: null,
  };
  const poolWithout = {
    id: "unlimited", providerName: "claude-code", hostModel: null, hostConcurrencyLimit: null,
    quotaStateEntry: null, discoveredLimits: null, quotaSourceSnapshot: null,
  };
  const capacity = computeDispatchCapacity({
    pools: [poolWithLimit, poolWithout],
    sessionConfig: {},
    pendingItemTokens: new Array(20).fill(1_000),
  });
  // Mixed: no global cap — each pool uses its own per-slot limit.
  expect(capacity.total_slots >= 4, "mixed pools (one with limit, one without) must not be artificially capped by the limited pool's value").toBeTruthy();
});

// ── INV-shared-quota-03: detectLivelock returns null for empty pending set ────
// An empty pending set cannot be stranded — detectLivelock must return null,
// never a spurious PartialCompletionTerminal.

test("INV-shared-quota-03: detectLivelock returns null when pendingIds is empty", async () => {
  const { detectLivelock } = await import("../../src/shared/quota/capacity.ts");
  const result = detectLivelock({ pendingIds: [], consecutiveNoProgressWaves: 99 });
  expect(result, "empty pending set must not produce a terminal").toBe(null);
});

test("INV-shared-quota-03: detectLivelock returns null before noProgressLimit is reached", async () => {
  const { detectLivelock } = await import("../../src/shared/quota/capacity.ts");
  const result = detectLivelock({ pendingIds: ["a", "b"], consecutiveNoProgressWaves: 2, noProgressLimit: 3 });
  expect(result, "below noProgressLimit must return null").toBe(null);
});

test("INV-shared-quota-03: detectLivelock returns terminal at noProgressLimit", async () => {
  const { detectLivelock } = await import("../../src/shared/quota/capacity.ts");
  const result = detectLivelock({ pendingIds: ["x", "y"], consecutiveNoProgressWaves: 3, noProgressLimit: 3 });
  expect(result !== null, "at noProgressLimit must return a terminal").toBeTruthy();
  expect(result.reason).toBe("livelock_guard");
  expect(result.stranded_ids).toEqual(["x", "y"]);
});

// ── INV-shared-quota-04: buildEmptyPoolTerminal produces correct terminal ─────

test("INV-shared-quota-04: buildEmptyPoolTerminal constructs correct terminal", async () => {
  const { buildEmptyPoolTerminal } = await import("../../src/shared/quota/capacity.ts");
  const terminal = buildEmptyPoolTerminal(["task-1", "task-2"]);
  expect(terminal.reason).toBe("empty_pool");
  expect(terminal.stranded_ids).toEqual(["task-1", "task-2"]);
});

test("INV-shared-quota-04: buildEmptyPoolTerminal does not mutate input array", async () => {
  const { buildEmptyPoolTerminal } = await import("../../src/shared/quota/capacity.ts");
  const ids = ["a", "b"];
  const terminal = buildEmptyPoolTerminal(ids);
  ids.push("c");
  expect(terminal.stranded_ids.length, "terminal must not share the input array reference").toBe(2);
});

// ── INV-shared-quota-05: QuotaState schema version is 1 or 2 ─────────────────
// readQuotaState must accept version 1 and 2 entries and default to
// { version: 2, entries: {} } on a MISSING file. An INVALID file is NOT a cold
// start — it throws QuotaStateUnavailableError (INV-QD-15, quota-state.test.mjs).

test("INV-shared-quota-05: readQuotaState defaults to version:2 empty state when file absent", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setQuotaStateDir, readQuotaState } = await import("../../src/shared/quota/state.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv05-quota-"));
  try {
    setQuotaStateDir(dir);
    const state = await readQuotaState();
    expect(state.version, "default state must have version 2").toBe(2);
    expect(state.entries, "default state entries must be empty").toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INV-shared-quota-05: writeQuotaState always normalizes to version 2", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setQuotaStateDir, writeQuotaState, readQuotaState } = await import("../../src/shared/quota/state.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv05-write-"));
  try {
    setQuotaStateDir(dir);
    // Write a version:1 state.
    await writeQuotaState({ version: 1, entries: {} });
    const state = await readQuotaState();
    expect(state.version, "writeQuotaState must normalize version to 2").toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── INV-shared-quota-06: File lock token-check prevents stale-lock clobber ───
// acquireLock must write a unique owner token; releaseLock must only delete
// the lock when the token matches (preventing concurrent clobber).

test("INV-shared-quota-06: acquireLock writes a unique token each time", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireLock, releaseLock } = await import("../../src/shared/quota/fileLock.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv06-lock-"));
  const lockPath = join(dir, "test.lock");
  try {
    const token1 = await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf8");
    expect(content, "lock file must contain the owner token").toBe(token1);
    await releaseLock(lockPath, token1);

    const token2 = await acquireLock(lockPath);
    expect(token1, "each acquisition must produce a unique token").not.toBe(token2);
    await releaseLock(lockPath, token2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INV-shared-quota-06: releaseLock does not delete when token does not match (prevents clobber)", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireLock, releaseLock } = await import("../../src/shared/quota/fileLock.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv06-clobber-"));
  const lockPath = join(dir, "test.lock");
  try {
    const token = await acquireLock(lockPath);
    // Try to release with a wrong token — must NOT delete the lock.
    await releaseLock(lockPath, "wrong-token");
    const content = await readFile(lockPath, "utf8");
    expect(content, "lock must still exist after wrong-token release attempt").toBe(token);
    // Clean up properly.
    await releaseLock(lockPath, token);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── INV-shared-quota-07: DispatchModelTier is canonical (small/standard/deep) ─
// The quota/capacity/scheduler modules use DispatchModelTier exclusively for
// tier-rank fields. No alias types or extra values must be introduced.

test("INV-shared-quota-07: DispatchModelTier canonical values are small, standard, deep", async () => {
  // The type is enforced at compile time, but we verify at runtime by checking
  // that parseHostModelRoster rejects unknown tier values.
  const { parseHostModelRoster } = await import("../../src/shared/quota/scheduler.ts");

  // Valid tiers must parse.
  const valid = JSON.stringify([
    { rank: "small", context_tokens: 32_000, output_tokens: 4_096 },
    { rank: "standard", context_tokens: 64_000, output_tokens: 8_192 },
    { rank: "deep", context_tokens: 200_000, output_tokens: 32_000 },
  ]);
  const roster = parseHostModelRoster(valid);
  expect(roster.length).toBe(3);
  expect(roster.map((e) => e.rank)).toEqual(["small", "standard", "deep"]);

  // Unknown tier must throw.
  const invalid = JSON.stringify([{ rank: "ultra", context_tokens: 1000, output_tokens: 100 }]);
  assert.throws(() => parseHostModelRoster(invalid), /rank must be one of/i,
    "unknown tier value must be rejected");

  // Old CapabilityTier values (frontier/capable/fast) must be rejected.
  for (const badTier of ["frontier", "capable", "fast", "unknown"]) {
    const badJson = JSON.stringify([{ rank: badTier, context_tokens: 1000, output_tokens: 100 }]);
    assert.throws(() => parseHostModelRoster(badJson), /rank must be one of/i,
      `CapabilityTier value '${badTier}' must not be accepted as a DispatchModelTier`);
  }
});

test("INV-shared-quota-07: CapacityPool.rank is typed as DispatchModelTier (small/standard/deep)", async () => {
  // Verify that CapacityPool.rank carries a valid DispatchModelTier through capacity computation.
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
  function pool(id, rank) {
    return { id, providerName: "claude-code", hostModel: null, rank,
             hostConcurrencyLimit: null, quotaStateEntry: null, discoveredLimits: null,
             quotaSourceSnapshot: null };
  }
  const capacity = computeDispatchCapacity({
    pools: [pool("a", "small"), pool("b", "standard"), pool("c", "deep")],
    sessionConfig: {},
    pendingItemTokens: new Array(10).fill(1_000),
  });
  // rank fields must survive through allocations.
  const ranks = capacity.pools.filter((p) => p.rank != null).map((p) => p.rank);
  for (const rank of ranks) {
    expect(["small", "standard", "deep"].includes(rank), `PoolDispatchAllocation.rank ${rank} must be a DispatchModelTier value`).toBeTruthy();
  }
});

// ── INV-shared-quota-08: computeDispatchCapacity throws on empty pool list ────

test("INV-shared-quota-08: computeDispatchCapacity throws TypeError on empty pools", async () => {
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
  assert.throws(
    () => computeDispatchCapacity({ pools: [], sessionConfig: {}, pendingItemTokens: [1000] }),
    /at least one capacity pool/i,
    "empty pool list must throw",
  );
});

// ── INV-shared-quota-09: scheduleWave never returns max_concurrent < 1 ────────

test("INV-shared-quota-09: scheduleWave max_concurrent is always >= 1", async () => {
  const { scheduleWave } = await import("../../src/shared/quota/scheduler.ts");
  // Extreme throttle scenarios that might produce zero without the Math.max(1) guard.
  const extremeCases = [
    { requestedConcurrency: 0 },
    { requestedConcurrency: -5 },
    { requestedConcurrency: 1, hostConcurrencyLimit: { active_subagents: 0, source: "cli_flags", description: "t" } },
  ];
  for (const overrides of extremeCases) {
    const schedule = scheduleWave({
      providerName: "claude-code",
      sessionConfig: {},
      hostModel: null,
      requestedConcurrency: 1,
      quotaStateEntry: null,
      hostConcurrencyLimit: null,
      ...overrides,
    });
    expect(schedule.max_concurrent >= 1, `max_concurrent must be >= 1, got ${schedule.max_concurrent} with ${JSON.stringify(overrides)}`).toBeTruthy();
  }
});

test("INV-shared-quota-09: scheduleWave with quota disabled still respects max_concurrent >= 1", async () => {
  const { scheduleWave } = await import("../../src/shared/quota/scheduler.ts");
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: {} },
    hostModel: null,
    requestedConcurrency: 1,
    quotaStateEntry: null,
    hostConcurrencyLimit: { active_subagents: 1, source: "cli_flags", description: "t" },
  });
  expect(schedule.max_concurrent >= 1, `max_concurrent must be >= 1`).toBeTruthy();
});

// ── INV-shared-quota-10: recordWaveOutcome persists state under lock ──────────
// Concurrent recordWaveOutcome calls must not corrupt quota-state.json.

test("INV-shared-quota-10: parallel recordWaveOutcome calls converge to a consistent final state", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setQuotaStateDir, readQuotaState, recordWaveOutcome } = await import("../../src/shared/quota/state.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv10-lock-"));
  try {
    setQuotaStateDir(dir);
    const key = "test/model";
    // Fire 5 concurrent 429 recordings. Each is a read-modify-write of the same
    // entry; if any pair interleaved, an increment would be lost.
    await Promise.all(Array.from({ length: 5 }, () =>
      recordWaveOutcome(key, { outcome: "rate_limited" }),
    ));
    const state = await readQuotaState();
    const entry = state.entries[key];
    expect(entry !== undefined, "entry must exist after concurrent writes").toBeTruthy();
    // Serialized by the file lock: every increment lands, none is lost.
    expect(entry.consecutive_429_count, "all 5 concurrent 429 increments must land").toBe(5);
    expect(entry.cooldown_until, "a 429 must leave a cooldown").not.toBe(null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── INV-shared-quota-11: CRIT-name-canonical-tier-field — DispatchModelTier only ─
// The quota/capacity module exports DispatchModelTier as the canonical tier field
// name ("small"|"standard"|"deep") and must NOT export CapabilityTier values
// ("frontier"|"capable"|"fast") through the quota-capacity contract.

test("INV-shared-quota-11: CRIT-name-canonical-tier-field — capacity module rank field uses DispatchModelTier only", async () => {
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");
  const NON_CANONICAL = new Set(["frontier", "capable", "fast", "unknown"]);

  function pool(id, rank) {
    return { id, providerName: "claude-code", hostModel: null, rank,
             hostConcurrencyLimit: null, quotaStateEntry: null, discoveredLimits: null,
             quotaSourceSnapshot: null };
  }

  const capacity = computeDispatchCapacity({
    pools: [pool("small-pool", "small"), pool("deep-pool", "deep")],
    sessionConfig: {},
    pendingItemTokens: new Array(6).fill(1_000),
  });

  for (const alloc of capacity.pools) {
    if (alloc.rank != null) {
      expect(!NON_CANONICAL.has(alloc.rank), `PoolDispatchAllocation.rank "${alloc.rank}" must not use a CapabilityTier value — CRIT-name-canonical-tier-field`).toBeTruthy();
      expect(["small", "standard", "deep"].includes(alloc.rank), `PoolDispatchAllocation.rank "${alloc.rank}" must be a canonical DispatchModelTier value`).toBeTruthy();
    }
  }
});

test("INV-shared-quota-11: CRIT-name-canonical-tier-field — HostModelRosterEntry.rank validates canonical values only", async () => {
  const { parseHostModelRoster } = await import("../../src/shared/quota/scheduler.ts");

  // All three canonical values must be accepted.
  for (const tier of ["small", "standard", "deep"]) {
    const json = JSON.stringify([{ rank: tier, context_tokens: 32_000, output_tokens: 4_096 }]);
    const roster = parseHostModelRoster(json);
    expect(roster[0].rank, `canonical tier '${tier}' must be accepted`).toBe(tier);
  }

  // CapabilityTier values must all be rejected.
  for (const nonCanonical of ["frontier", "capable", "fast", "unknown"]) {
    const json = JSON.stringify([{ rank: nonCanonical, context_tokens: 32_000, output_tokens: 4_096 }]);
    assert.throws(
      () => parseHostModelRoster(json),
      /rank must be one of/i,
      `non-canonical CapabilityTier value '${nonCanonical}' must be rejected by parseHostModelRoster`,
    );
  }
});

// ── INV-shared-quota-12: INV-QD-12 — parseHostModelRoster opaque model_id round-trip ─
// Valid input returns entries with the opaque model_id preserved VERBATIM and used
// only as a quota-key segment; malformed model_id is rejected.

test("INV-shared-quota-12: parseHostModelRoster preserves opaque model_id verbatim and rejects malformed", async () => {
  const { parseHostModelRoster } = await import("../../src/shared/quota/scheduler.ts");

  // Opaque id is preserved exactly (never parsed/normalized/compared to a table).
  const withId = JSON.stringify([
    { rank: "deep", context_tokens: 200_000, output_tokens: 64_000, model_id: "vendor::opaque/Build-2026.06" },
  ]);
  const roster = parseHostModelRoster(withId);
  expect(roster[0].model_id, "model_id must be preserved verbatim").toBe("vendor::opaque/Build-2026.06");

  // Absent model_id is allowed (optional).
  const noId = JSON.stringify([{ rank: "small", context_tokens: 32_000, output_tokens: 4_096 }]);
  expect(parseHostModelRoster(noId)[0].model_id, "model_id is optional").toBe(undefined);

  // Empty/whitespace model_id is rejected.
  for (const bad of ["", "   "]) {
    const json = JSON.stringify([{ rank: "small", context_tokens: 32_000, output_tokens: 4_096, model_id: bad }]);
    assert.throws(
      () => parseHostModelRoster(json),
      /model_id must be a non-empty string/i,
      `model_id '${JSON.stringify(bad)}' must be rejected`,
    );
  }

  // Malformed JSON and empty array are rejected.
  assert.throws(() => parseHostModelRoster("{not json"), /must be valid JSON/i);
  assert.throws(() => parseHostModelRoster("[]"), /non-empty JSON array/i);
  // Missing required numeric fields are rejected.
  assert.throws(
    () => parseHostModelRoster(JSON.stringify([{ rank: "small", output_tokens: 10 }])),
    /context_tokens must be a positive integer/i,
  );
  assert.throws(
    () => parseHostModelRoster(JSON.stringify([{ rank: "small", context_tokens: 10 }])),
    /output_tokens must be a positive integer/i,
  );
});

// ── INV-shared-quota-13: INV-QD-04 — no hardcoded model identity in quota/dispatch ──
// The no-hardcoded-models hard rule: scan the quota/ and dispatch/ source for model-
// name literals or tier→model maps. Capabilities must be discovered from the host
// roster / discoveredLimits; model_id is an OPAQUE quota-key segment only.

test("INV-shared-quota-13: INV-QD-04 — no model-name literals in quota/ or dispatch/rollingDispatch", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = dirname(fileURLToPath(import.meta.url));
  const quotaDir = join(here, "..", "..", "src", "shared", "quota");
  const dispatchFile = join(here, "..", "..", "src", "shared", "dispatch", "rollingDispatch.ts");

  // Collect quota/*.ts (incl. errorParsers/*.ts) + the rolling dispatch module.
  async function collectTs(dir) {
    const out = [];
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) out.push(...(await collectTs(full)));
      else if (ent.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }
  const files = [...(await collectTs(quotaDir)), dispatchFile];

  // Model-name / vendor-identity literals that must never appear as hardcoded
  // identities in capacity/scheduling code (case-insensitive). errorParsers may
  // legitimately match provider ERROR text by provider name (e.g. "claude-code"
  // as a ResolvedProviderName), so we target MODEL identities, not provider names.
  const FORBIDDEN = [
    /\bclaude-3\b/i,
    /\bclaude-[0-9]/i,
    /\bgpt-[0-9]/i,
    /\bgpt-4o\b/i,
    /\bo[0-9]-(?:mini|preview)\b/i,
    /\bsonnet\b/i,
    /\bopus\b/i,
    /\bhaiku\b/i,
    /\bgemini\b/i,
    /\bllama\b/i,
    /\bmistral\b/i,
    /\bKNOWN_MODEL_LIMITS\b/,
    /\bCAPABILITY_TIER_MAP\b/,
    /\bTIER_TO_MODEL\b/i,
    /\bMODEL_TO_TIER\b/i,
  ];

  const hits = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const pat of FORBIDDEN) {
        if (pat.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()} (matched ${pat})`);
      }
    });
  }

  expect(hits, `No hardcoded model identities / tier→model maps allowed in quota|dispatch (INV-QD-04):\n${hits.join("\n")}`).toEqual([]);
});

// ── INV-shared-quota-14: INV-QD-02 — total_slots is always >= 1 (property) ────
// Across a spread of pool/quota configs (including throttled pools that can yield
// zero per-pool slots), the aggregate floor is 1.

test("INV-shared-quota-14: INV-QD-02 — total_slots >= 1 across pool/quota configurations", async () => {
  const { computeDispatchCapacity } = await import("../../src/shared/quota/capacity.ts");

  function pool(id, overrides = {}) {
    return {
      id,
      providerName: "claude-code",
      hostModel: null,
      hostConcurrencyLimit: null,
      quotaStateEntry: null,
      discoveredLimits: null,
      quotaSourceSnapshot: null,
      ...overrides,
    };
  }

  const configs = [
    // Single pool, host limit zero (clamped to >= 1 aggregate).
    {
      pools: [pool("a", { hostConcurrencyLimit: { active_subagents: 0, source: "cli_flags", description: "t" } })],
      sessionConfig: {},
      pendingItemTokens: [1000],
    },
    // Cooldown-throttled pool via a near-exhausted quota snapshot.
    {
      pools: [pool("a", { quotaSourceSnapshot: { remaining_pct: 0.0, reset_at: null } })],
      sessionConfig: { quota: {} },
      pendingItemTokens: [5000, 5000, 5000],
    },
    // Tight RPM cap.
    {
      pools: [pool("a", { discoveredLimits: { requests_per_minute: 1 } })],
      sessionConfig: { quota: { safety_margin: 1.0 } },
      pendingItemTokens: new Array(10).fill(1000),
    },
    // Empty pending layout — still >= 1.
    { pools: [pool("a")], sessionConfig: {}, pendingItemTokens: [] },
    // Many same-host pools sharing a tiny limit.
    {
      pools: [
        pool("a", { hostConcurrencyLimit: { active_subagents: 1, source: "host_reported", description: "h" } }),
        pool("b", { hostConcurrencyLimit: { active_subagents: 1, source: "host_reported", description: "h" } }),
      ],
      sessionConfig: {},
      pendingItemTokens: new Array(8).fill(2000),
    },
  ];

  for (const cfg of configs) {
    const capacity = computeDispatchCapacity(cfg);
    expect(capacity.total_slots >= 1, `total_slots must be >= 1, got ${capacity.total_slots} for ${JSON.stringify(cfg.pendingItemTokens.length)} items`).toBeTruthy();
  }
});

