import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

const {
  InFlightTokenTracker,
  selectProvider,
  createRollingDispatcher,
  scorePacketComplexity,
} = await import("../../src/shared/dispatch/rollingDispatch.ts");

const { setQuotaStateDir } = await import("../../src/shared/quota/state.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePacket(id, { estimatedTokens = 1000, complexity = 0.5, payload = {} } = {}) {
  return { id, payload, estimatedTokens, complexity };
}

function makePool(id, overrides = {}) {
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

// Session config with quota disabled (unlimited headroom)
function unlimitedSession() {
  return { quota: { enabled: false } };
}

// Session config with quota management active — required to exercise the
// proactive cross-pool spill ordering (INV-QD-14), which is inert when quota is
// disabled (selection then stays pure capability order).
function enabledSession() {
  return { quota: { enabled: true, safety_margin: 1.0, empirical_half_life_hours: 24 } };
}

async function setupTmpQuotaDir() {
  const dir = await mkdtemp(join(tmpdir(), "rolling-dispatch-test-"));
  setQuotaStateDir(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// InFlightTokenTracker
// ---------------------------------------------------------------------------

test("InFlightTokenTracker — records and releases tokens per pool", async (t) => {
  await t.test("recordDispatched accumulates", () => {
    const tracker = new InFlightTokenTracker();
    tracker.recordDispatched("pool-a", 1000);
    assert.equal(tracker.getInFlightTokens("pool-a"), 1000);
    tracker.recordDispatched("pool-a", 500);
    assert.equal(tracker.getInFlightTokens("pool-a"), 1500);
  });

  await t.test("recordCompleted decreases", () => {
    const tracker = new InFlightTokenTracker();
    tracker.recordDispatched("pool-a", 1500);
    tracker.recordCompleted("pool-a", 1000);
    assert.equal(tracker.getInFlightTokens("pool-a"), 500);
  });

  await t.test("unknown pool returns 0", () => {
    const tracker = new InFlightTokenTracker();
    assert.equal(tracker.getInFlightTokens("nonexistent"), 0);
  });

  await t.test("recordCompleted clamps to 0 (no negatives)", () => {
    const tracker = new InFlightTokenTracker();
    tracker.recordDispatched("pool-a", 100);
    tracker.recordCompleted("pool-a", 5000); // over-release
    assert.equal(tracker.getInFlightTokens("pool-a"), 0);
  });

  await t.test("pools are independent", () => {
    const tracker = new InFlightTokenTracker();
    tracker.recordDispatched("pool-a", 1000);
    tracker.recordDispatched("pool-b", 2000);
    assert.equal(tracker.getInFlightTokens("pool-a"), 1000);
    assert.equal(tracker.getInFlightTokens("pool-b"), 2000);
  });
});

// ---------------------------------------------------------------------------
// selectProvider
// ---------------------------------------------------------------------------

test("selectProvider — a single pool nominally at RPM=0 still yields a slot (scheduleWave floors wave_size at 1)", async () => {
  // The title used to read "returns null when all pools are at quota capacity",
  // which contradicted the assertion below: scheduleWave clamps wave_size with
  // Math.max(1, …) so a pool can never report zero headroom, and selectProvider
  // therefore returns a slot, not null. The genuine all-exhausted negative case
  // (every pool dropped after exhaustion) is covered by
  // "selectProvider — returns null when every pool is exhausted".
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const pool = makePool("pool-a", {
    providerName: "claude-code",
    hostModel: "test-model",
    discoveredLimits: { requests_per_minute: 0 },
  });
  const session = {
    quota: {
      enabled: true,
      safety_margin: 1.0,
      empirical_half_life_hours: 24,
      models: { "test-model": { requests_per_minute: 0 } },
    },
  };
  const tracker = new InFlightTokenTracker();
  const result = selectProvider(packet, [pool], tracker, {}, session);
  // rpmCap = Math.max(1, floor(0 * 1.0)) = 1, so wave_size stays >= 1 by design
  // (always dispatch at least one). A single eligible pool therefore yields a slot.
  assert.notEqual(result, null);
});

test("selectProvider — returns slot when pool has headroom", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const pool = makePool("pool-a");
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [pool], tracker, {}, unlimitedSession());
  assert.ok(slot !== null, "should return a slot for a pool with headroom");
  assert.equal(slot.poolId, "pool-a");
  assert.equal(slot.providerName, "claude-code");
});

test("selectProvider — returns null when no pools provided", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1");
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [], tracker, {}, unlimitedSession());
  assert.equal(slot, null);
});

test("selectProvider — high-complexity routes to higher-rank pool first (INV-shared-core-02: rank from pool.rank, not provider name)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 1.0 });
  // INV-shared-core-02: routing rank must come from pool.rank (DispatchModelTier),
  // not from a provider-name lookup table. Both pools use the same providerName.
  const deepPool = makePool("deep-pool", { providerName: "claude-code", rank: "deep" });
  const smallPool = makePool("small-pool", { providerName: "claude-code", rank: "small" });
  // Pass small-pool first in array; high-complexity should still prefer deep.
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [smallPool, deepPool], tracker, {}, unlimitedSession());
  assert.ok(slot !== null);
  assert.equal(slot.poolId, "deep-pool", "high-complexity packet should select pool with rank=deep");
});

test("selectProvider — low-complexity routes to lower-rank pool first (INV-shared-core-02: rank from pool.rank, not provider name)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.0 });
  // INV-shared-core-02: same providerName, different ranks — low-complexity prefers small.
  const deepPool = makePool("deep-pool", { providerName: "claude-code", rank: "deep" });
  const smallPool = makePool("small-pool", { providerName: "claude-code", rank: "small" });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [deepPool, smallPool], tracker, {}, unlimitedSession());
  assert.ok(slot !== null);
  assert.equal(slot.poolId, "small-pool", "low-complexity packet should select pool with rank=small");
});

// ---------------------------------------------------------------------------
// createRollingDispatcher — basic dispatch
// ---------------------------------------------------------------------------

test("createRollingDispatcher — dispatches all packets and returns all results", async () => {
  await setupTmpQuotaDir();
  const packets = [1, 2, 3, 4, 5].map((i) => makePacket(`p${i}`));
  const calls = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, _slot) => {
      calls.push(packet.id);
      return { packet, outcome: "success" };
    },
  });

  dispatcher.enqueue(packets);
  const results = await dispatcher.run();

  assert.equal(results.length, 5, "should return 5 results");
  assert.ok(results.every((r) => r.outcome === "success"), "all outcomes should be success");
  const ids = results.map((r) => r.packet.id).sort();
  assert.deepEqual(ids, ["p1", "p2", "p3", "p4", "p5"], "all packet ids should be present");
});

test("createRollingDispatcher — onResult callback called once per packet", async () => {
  await setupTmpQuotaDir();
  const packets = [1, 2, 3].map((i) => makePacket(`p${i}`));
  const callbackIds = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => ({ packet, outcome: "success" }),
    onResult: (result) => callbackIds.push(result.packet.id),
  });

  dispatcher.enqueue(packets);
  await dispatcher.run();

  assert.equal(callbackIds.length, 3, "onResult called once per packet");
});

// ---------------------------------------------------------------------------
// createRollingDispatcher — rolling (sequential under concurrency limit=1)
// ---------------------------------------------------------------------------

test("createRollingDispatcher — re-dispatches immediately on result arrival (rolling)", async () => {
  await setupTmpQuotaDir();
  const dispatchOrder = [];
  const completionOrder = [];
  let resolvers = {};

  // maxConcurrentPerPool=1 forces sequential dispatch
  const dispatcher = createRollingDispatcher(
    {
      confirmedPools: [makePool("pool-a")],
      sessionConfig: unlimitedSession(),
      dispatchPacket: async (packet) => {
        dispatchOrder.push(packet.id);
        // Each packet waits until we resolve it manually
        await new Promise((resolve) => { resolvers[packet.id] = resolve; });
        completionOrder.push(packet.id);
        return { packet, outcome: "success" };
      },
    },
    { maxConcurrentPerPool: 1 },
  );

  dispatcher.enqueue([makePacket("p1"), makePacket("p2"), makePacket("p3")]);

  const runPromise = dispatcher.run();

  // Give the dispatcher a moment to start the first packet
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dispatchOrder.length, 1, "only one dispatch should be active initially");

  // Complete p1 — p2 should start
  resolvers["p1"]();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dispatchOrder.length, 2, "second dispatch should start after first completes");

  // Complete p2 — p3 should start
  resolvers["p2"]();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(dispatchOrder.length, 3, "third dispatch should start after second completes");

  // Complete p3 — run() should resolve
  resolvers["p3"]();
  const results = await runPromise;

  assert.equal(results.length, 3, "all 3 packets completed");
  assert.equal(dispatchOrder.length, 3, "total dispatch calls equals packet count");
});

// ---------------------------------------------------------------------------
// createRollingDispatcher — quota outcome recording
// ---------------------------------------------------------------------------

test("createRollingDispatcher — records wave outcomes after each result", async () => {
  const dir = await setupTmpQuotaDir();

  const { readQuotaState } = await import("../../src/shared/quota/state.ts");

  const packet = makePacket("p1", { estimatedTokens: 500 });

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (pkt) => ({ packet: pkt, outcome: "success" }),
  });

  dispatcher.enqueue([packet]);
  await dispatcher.run();

  const state = await readQuotaState();
  const keys = Object.keys(state.entries);
  assert.ok(keys.length > 0, "quota state should have at least one entry after dispatch");
});

// ---------------------------------------------------------------------------
// createRollingDispatcher — run() resolves when all packets complete
// ---------------------------------------------------------------------------

test("createRollingDispatcher — run() resolves when all packets complete", async () => {
  await setupTmpQuotaDir();

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => ({ packet, outcome: "success" }),
  });

  dispatcher.enqueue([makePacket("p1"), makePacket("p2")]);
  const results = await dispatcher.run();

  const state = dispatcher.getState();
  assert.equal(state.inFlight.size, 0, "inFlight should be empty after run()");
  assert.equal(state.completedIds.size, 2, "all ids should be in completedIds");
  assert.ok(state.completedIds.has("p1"));
  assert.ok(state.completedIds.has("p2"));
  assert.equal(results.length, 2);
});

// ---------------------------------------------------------------------------
// createRollingDispatcher — enqueue mid-run
// ---------------------------------------------------------------------------

test("createRollingDispatcher — packets enqueued mid-run are dispatched before run() resolves", async () => {
  await setupTmpQuotaDir();
  const dispatched = [];
  let firstResolver;

  const dispatcher = createRollingDispatcher(
    {
      confirmedPools: [makePool("pool-a")],
      sessionConfig: unlimitedSession(),
      dispatchPacket: async (packet) => {
        dispatched.push(packet.id);
        if (packet.id === "p1") {
          // Hold p1 until we enqueue p2
          await new Promise((resolve) => { firstResolver = resolve; });
        }
        return { packet, outcome: "success" };
      },
    },
    { maxConcurrentPerPool: 1 },
  );

  dispatcher.enqueue([makePacket("p1")]);
  const runPromise = dispatcher.run();

  // Wait for p1 to be dispatched
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dispatched.length, 1, "p1 dispatched");

  // Enqueue p2 while p1 is in flight
  dispatcher.enqueue([makePacket("p2")]);

  // Now release p1
  firstResolver();
  const results = await runPromise;

  assert.equal(results.length, 2, "both p1 and p2 should be in results");
  const ids = results.map((r) => r.packet.id).sort();
  assert.deepEqual(ids, ["p1", "p2"]);
});

// ---------------------------------------------------------------------------
// Transient-429 recovery (INV-QD-07 / ARC-d81a55ab / SEAM-rolling-stranding-remediate)
// ---------------------------------------------------------------------------

test("createRollingDispatcher — rate_limited result re-queues the packet and dispatches it to a surviving pool (INV-QD-07)", async () => {
  await setupTmpQuotaDir();
  // Two pools. pool-a rate-limits every packet it sees; pool-b succeeds.
  const attemptsByPool = { "pool-a": 0, "pool-b": 0 };

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      attemptsByPool[slot.poolId] = (attemptsByPool[slot.poolId] ?? 0) + 1;
      if (slot.poolId === "pool-a") {
        return { packet, outcome: "rate_limited" };
      }
      return { packet, outcome: "success" };
    },
  });

  dispatcher.enqueue([makePacket("p1"), makePacket("p2")]);
  const results = await dispatcher.run();

  // Both packets eventually SUCCEED on the surviving pool — never stranded.
  assert.equal(results.length, 2, "both packets complete after re-route");
  assert.ok(results.every((r) => r.outcome === "success"), "all final outcomes success");
  assert.deepEqual(results.map((r) => r.packet.id).sort(), ["p1", "p2"]);

  // pool-a was dropped after its first rate_limited result, so subsequent
  // packets route straight to pool-b.
  assert.ok(attemptsByPool["pool-a"] >= 1, "pool-a attempted at least once");
  assert.ok(attemptsByPool["pool-b"] >= 2, "both packets land on the surviving pool-b");

  // No terminal — nothing stranded.
  assert.equal(dispatcher.getTerminal(), null);
  // The exhausted pool is recorded in state.
  assert.ok(dispatcher.getState().exhaustedPoolIds.has("pool-a"));
});

test("createRollingDispatcher — when every pool exhausts, the packet is stranded and surfaced via getTerminal (INV-QD-07 empty_pool)", async () => {
  await setupTmpQuotaDir();
  // Single pool that always rate-limits → no survivor → strand.
  let attempts = 0;
  const onResultCalls = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("only-pool")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => {
      attempts++;
      return { packet, outcome: "rate_limited" };
    },
    onResult: (r) => onResultCalls.push(r.packet.id),
  });

  dispatcher.enqueue([makePacket("p1")]);
  // run() must RESOLVE (never hang / reject) even though the packet can't land.
  const results = await dispatcher.run();

  // The rate_limited packet is not a completion — no result, no onResult call.
  assert.equal(results.length, 0, "stranded packet produces no completion result");
  assert.equal(onResultCalls.length, 0, "onResult not called for a stranded packet");

  // It is surfaced as an empty_pool terminal.
  const terminal = dispatcher.getTerminal();
  assert.ok(terminal !== null, "stranded packet must surface a terminal");
  assert.equal(terminal.reason, "empty_pool");
  assert.deepEqual(terminal.stranded_ids, ["p1"]);

  // The only pool was dropped after its first rate_limited; bounded retries.
  assert.ok(attempts >= 1, "packet attempted at least once before stranding");
  assert.ok(dispatcher.getState().exhaustedPoolIds.has("only-pool"));
});

test("createRollingDispatcher — dispatch callback that rejects is contained (resolves as error, never rejects run)", async () => {
  await setupTmpQuotaDir();
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (_packet) => {
      throw new Error("provider blew up");
    },
  });

  dispatcher.enqueue([makePacket("p1")]);
  // Must not reject — the engine maps a thrown dispatch into an 'error' result.
  const results = await dispatcher.run();
  assert.equal(results.length, 1);
  assert.equal(results[0].outcome, "error");
  // An 'error' (non-quota failure) is terminal, not re-queued, and not stranded.
  assert.equal(dispatcher.getTerminal(), null);
});

// ---------------------------------------------------------------------------
// selectProvider — exhausted-pool exclusion (INV-QD-07 re-route mechanism)
// ---------------------------------------------------------------------------

test("selectProvider — skips pools in the exhausted set and routes to a survivor", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 1.0 });
  // High-complexity normally prefers the deep pool, but it's exhausted → small.
  const deepPool = makePool("deep-pool", { providerName: "claude-code", rank: "deep" });
  const smallPool = makePool("small-pool", { providerName: "claude-code", rank: "small" });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(
    packet,
    [deepPool, smallPool],
    tracker,
    {},
    unlimitedSession(),
    new Set(["deep-pool"]),
  );
  assert.ok(slot !== null, "a surviving pool should still be selected");
  assert.equal(slot.poolId, "small-pool", "exhausted deep-pool must be skipped");
});

test("selectProvider — returns null when every pool is exhausted", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1");
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(
    packet,
    [makePool("a"), makePool("b")],
    tracker,
    {},
    unlimitedSession(),
    new Set(["a", "b"]),
  );
  assert.equal(slot, null, "no eligible pool → null");
});

// ---------------------------------------------------------------------------
// selectProvider — proactive cross-pool spill (INV-QD-14)
//
// The reactive re-route (INV-QD-07) only fires AFTER a 429. These cover the
// proactive complement: a pool whose live remaining_pct is below the LOW band,
// or that is in an active cooldown, is deprioritised so load spills to a peer
// with headroom BEFORE it 429s.
// ---------------------------------------------------------------------------

test("selectProvider — spills off a quota-degraded pool to a healthy peer (INV-QD-14)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  // Same (absent) rank → capability is a tie, so health is the sole differentiator.
  // The degraded pool is FIRST in the array: only the spill reorder can make the
  // healthy peer win, so this isolates the new behaviour.
  const degraded = makePool("degraded-pool", { quotaSourceSnapshot: { remaining_pct: 0.05 } });
  const healthy = makePool("healthy-pool", { quotaSourceSnapshot: { remaining_pct: 0.95 } });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [degraded, healthy], tracker, {}, enabledSession());
  assert.ok(slot !== null);
  assert.equal(slot.poolId, "healthy-pool", "load must spill off the degraded pool to the healthy peer");
});

test("selectProvider — spills off a pool in active cooldown to a peer with headroom (INV-QD-14)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // cooling-pool has an active learned cooldown → scheduleWave reports cooldown_until → degraded.
  const cooling = makePool("cooling-pool", { quotaStateEntry: { cooldown_until: future } });
  const healthy = makePool("healthy-pool");
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [cooling, healthy], tracker, {}, enabledSession());
  assert.ok(slot !== null);
  assert.equal(slot.poolId, "healthy-pool", "a pool in active cooldown is spilled over for a healthy peer");
});

test("selectProvider — all pools degraded still yields a slot; capability order applies within the fallback group (INV-QD-14)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 1.0 });
  const deep = makePool("deep-pool", { rank: "deep", quotaSourceSnapshot: { remaining_pct: 0.04 } });
  const small = makePool("small-pool", { rank: "small", quotaSourceSnapshot: { remaining_pct: 0.04 } });
  const tracker = new InFlightTokenTracker();
  // small-pool first in array; a degraded pool is a usable fallback, never a stall.
  const slot = selectProvider(packet, [small, deep], tracker, {}, enabledSession());
  assert.ok(slot !== null, "a degraded pool is still a usable fallback — never a stall");
  assert.equal(slot.poolId, "deep-pool", "within the all-degraded group, high-complexity still prefers deep");
});

test("selectProvider — among healthy pools, capability still decides; health never overrides rank within a group (INV-QD-14)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 1.0 });
  const deep = makePool("deep-pool", { rank: "deep", quotaSourceSnapshot: { remaining_pct: 0.9 } });
  const small = makePool("small-pool", { rank: "small", quotaSourceSnapshot: { remaining_pct: 0.9 } });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [small, deep], tracker, {}, enabledSession());
  assert.ok(slot !== null);
  assert.equal(slot.poolId, "deep-pool", "both healthy → high-complexity prefers deep (capability, not health, decides)");
});

// ---------------------------------------------------------------------------
// scorePacketComplexity
// ---------------------------------------------------------------------------

test("scorePacketComplexity — returns packet.complexity field", () => {
  const packet = makePacket("p1", { complexity: 0.75 });
  assert.equal(scorePacketComplexity(packet), 0.75);
});
