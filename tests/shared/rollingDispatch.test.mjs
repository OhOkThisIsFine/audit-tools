import { test, describe, it, expect } from "vitest";
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

const { HostSessionQuotaSource } = await import(
  "../../src/shared/quota/hostSessionQuotaSource.ts"
);

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
  return { quota: {} };
}

// Session config with quota management active — required to exercise the
// proactive cross-pool spill ordering (INV-QD-14), which is inert when quota is
// disabled (selection then stays pure capability order).
function enabledSession() {
  return { quota: { safety_margin: 1.0 } };
}

async function setupTmpQuotaDir() {
  const dir = await mkdtemp(join(tmpdir(), "rolling-dispatch-test-"));
  setQuotaStateDir(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// InFlightTokenTracker
// ---------------------------------------------------------------------------

describe("InFlightTokenTracker — records and releases tokens per pool", () => {
  it("recordDispatched accumulates", () => {
    const tracker = new InFlightTokenTracker();
    tracker.recordDispatched("pool-a", 1000);
    expect(tracker.getInFlightTokens("pool-a")).toBe(1000);
    tracker.recordDispatched("pool-a", 500);
    expect(tracker.getInFlightTokens("pool-a")).toBe(1500);
  });

  it("recordCompleted decreases", () => {
    const tracker = new InFlightTokenTracker();
    tracker.recordDispatched("pool-a", 1500);
    tracker.recordCompleted("pool-a", 1000);
    expect(tracker.getInFlightTokens("pool-a")).toBe(500);
  });

  it("unknown pool returns 0", () => {
    const tracker = new InFlightTokenTracker();
    expect(tracker.getInFlightTokens("nonexistent")).toBe(0);
  });

  it("recordCompleted clamps to 0 (no negatives)", () => {
    const tracker = new InFlightTokenTracker();
    tracker.recordDispatched("pool-a", 100);
    tracker.recordCompleted("pool-a", 5000); // over-release
    expect(tracker.getInFlightTokens("pool-a")).toBe(0);
  });

  it("pools are independent", () => {
    const tracker = new InFlightTokenTracker();
    tracker.recordDispatched("pool-a", 1000);
    tracker.recordDispatched("pool-b", 2000);
    expect(tracker.getInFlightTokens("pool-a")).toBe(1000);
    expect(tracker.getInFlightTokens("pool-b")).toBe(2000);
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
    quota: { safety_margin: 1.0,
      models: { "test-model": { requests_per_minute: 0 } },
    },
  };
  const tracker = new InFlightTokenTracker();
  const result = selectProvider(packet, [pool], tracker, {}, session);
  // rpmCap = Math.max(1, floor(0 * 1.0)) = 1, so wave_size stays >= 1 by design
  // (always dispatch at least one). A single eligible pool therefore yields a slot.
  expect(result).not.toBe(null);
});

test("selectProvider — returns slot when pool has headroom", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const pool = makePool("pool-a");
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [pool], tracker, {}, unlimitedSession());
  expect(slot !== null, "should return a slot for a pool with headroom").toBeTruthy();
  expect(slot.poolId).toBe("pool-a");
  expect(slot.providerName).toBe("claude-code");
});

test("selectProvider — returns null when no pools provided", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1");
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [], tracker, {}, unlimitedSession());
  expect(slot).toBe(null);
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
  expect(slot !== null).toBeTruthy();
  expect(slot.poolId, "high-complexity packet should select pool with rank=deep").toBe("deep-pool");
});

test("selectProvider — low-complexity routes to lower-rank pool first (INV-shared-core-02: rank from pool.rank, not provider name)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.0 });
  // INV-shared-core-02: same providerName, different ranks — low-complexity prefers small.
  const deepPool = makePool("deep-pool", { providerName: "claude-code", rank: "deep" });
  const smallPool = makePool("small-pool", { providerName: "claude-code", rank: "small" });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [deepPool, smallPool], tracker, {}, unlimitedSession());
  expect(slot !== null).toBeTruthy();
  expect(slot.poolId, "low-complexity packet should select pool with rank=small").toBe("small-pool");
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

  expect(results.length, "should return 5 results").toBe(5);
  expect(results.every((r) => r.outcome === "success"), "all outcomes should be success").toBeTruthy();
  const ids = results.map((r) => r.packet.id).sort();
  expect(ids, "all packet ids should be present").toEqual(["p1", "p2", "p3", "p4", "p5"]);
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

  expect(callbackIds.length, "onResult called once per packet").toBe(3);
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
  expect(dispatchOrder.length, "only one dispatch should be active initially").toBe(1);

  // Complete p1 — p2 should start
  resolvers["p1"]();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(dispatchOrder.length, "second dispatch should start after first completes").toBe(2);

  // Complete p2 — p3 should start
  resolvers["p2"]();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(dispatchOrder.length, "third dispatch should start after second completes").toBe(3);

  // Complete p3 — run() should resolve
  resolvers["p3"]();
  const results = await runPromise;

  expect(results.length, "all 3 packets completed").toBe(3);
  expect(dispatchOrder.length, "total dispatch calls equals packet count").toBe(3);
});

test("createRollingDispatcher — a pool's own concurrencyCap ceilings its in-flight COUNT (no global option)", async () => {
  // C3 (NIM/Codex fix set): an optimistic unmetered source has no token budget to
  // throttle on, so without a per-pool COUNT cap the engine dispatches every ready
  // packet at once and overruns the endpoint (the NIM 33/32 incident). The pool's
  // own `concurrencyCap` must ceiling in-flight even when NO maxConcurrentPerPool
  // option is passed.
  await setupTmpQuotaDir();
  let active = 0;
  let peak = 0;
  const resolvers = {};
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("nim", { concurrencyCap: 2 })],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => { resolvers[packet.id] = resolve; });
      active -= 1;
      return { packet, outcome: "success" };
    },
  });
  // Five ready packets, cap 2 — no global maxConcurrentPerPool option in play.
  dispatcher.enqueue([1, 2, 3, 4, 5].map((n) => makePacket(`p${n}`)));
  const runPromise = dispatcher.run();

  // Let the first pass fill to the cap and stabilize.
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(active, "cap=2 admits at most 2 concurrently").toBeLessThanOrEqual(2);
  expect(active, "cap=2 fills to the cap (endpoint not left idle)").toBe(2);

  // Drain: resolve whatever is in flight; the engine backfills up to the cap each
  // time until all five complete. peak must never exceed the cap.
  let done = false;
  runPromise.then(() => { done = true; });
  while (!done) {
    for (const id of Object.keys(resolvers)) {
      const r = resolvers[id];
      if (r) { delete resolvers[id]; r(); }
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  const results = await runPromise;
  expect(results.length, "all packets complete despite the cap").toBe(5);
  expect(peak, "in-flight COUNT never exceeded the pool's concurrencyCap").toBe(2);
});

test("createRollingDispatcher — a non-positive concurrencyCap is treated as NO cap (never wedges)", async () => {
  // Defense-in-depth for the clamp: even if a concurrencyCap:0 reached a pool, the
  // engine must treat it as uncapped rather than skipping every packet forever (which
  // would spin the run on the no-progress tick).
  await setupTmpQuotaDir();
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("nim", { concurrencyCap: 0 })],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => ({ packet, outcome: "success" }),
  });
  dispatcher.enqueue([makePacket("p1"), makePacket("p2"), makePacket("p3")]);
  const results = await dispatcher.run();
  expect(results.length, "all packets dispatch — cap:0 did not wedge the engine").toBe(3);
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
  expect(keys.length > 0, "quota state should have at least one entry after dispatch").toBeTruthy();
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
  expect(state.inFlight.size, "inFlight should be empty after run()").toBe(0);
  expect(state.completedIds.size, "all ids should be in completedIds").toBe(2);
  expect(state.completedIds.has("p1")).toBeTruthy();
  expect(state.completedIds.has("p2")).toBeTruthy();
  expect(results.length).toBe(2);
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
  expect(dispatched.length, "p1 dispatched").toBe(1);

  // Enqueue p2 while p1 is in flight
  dispatcher.enqueue([makePacket("p2")]);

  // Now release p1
  firstResolver();
  const results = await runPromise;

  expect(results.length, "both p1 and p2 should be in results").toBe(2);
  const ids = results.map((r) => r.packet.id).sort();
  expect(ids).toEqual(["p1", "p2"]);
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
  expect(results.length, "both packets complete after re-route").toBe(2);
  expect(results.every((r) => r.outcome === "success"), "all final outcomes success").toBeTruthy();
  expect(results.map((r) => r.packet.id).sort()).toEqual(["p1", "p2"]);

  // pool-a was dropped after its first rate_limited result, so subsequent
  // packets route straight to pool-b.
  expect(attemptsByPool["pool-a"] >= 1, "pool-a attempted at least once").toBeTruthy();
  expect(attemptsByPool["pool-b"] >= 2, "both packets land on the surviving pool-b").toBeTruthy();

  // No terminal — nothing stranded.
  expect(dispatcher.getTerminal()).toBe(null);
  // The exhausted pool is recorded in state.
  expect(dispatcher.getState().exhaustedPoolIds.has("pool-a")).toBeTruthy();
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
  expect(results.length, "stranded packet produces no completion result").toBe(0);
  expect(onResultCalls.length, "onResult not called for a stranded packet").toBe(0);

  // It is surfaced as an empty_pool terminal.
  const terminal = dispatcher.getTerminal();
  expect(terminal !== null, "stranded packet must surface a terminal").toBeTruthy();
  expect(terminal.reason).toBe("empty_pool");
  expect(terminal.stranded_ids).toEqual(["p1"]);

  // The only pool was dropped after its first rate_limited; bounded retries.
  expect(attempts >= 1, "packet attempted at least once before stranding").toBeTruthy();
  expect(dispatcher.getState().exhaustedPoolIds.has("only-pool")).toBeTruthy();
});

// ---------------------------------------------------------------------------
// Credit exhaustion (Slice A2 / backlog HIGH 2026-07-11) — a deep-tier model OUT
// OF USAGE CREDITS is distinct from a 429/rate_limited: no reset timer. The
// engine must exclude the pool from the admissible set for the REST OF THE RUN
// (never a timed cooldown) and let surviving pools absorb the work, recording a
// friction event via onCreditExhausted — never re-kill every packet on it.
// ---------------------------------------------------------------------------

test("createRollingDispatcher — credit_exhausted result permanently excludes the pool and re-queues the packet to a surviving pool", async () => {
  await setupTmpQuotaDir();
  const attemptsByPool = { "pool-a": 0, "pool-b": 0 };

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      attemptsByPool[slot.poolId] = (attemptsByPool[slot.poolId] ?? 0) + 1;
      if (slot.poolId === "pool-a") {
        return {
          packet,
          outcome: "credit_exhausted",
          creditExhaustion: { channel: "error", text: "credit balance is too low", rawMatch: "credit balance is too low" },
        };
      }
      return { packet, outcome: "success" };
    },
  });

  dispatcher.enqueue([makePacket("p1"), makePacket("p2")]);
  const results = await dispatcher.run();

  // Both packets eventually SUCCEED on the surviving pool — never stranded, the
  // run degrades to pool-b rather than dying.
  expect(results.length, "both packets complete after re-route").toBe(2);
  expect(results.every((r) => r.outcome === "success"), "all final outcomes success").toBeTruthy();

  // pool-a died exactly once (never re-killed on it again) then every
  // subsequent packet routed straight to the surviving pool-b.
  expect(attemptsByPool["pool-a"]).toBe(1);
  expect(attemptsByPool["pool-b"] >= 2, "both packets land on the surviving pool-b").toBeTruthy();

  expect(dispatcher.getTerminal()).toBe(null);
  const state = dispatcher.getState();
  expect(state.exhaustedPoolIds.has("pool-a"), "credit-exhausted pool is permanently excluded").toBeTruthy();
  // No timer-reset pause was recorded — this is NOT the resettable rate_limited
  // pause path (pausedPoolResetAt), it is the monotonic permanent exclusion.
  expect(state.pausedPoolResetAt.has("pool-a"), "never a timed cooldown for credit exhaustion").toBe(false);
});

test("createRollingDispatcher — credit_exhausted is classified distinctly from rate_limited (does not consume the reset-pause path)", async () => {
  await setupTmpQuotaDir();
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("only-pool"), makePool("backup-pool")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      if (slot.poolId === "only-pool") {
        return { packet, outcome: "credit_exhausted", creditExhaustion: { channel: "error", text: "out of usage credits", rawMatch: "out of usage credits" } };
      }
      return { packet, outcome: "success" };
    },
  });
  dispatcher.enqueue([makePacket("p1")]);
  await dispatcher.run();
  const state = dispatcher.getState();
  // Permanently excluded (like a bare unresettable 429), never a resettable pause.
  expect(state.exhaustedPoolIds.has("only-pool")).toBeTruthy();
  expect(state.pausedPoolResetAt.has("only-pool")).toBe(false);
});

test("createRollingDispatcher — when every pool credit-exhausts, the packet is stranded and surfaced via getTerminal (graceful degrade, not a crash)", async () => {
  await setupTmpQuotaDir();
  let attempts = 0;
  const onResultCalls = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("only-pool")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => {
      attempts++;
      return { packet, outcome: "credit_exhausted", creditExhaustion: { channel: "error", text: "insufficient credits", rawMatch: "insufficient credits" } };
    },
    onResult: (r) => onResultCalls.push(r.packet.id),
  });

  dispatcher.enqueue([makePacket("p1")]);
  // run() must RESOLVE gracefully (never hang / reject / throw) even though the
  // sole pool is permanently dead — this is the graceful-degrade requirement:
  // the run pauses/strands, it does not crash.
  const results = await dispatcher.run();

  expect(results.length, "stranded packet produces no completion result").toBe(0);
  expect(onResultCalls.length).toBe(0);

  const terminal = dispatcher.getTerminal();
  expect(terminal !== null, "stranded packet must surface a terminal").toBeTruthy();
  expect(terminal.reason).toBe("empty_pool");
  expect(terminal.stranded_ids).toEqual(["p1"]);

  // The pool died exactly once — never re-killed on retry.
  expect(attempts).toBe(1);
  expect(dispatcher.getState().exhaustedPoolIds.has("only-pool")).toBeTruthy();
});

test("createRollingDispatcher — fires onCreditExhausted with poolId + rawMatch, and records the wave outcome as 'error' (never a rate_limited backoff cooldown)", async () => {
  const dir = await setupTmpQuotaDir();
  const { readQuotaState } = await import("../../src/shared/quota/state.ts");

  const exhaustions = [];
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("dead-pool"), makePool("live-pool")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      if (slot.poolId === "dead-pool") {
        return {
          packet,
          outcome: "credit_exhausted",
          creditExhaustion: { channel: "error", text: "no credits remaining", rawMatch: "no credits remaining" },
        };
      }
      return { packet, outcome: "success" };
    },
    onCreditExhausted: (info) => exhaustions.push(info),
  });

  dispatcher.enqueue([makePacket("p1")]);
  await dispatcher.run();

  expect(exhaustions.length, "onCreditExhausted fires once for the dead pool").toBe(1);
  expect(exhaustions[0]).toEqual({ poolId: "dead-pool", rawMatch: "no credits remaining" });

  // recordWaveOutcome was told 'error' (not 'rate_limited'), so the persisted
  // quota-state entry for the dead pool carries NO backoff cooldown_until — the
  // permanent-for-run exclusion lives only in the in-memory exhaustedPoolIds
  // set, never as a timed cooldown a future run could wait out and re-hit.
  const state = await readQuotaState();
  const entry = state.entries["dead-pool"];
  expect(entry?.cooldown_until ?? null, "no timed cooldown persisted for credit exhaustion").toBe(null);
});

test("createRollingDispatcher — onCreditExhausted is NOT fired for a plain rate_limited result (classes stay disjoint at the engine)", async () => {
  await setupTmpQuotaDir();
  const exhaustions = [];
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      if (slot.poolId === "pool-a") return { packet, outcome: "rate_limited" };
      return { packet, outcome: "success" };
    },
    onCreditExhausted: (info) => exhaustions.push(info),
  });
  dispatcher.enqueue([makePacket("p1")]);
  await dispatcher.run();
  expect(exhaustions.length).toBe(0);
});

// ---------------------------------------------------------------------------
// Piece D — quota-death = retryable pause + pool-pause + quota_paused terminal
// ---------------------------------------------------------------------------

test("selectProvider — skips a pool paused until a future reset (pause-honor, no thrash)", async () => {
  const packet = makePacket("p1");
  const tracker = new InFlightTokenTracker();
  const paused = makePool("paused-pool");
  const healthy = makePool("healthy-pool");
  const now = Date.now();
  const pausedMap = new Map([["paused-pool", now + 60_000]]);
  // paused-pool is paused → selection falls through to healthy-pool.
  const slot = selectProvider(
    packet,
    [paused, healthy],
    tracker,
    {},
    unlimitedSession(),
    new Set(),
    pausedMap,
    new Set(),
    now,
  );
  expect(slot !== null).toBeTruthy();
  expect(slot.poolId).toBe("healthy-pool");
});

test("selectProvider — a pool whose reset has already passed is eligible again", async () => {
  const packet = makePacket("p1");
  const tracker = new InFlightTokenTracker();
  const pool = makePool("recovered-pool");
  const now = Date.now();
  const pausedMap = new Map([["recovered-pool", now - 1_000]]); // reset in the past
  const slot = selectProvider(
    packet,
    [pool],
    tracker,
    {},
    unlimitedSession(),
    new Set(),
    pausedMap,
    new Set(),
    now,
  );
  expect(slot !== null, "past-reset pool is re-eligible").toBeTruthy();
  expect(slot.poolId).toBe("recovered-pool");
});

test("createRollingDispatcher — a rate_limited result with a session-limit reset records a pool pause + parses reset_at (does NOT permanently exhaust)", async () => {
  await setupTmpQuotaDir();
  // Single pool that rate-limits with a wall-clock session-limit string.
  const LIMIT_TEXT = "You've hit your session limit. Resets in 2h";
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("only-pool")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => ({
      packet,
      outcome: "rate_limited",
      rateLimit: { channel: "error", text: LIMIT_TEXT },
    }),
  });
  dispatcher.enqueue([makePacket("p1")]);
  const results = await dispatcher.run();

  expect(results.length, "paused packet produces no completion").toBe(0);
  const state = dispatcher.getState();
  // Pool is PAUSED (with a reset), not permanently exhausted.
  expect(state.pausedPoolResetAt.has("only-pool"), "pool recorded as paused").toBeTruthy();
  expect(!state.exhaustedPoolIds.has("only-pool"), "reset pause is not permanent exhaustion").toBeTruthy();
  const resetAt = state.pausedPoolResetAt.get("only-pool");
  expect(resetAt > Date.now(), "reset is in the future (~2h)").toBeTruthy();
});

test("createRollingDispatcher — all pools paused → quota_paused terminal with stranded ids + earliest_reset_at (NOT empty_pool, NOT blocked)", async () => {
  await setupTmpQuotaDir();
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => ({
      packet,
      outcome: "rate_limited",
      rateLimit: {
        channel: "error",
        // pool-a resets sooner than pool-b → earliest_reset_at must be pool-a's.
        text: slot.poolId === "pool-a" ? "session limit reached. Resets in 1h" : "session limit reached. Resets in 3h",
      },
    }),
  });
  dispatcher.enqueue([makePacket("p1"), makePacket("p2")]);
  const results = await dispatcher.run();

  expect(results.length, "both packets stranded, none completed").toBe(0);
  const terminal = dispatcher.getTerminal();
  expect(terminal !== null, "stranded work surfaces a terminal").toBeTruthy();
  expect(terminal.reason, "reason is the retryable quota_paused, not empty_pool").toBe("quota_paused");
  expect(terminal.stranded_ids.sort()).toEqual(["p1", "p2"]);
  expect(typeof terminal.earliest_reset_at === "string", "carries the earliest reset").toBeTruthy();
  // Earliest reset is ~1h (pool-a), well under the ~3h pool-b wall.
  const resetMs = Date.parse(terminal.earliest_reset_at) - Date.now();
  expect(resetMs < 2 * 3600_000, "earliest_reset_at is pool-a's sooner reset").toBeTruthy();
});

test("createRollingDispatcher — one pool paused, a healthy peer still lands the work (pause-honor spills, no strand)", async () => {
  await setupTmpQuotaDir();
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("paused-pool"), makePool("healthy-pool")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      if (slot.poolId === "paused-pool") {
        return { packet, outcome: "rate_limited", rateLimit: { channel: "error", text: "session limit reached. Resets in 1h" } };
      }
      return { packet, outcome: "success" };
    },
  });
  dispatcher.enqueue([makePacket("p1"), makePacket("p2")]);
  const results = await dispatcher.run();
  expect(results.length, "both packets land on the healthy peer").toBe(2);
  expect(results.every((r) => r.outcome === "success")).toBeTruthy();
  expect(dispatcher.getTerminal(), "no strand — healthy pool absorbed the work").toBe(null);
});

test("createRollingDispatcher — host-session source wired via recordRateLimit/isPacketEscalated strands a same-packet account wall BEFORE all pools exhaust", async () => {
  await setupTmpQuotaDir();
  // Four pools that ALL rate-limit p1 with a parseable host-session-limit string.
  // The retained source escalates the same packet once its bounded re-limit count
  // is exceeded; the dispatcher then STRANDS it instead of re-routing to the next
  // surviving pool — so a pool is left un-attempted, proving the early strand.
  const LIMIT_TEXT = "session limit reached. Resets in 1h";
  const escalations = [];
  const hostSession = new HostSessionQuotaSource({
    providerModelKey: "claude-code::host",
    maxConsecutiveReLimits: 2,
    onEscalation: (e) => escalations.push(e),
  });

  const attemptedPools = new Set();
  const dispatcher = createRollingDispatcher(
    {
      confirmedPools: [makePool("pool-a"), makePool("pool-b"), makePool("pool-c"), makePool("pool-d")],
      sessionConfig: unlimitedSession(),
      dispatchPacket: async (packet, slot) => {
        attemptedPools.add(slot.poolId);
        return { packet, outcome: "rate_limited", rateLimit: { channel: "error", text: LIMIT_TEXT } };
      },
      recordRateLimit: (packet, result) =>
        hostSession.recordLimit(
          result.rateLimit?.channel ?? "error",
          result.rateLimit?.text ?? "",
          packet.id,
        ),
      isPacketEscalated: (id) => hostSession.isEscalated(id),
    },
    { maxConcurrentPerPool: 1 },
  );

  dispatcher.enqueue([makePacket("p1")]);
  const results = await dispatcher.run();

  // p1 escalated (count 3 > bound 2) → stranded, not completed.
  expect(results.length, "escalated packet produces no completion result").toBe(0);
  const terminal = dispatcher.getTerminal();
  expect(terminal !== null, "escalated packet surfaces a terminal").toBeTruthy();
  expect(terminal.stranded_ids).toEqual(["p1"]);

  // onEscalation fired exactly once for p1.
  expect(escalations.length, "host-session source escalated once").toBe(1);
  expect(escalations[0].packet_id).toBe("p1");
  expect(hostSession.isEscalated("p1"), "source marks p1 escalated").toBeTruthy();

  // Early strand: the 4th pool was never attempted (escalation fired on the 3rd
  // re-limit), so the strand is the ESCALATION guard, not pool exhaustion.
  expect(attemptedPools.size, "stranded after 3 re-limits, before the 4th pool").toBe(3);
  expect(!attemptedPools.has("pool-d"), "the surviving 4th pool was never reached").toBeTruthy();
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
  expect(results.length).toBe(1);
  expect(results[0].outcome).toBe("error");
  // An 'error' (non-quota failure) is terminal, not re-queued, and not stranded.
  expect(dispatcher.getTerminal()).toBe(null);
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
  expect(slot !== null, "a surviving pool should still be selected").toBeTruthy();
  expect(slot.poolId, "exhausted deep-pool must be skipped").toBe("small-pool");
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
  expect(slot, "no eligible pool → null").toBe(null);
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
  expect(slot !== null).toBeTruthy();
  expect(slot.poolId, "load must spill off the degraded pool to the healthy peer").toBe("healthy-pool");
});

test("selectProvider — spills off a pool in active cooldown to a peer with headroom (INV-QD-14)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // cooling-pool has an active learned cooldown carried in the LIVE quota-state
  // record (keyed by pool id) — the same channel a mid-run 429 writes it to.
  // scheduleWave reports cooldown_until → degraded → spill.
  const cooling = makePool("cooling-pool");
  const healthy = makePool("healthy-pool");
  const tracker = new InFlightTokenTracker();
  const liveEntries = { "cooling-pool": { cooldown_until: future } };
  const slot = selectProvider(packet, [cooling, healthy], tracker, liveEntries, enabledSession());
  expect(slot !== null).toBeTruthy();
  expect(slot.poolId, "a pool in active cooldown is spilled over for a healthy peer").toBe("healthy-pool");
});

test("selectProvider — a cooldown learned mid-run (live entry) is observed even when the pool's frozen snapshot is stale-healthy (bug 4)", async () => {
  // Regression for bug (4): scheduleForPool must read the LIVE quotaStateEntries
  // record, never the `pool.quotaStateEntry` snapshot captured at construction. A
  // pool built while healthy (non-null snapshot with NO cooldown) then throttled
  // mid-run gets its cooldown written to the live cache; if selection short-circuits
  // on the frozen snapshot, INV-QD-14 spill never sees the cooldown and load keeps
  // hitting the throttled pool. The live entry must win.
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // Frozen snapshot is present but healthy (no cooldown) — the exact masking shape.
  const throttled = makePool("throttled-pool", {
    quotaStateEntry: { cooldown_until: null, consecutive_429_count: 0 },
  });
  const healthy = makePool("healthy-pool");
  const tracker = new InFlightTokenTracker();
  // The cooldown exists ONLY in the live record, keyed by pool id.
  const liveEntries = { "throttled-pool": { cooldown_until: future } };
  const slot = selectProvider(packet, [throttled, healthy], tracker, liveEntries, enabledSession());
  expect(slot !== null).toBeTruthy();
  expect(
    slot.poolId,
    "the live cooldown must be observed despite a stale-healthy frozen snapshot → spill to the healthy peer",
  ).toBe("healthy-pool");
});

test("selectProvider — falls back to the pool's construction snapshot cooldown when the live record is unavailable (transient-read window)", async () => {
  // Complement to bug (4): the live record is PREFERRED, but when it is empty for a
  // pool (the narrow window where readQuotaState transiently fails and the cache
  // retains empty state) the frozen `pool.quotaStateEntry` snapshot — captured from a
  // successful construction-time read — is the last-resort signal, so a prior-run
  // cooldown still drives INV-QD-14 proactive spill rather than waiting for a 429.
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cooling = makePool("cooling-pool", { quotaStateEntry: { cooldown_until: future } });
  const healthy = makePool("healthy-pool");
  const tracker = new InFlightTokenTracker();
  // Live record is EMPTY for cooling-pool → the snapshot fallback must supply the cooldown.
  const slot = selectProvider(packet, [cooling, healthy], tracker, {}, enabledSession());
  expect(slot !== null).toBeTruthy();
  expect(
    slot.poolId,
    "snapshot cooldown is the fallback when the live record is unavailable → still spill",
  ).toBe("healthy-pool");
});

test("selectProvider — all pools degraded still yields a slot; capability order applies within the fallback group (INV-QD-14)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 1.0 });
  const deep = makePool("deep-pool", { rank: "deep", quotaSourceSnapshot: { remaining_pct: 0.04 } });
  const small = makePool("small-pool", { rank: "small", quotaSourceSnapshot: { remaining_pct: 0.04 } });
  const tracker = new InFlightTokenTracker();
  // small-pool first in array; a degraded pool is a usable fallback, never a stall.
  const slot = selectProvider(packet, [small, deep], tracker, {}, enabledSession());
  expect(slot !== null, "a degraded pool is still a usable fallback — never a stall").toBeTruthy();
  expect(slot.poolId, "within the all-degraded group, high-complexity still prefers deep").toBe("deep-pool");
});

test("selectProvider — among healthy pools, capability still decides; health never overrides rank within a group (INV-QD-14)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 1.0 });
  const deep = makePool("deep-pool", { rank: "deep", quotaSourceSnapshot: { remaining_pct: 0.9 } });
  const small = makePool("small-pool", { rank: "small", quotaSourceSnapshot: { remaining_pct: 0.9 } });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [small, deep], tracker, {}, enabledSession());
  expect(slot !== null).toBeTruthy();
  expect(slot.poolId, "both healthy → high-complexity prefers deep (capability, not health, decides)").toBe("deep-pool");
});

// ---------------------------------------------------------------------------
// selectProvider — least-loaded balancing within an equal-rank tie
// (defect-1 sub-defect 2: deliberate multi-pool fan-out, even unbounded)
// ---------------------------------------------------------------------------

test("selectProvider — same-rank pools balance by in-flight load (least-loaded wins the tie)", async () => {
  const packet = makePacket("p1", { complexity: 0.5, estimatedTokens: 1000 });
  const poolA = makePool("pool-a");
  const poolB = makePool("pool-b");
  const tracker = new InFlightTokenTracker();
  // pool-a already carries in-flight load; the equal-rank tiebreak must route the next
  // packet to the LESS-loaded pool-b instead of front-loading pool-a (fan-out).
  tracker.recordDispatched("pool-a", 5000);
  const slot = selectProvider(packet, [poolA, poolB], tracker, {}, unlimitedSession());
  expect(slot.poolId, "load spreads to the least-loaded equal-rank pool").toBe("pool-b");
});

test("createRollingDispatcher — fans work across two equal UNBOUNDED pools, not front-loading one", async () => {
  await setupTmpQuotaDir();
  const usedPools = new Set();
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      usedPools.add(slot.poolId);
      return { packet, outcome: "success" };
    },
  });
  dispatcher.enqueue(Array.from({ length: 6 }, (_, i) => makePacket(`P${i}`)));
  const results = await dispatcher.run();
  expect(results.length).toBe(6);
  // Both equal pools do real work — the least-loaded tiebreak alternates same-rank
  // packets across pools rather than piling them all on the first (multi-pool fan-out).
  expect(usedPools.size, "both equal pools received dispatched work").toBe(2);
});

// ---------------------------------------------------------------------------
// Reactive cost verification (arbitrage increment 2)
// ---------------------------------------------------------------------------

describe("createRollingDispatcher — reactive cost verification (declared-free pool observed charging)", () => {
  it("demotes a declared-free pool that reports cost>0 and fires onCostDrift ONCE", async () => {
    await setupTmpQuotaDir();
    const drifts = [];
    const dispatcher = createRollingDispatcher({
      confirmedPools: [makePool("free-pool", { declaredCostPerMtok: 0 })],
      sessionConfig: unlimitedSession(),
      dispatchPacket: async (packet) => ({
        packet,
        outcome: "success",
        observedCostUsd: 0.02,
      }),
      onCostDrift: (info) => drifts.push(info),
    });
    // Two packets on the same free pool: the drift hook must still fire only once.
    dispatcher.enqueue([makePacket("p1"), makePacket("p2")]);
    const results = await dispatcher.run();

    expect(results.length, "both packets complete").toBe(2);
    const state = dispatcher.getState();
    expect(state.costDemotedPoolIds.has("free-pool"), "pool is cost-demoted").toBeTruthy();
    expect(drifts.length, "onCostDrift fires once per pool per drive").toBe(1);
    expect(drifts[0]).toEqual({
      poolId: "free-pool",
      observedCostUsd: 0.02,
      declaredCostPerMtok: 0,
    });
  });

  it("does NOT demote a declared-free pool that reports cost 0 (genuinely free)", async () => {
    await setupTmpQuotaDir();
    const drifts = [];
    const dispatcher = createRollingDispatcher({
      confirmedPools: [makePool("free-pool", { declaredCostPerMtok: 0 })],
      sessionConfig: unlimitedSession(),
      dispatchPacket: async (packet) => ({ packet, outcome: "success", observedCostUsd: 0 }),
      onCostDrift: (info) => drifts.push(info),
    });
    dispatcher.enqueue([makePacket("p1")]);
    await dispatcher.run();
    expect(dispatcher.getState().costDemotedPoolIds.has("free-pool")).toBe(false);
    expect(drifts.length).toBe(0);
  });

  it("does NOT demote a pool with no declared cost (host pool) even if it reports cost", async () => {
    await setupTmpQuotaDir();
    const drifts = [];
    const dispatcher = createRollingDispatcher({
      confirmedPools: [makePool("host-pool")], // declaredCostPerMtok undefined
      sessionConfig: unlimitedSession(),
      dispatchPacket: async (packet) => ({ packet, outcome: "success", observedCostUsd: 0.02 }),
      onCostDrift: (info) => drifts.push(info),
    });
    dispatcher.enqueue([makePacket("p1")]);
    await dispatcher.run();
    expect(dispatcher.getState().costDemotedPoolIds.has("host-pool")).toBe(false);
    expect(drifts.length).toBe(0);
  });

  it("does NOT demote a pool with a POSITIVE declared cost (only free→charging is in scope)", async () => {
    await setupTmpQuotaDir();
    const drifts = [];
    const dispatcher = createRollingDispatcher({
      confirmedPools: [makePool("paid-pool", { declaredCostPerMtok: 5 })],
      sessionConfig: unlimitedSession(),
      dispatchPacket: async (packet) => ({ packet, outcome: "success", observedCostUsd: 0.02 }),
      onCostDrift: (info) => drifts.push(info),
    });
    dispatcher.enqueue([makePacket("p1")]);
    await dispatcher.run();
    expect(dispatcher.getState().costDemotedPoolIds.has("paid-pool")).toBe(false);
    expect(drifts.length).toBe(0);
  });

  it("does NOT demote when the result carries no observedCostUsd (no signal)", async () => {
    await setupTmpQuotaDir();
    const drifts = [];
    const dispatcher = createRollingDispatcher({
      confirmedPools: [makePool("free-pool", { declaredCostPerMtok: 0 })],
      sessionConfig: unlimitedSession(),
      dispatchPacket: async (packet) => ({ packet, outcome: "success" }),
      onCostDrift: (info) => drifts.push(info),
    });
    dispatcher.enqueue([makePacket("p1")]);
    await dispatcher.run();
    expect(dispatcher.getState().costDemotedPoolIds.has("free-pool")).toBe(false);
    expect(drifts.length).toBe(0);
  });
});

test("selectProvider — a cost-demoted pool spills behind a healthy peer", async () => {
  // Two equal-rank pools; the free-pool would otherwise tie. Marked cost-demoted,
  // it is treated as degraded and spills to the fallback group behind the healthy
  // peer (quota management enabled so the health partition is active).
  const packet = makePacket("p1");
  const tracker = new InFlightTokenTracker();
  const freePool = makePool("free-pool", { declaredCostPerMtok: 0 });
  const healthy = makePool("healthy-pool");
  const slot = selectProvider(
    packet,
    [freePool, healthy],
    tracker,
    {},
    enabledSession(),
    new Set(),
    new Map(),
    new Set(["free-pool"]),
  );
  expect(slot !== null, "a surviving pool is selected").toBeTruthy();
  expect(slot.poolId, "cost-demoted free-pool spills behind the healthy peer").toBe("healthy-pool");
});

// ---------------------------------------------------------------------------
// scorePacketComplexity
// ---------------------------------------------------------------------------

test("scorePacketComplexity — returns packet.complexity field", () => {
  const packet = makePacket("p1", { complexity: 0.75 });
  expect(scorePacketComplexity(packet)).toBe(0.75);
});

