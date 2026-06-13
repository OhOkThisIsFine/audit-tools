/**
 * Regression tests for shared-quota module invariants.
 * INV-shared-quota-01 through INV-shared-quota-11, and CRIT-name-canonical-tier-field.
 *
 * Each test block is tagged with the invariant ID it covers.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ── INV-shared-quota-01: Global host limit partitioned across pools ──────────
// FRIC-001: computeDispatchCapacity must not multiply the global host concurrency
// limit by pool count. When all pools carry the SAME host limit (same
// active_subagents + source), the total slots across all pools must not exceed
// that shared global limit.

test("INV-shared-quota-01: shared global host limit is partitioned across pools (FRIC-001)", async () => {
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");
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
  assert.ok(
    capacity.total_slots <= 2,
    `total_slots ${capacity.total_slots} must not exceed shared host limit 2 — FRIC-001 regression`,
  );
  assert.equal(capacity.total_slots, 2, "total_slots must equal the shared global limit of 2");
  assert.equal(
    capacity.binding_cap,
    "host_concurrency",
    "binding_cap must record host_concurrency when the global limit binds",
  );
});

test("INV-shared-quota-01: shared limit 1 with 3 pools dispatches exactly 1 total slot", async () => {
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");
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
  assert.equal(capacity.total_slots, 1, "shared limit of 1 must not over-dispatch");
});

// ── INV-shared-quota-02: Pool ID as lane identity — different limits = independent ─
// When pools carry DIFFERENT hostConcurrencyLimits they represent independent
// backends and their limits are NOT shared. Total slots must sum independently.

test("INV-shared-quota-02: independent pools with different limits sum independently", async () => {
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");
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
  assert.equal(capacity.total_slots, 5, "independent pools with limits 2+3 must sum to 5");
  assert.deepEqual(
    capacity.pools.map((p) => [p.pool_id, p.slots]),
    [["cli", 2], ["ide", 3]],
  );
});

test("INV-shared-quota-02: pools with no host limits are fully independent — no global cap applied", async () => {
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");
  function pool(id) {
    return { id, providerName: "claude-code", hostModel: null, hostConcurrencyLimit: null,
             quotaStateEntry: null, discoveredLimits: null, quotaSourceSnapshot: null };
  }
  const capacity = computeDispatchCapacity({
    pools: [pool("a"), pool("b")],
    sessionConfig: {},
    pendingItemTokens: new Array(20).fill(1_000),
  });
  // No global limit: each pool fans out to DEFAULT_AGENT_HOST_CONCURRENCY independently.
  assert.ok(capacity.total_slots > 1, "pools with no host limit must fan out, not serialize");
});

test("INV-shared-quota-02: mixed pools (one with limit, one without) are independent — no global cap", async () => {
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");
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
  assert.ok(
    capacity.total_slots >= 4,
    "mixed pools (one with limit, one without) must not be artificially capped by the limited pool's value",
  );
});

// ── INV-shared-quota-03: detectLivelock returns null for empty pending set ────
// An empty pending set cannot be stranded — detectLivelock must return null,
// never a spurious PartialCompletionTerminal.

test("INV-shared-quota-03: detectLivelock returns null when pendingIds is empty", async () => {
  const { detectLivelock } = await import("../src/quota/capacity.ts");
  const result = detectLivelock({ pendingIds: [], consecutiveNoProgressWaves: 99 });
  assert.equal(result, null, "empty pending set must not produce a terminal");
});

test("INV-shared-quota-03: detectLivelock returns null before noProgressLimit is reached", async () => {
  const { detectLivelock } = await import("../src/quota/capacity.ts");
  const result = detectLivelock({ pendingIds: ["a", "b"], consecutiveNoProgressWaves: 2, noProgressLimit: 3 });
  assert.equal(result, null, "below noProgressLimit must return null");
});

test("INV-shared-quota-03: detectLivelock returns terminal at noProgressLimit", async () => {
  const { detectLivelock } = await import("../src/quota/capacity.ts");
  const result = detectLivelock({ pendingIds: ["x", "y"], consecutiveNoProgressWaves: 3, noProgressLimit: 3 });
  assert.ok(result !== null, "at noProgressLimit must return a terminal");
  assert.equal(result.reason, "livelock_guard");
  assert.deepEqual(result.stranded_ids, ["x", "y"]);
});

// ── INV-shared-quota-04: buildEmptyPoolTerminal produces correct terminal ─────

test("INV-shared-quota-04: buildEmptyPoolTerminal constructs correct terminal", async () => {
  const { buildEmptyPoolTerminal } = await import("../src/quota/capacity.ts");
  const terminal = buildEmptyPoolTerminal(["task-1", "task-2"]);
  assert.equal(terminal.reason, "empty_pool");
  assert.deepEqual(terminal.stranded_ids, ["task-1", "task-2"]);
});

test("INV-shared-quota-04: buildEmptyPoolTerminal does not mutate input array", async () => {
  const { buildEmptyPoolTerminal } = await import("../src/quota/capacity.ts");
  const ids = ["a", "b"];
  const terminal = buildEmptyPoolTerminal(ids);
  ids.push("c");
  assert.equal(terminal.stranded_ids.length, 2, "terminal must not share the input array reference");
});

// ── INV-shared-quota-05: QuotaState schema version is 1 or 2 ─────────────────
// readQuotaState must accept version 1 and 2 entries, reject others, and
// default to { version: 2, entries: {} } on missing or invalid files.

test("INV-shared-quota-05: readQuotaState defaults to version:2 empty state when file absent", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setQuotaStateDir, readQuotaState } = await import("../src/quota/state.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv05-quota-"));
  try {
    setQuotaStateDir(dir);
    const state = await readQuotaState();
    assert.equal(state.version, 2, "default state must have version 2");
    assert.deepEqual(state.entries, {}, "default state entries must be empty");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INV-shared-quota-05: writeQuotaState always normalizes to version 2", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setQuotaStateDir, writeQuotaState, readQuotaState } = await import("../src/quota/state.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv05-write-"));
  try {
    setQuotaStateDir(dir);
    // Write a version:1 state.
    await writeQuotaState({ version: 1, entries: {} });
    const state = await readQuotaState();
    assert.equal(state.version, 2, "writeQuotaState must normalize version to 2");
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
  const { acquireLock, releaseLock } = await import("../src/quota/fileLock.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv06-lock-"));
  const lockPath = join(dir, "test.lock");
  try {
    const token1 = await acquireLock(lockPath);
    const content = await readFile(lockPath, "utf8");
    assert.equal(content, token1, "lock file must contain the owner token");
    await releaseLock(lockPath, token1);

    const token2 = await acquireLock(lockPath);
    assert.notEqual(token1, token2, "each acquisition must produce a unique token");
    await releaseLock(lockPath, token2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("INV-shared-quota-06: releaseLock does not delete when token does not match (prevents clobber)", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { acquireLock, releaseLock } = await import("../src/quota/fileLock.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv06-clobber-"));
  const lockPath = join(dir, "test.lock");
  try {
    const token = await acquireLock(lockPath);
    // Try to release with a wrong token — must NOT delete the lock.
    await releaseLock(lockPath, "wrong-token");
    const content = await readFile(lockPath, "utf8");
    assert.equal(content, token, "lock must still exist after wrong-token release attempt");
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
  const { parseHostModelRoster } = await import("../src/quota/scheduler.ts");

  // Valid tiers must parse.
  const valid = JSON.stringify([
    { rank: "small", context_tokens: 32_000, output_tokens: 4_096 },
    { rank: "standard", context_tokens: 64_000, output_tokens: 8_192 },
    { rank: "deep", context_tokens: 200_000, output_tokens: 32_000 },
  ]);
  const roster = parseHostModelRoster(valid);
  assert.equal(roster.length, 3);
  assert.deepEqual(roster.map((e) => e.rank), ["small", "standard", "deep"]);

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
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");
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
    assert.ok(
      ["small", "standard", "deep"].includes(rank),
      `PoolDispatchAllocation.rank ${rank} must be a DispatchModelTier value`,
    );
  }
});

// ── INV-shared-quota-08: computeDispatchCapacity throws on empty pool list ────

test("INV-shared-quota-08: computeDispatchCapacity throws TypeError on empty pools", async () => {
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");
  assert.throws(
    () => computeDispatchCapacity({ pools: [], sessionConfig: {}, pendingItemTokens: [1000] }),
    /at least one capacity pool/i,
    "empty pool list must throw",
  );
});

// ── INV-shared-quota-09: scheduleWave never returns max_concurrent < 1 ────────

test("INV-shared-quota-09: scheduleWave max_concurrent is always >= 1", async () => {
  const { scheduleWave } = await import("../src/quota/scheduler.ts");
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
    assert.ok(
      schedule.max_concurrent >= 1,
      `max_concurrent must be >= 1, got ${schedule.max_concurrent} with ${JSON.stringify(overrides)}`,
    );
  }
});

test("INV-shared-quota-09: scheduleWave with quota disabled still respects max_concurrent >= 1", async () => {
  const { scheduleWave } = await import("../src/quota/scheduler.ts");
  const schedule = scheduleWave({
    providerName: "claude-code",
    sessionConfig: { quota: { enabled: false } },
    hostModel: null,
    requestedConcurrency: 1,
    quotaStateEntry: null,
    hostConcurrencyLimit: { active_subagents: 1, source: "cli_flags", description: "t" },
  });
  assert.ok(schedule.max_concurrent >= 1, `max_concurrent must be >= 1`);
});

// ── INV-shared-quota-10: recordWaveOutcome persists state under lock ──────────
// Concurrent recordWaveOutcome calls must not corrupt quota-state.json.

test("INV-shared-quota-10: parallel recordWaveOutcome calls converge to a consistent final state", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { setQuotaStateDir, readQuotaState, recordWaveOutcome } = await import("../src/quota/state.ts");

  const dir = await mkdtemp(join(tmpdir(), "inv10-lock-"));
  try {
    setQuotaStateDir(dir);
    const key = "test/model";
    // Fire 5 concurrent success recordings at concurrency 3.
    await Promise.all(Array.from({ length: 5 }, () =>
      recordWaveOutcome(key, { concurrency: 3, estimated_tokens: 0, outcome: "success" }, 24),
    ));
    const state = await readQuotaState();
    const entry = state.entries[key];
    assert.ok(entry !== undefined, "entry must exist after concurrent writes");
    // Each success adds 1.0 to buckets 1..3. 5 calls → success_weight should be ~5.
    for (const n of [1, 2, 3]) {
      assert.ok(
        entry.buckets[String(n)]?.success_weight > 0,
        `bucket ${n} must have positive success_weight after concurrent writes`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── INV-shared-quota-11: CRIT-name-canonical-tier-field — DispatchModelTier only ─
// The quota/capacity module exports DispatchModelTier as the canonical tier field
// name ("small"|"standard"|"deep") and must NOT export CapabilityTier values
// ("frontier"|"capable"|"fast") through the quota-capacity contract.

test("INV-shared-quota-11: CRIT-name-canonical-tier-field — capacity module rank field uses DispatchModelTier only", async () => {
  const { computeDispatchCapacity } = await import("../src/quota/capacity.ts");
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
      assert.ok(
        !NON_CANONICAL.has(alloc.rank),
        `PoolDispatchAllocation.rank "${alloc.rank}" must not use a CapabilityTier value — CRIT-name-canonical-tier-field`,
      );
      assert.ok(
        ["small", "standard", "deep"].includes(alloc.rank),
        `PoolDispatchAllocation.rank "${alloc.rank}" must be a canonical DispatchModelTier value`,
      );
    }
  }
});

test("INV-shared-quota-11: CRIT-name-canonical-tier-field — HostModelRosterEntry.rank validates canonical values only", async () => {
  const { parseHostModelRoster } = await import("../src/quota/scheduler.ts");

  // All three canonical values must be accepted.
  for (const tier of ["small", "standard", "deep"]) {
    const json = JSON.stringify([{ rank: tier, context_tokens: 32_000, output_tokens: 4_096 }]);
    const roster = parseHostModelRoster(json);
    assert.equal(roster[0].rank, tier, `canonical tier '${tier}' must be accepted`);
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
