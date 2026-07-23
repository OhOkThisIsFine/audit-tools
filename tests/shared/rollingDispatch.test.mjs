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

const { deriveAccountKey } = await import("../../src/shared/quota/accountId.ts");

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
  // Mirror buildSourcePool: the account partition is the wire-carried accountKey, derived
  // from the source declaration (service-scoped), falling back to the unique pool id when
  // unattributable. Fixtures that omit it would otherwise all share `undefined` and fold
  // as one account — the exact over-gating the cooldown fold must not do.
  const derivedAccountKey = overrides.source ? deriveAccountKey(overrides.source) : null;
  return {
    id,
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
    accountKey: derivedAccountKey ?? id,
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
// Zero-spill capability-floor regression (backlog HIGH, re-dogfood 2026-07-22):
// the floor's "most capable band available" must track LIVE availability. A
// build-time snapshot held the floor at the exhausted best pool's band, so a
// deep-tier packet failed `capable` on every surviving lower-band sibling and
// ~140 packets stranded as `no_fitting_pool` with 5 healthy confirmed pools
// never attempted.
// ---------------------------------------------------------------------------

test("createRollingDispatcher — the capability floor RELAXES to surviving pools when the best-band pool exhausts (zero-spill fix)", async () => {
  await setupTmpQuotaDir();
  const attemptsByPool = { strong: 0, weak: 0 };

  const dispatcher = createRollingDispatcher({
    confirmedPools: [
      // Two SCORED pools → terciles put `strong` in band 0, `weak` in band 1.
      // A `deep` packet's floor is band 0 while strong is available.
      makePool("strong", { rank: "deep", declaredCapabilityRank: 1 }),
      makePool("weak", { rank: "small", declaredCapabilityRank: 9 }),
    ],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      attemptsByPool[slot.poolId] = (attemptsByPool[slot.poolId] ?? 0) + 1;
      if (slot.poolId === "strong") {
        return { packet, outcome: "rate_limited" }; // bare 429 → permanent exclusion
      }
      return { packet, outcome: "success" };
    },
  });

  const p = { ...makePacket("p1"), requiredTier: "deep" };
  dispatcher.enqueue([p]);
  const results = await dispatcher.run();

  // The packet lands on the surviving lower-band pool — never stranded. Under
  // the pre-fix static snapshot this run returned 0 results with an empty_pool
  // terminal and `weak` was never attempted.
  expect(results.length, "packet completes on the surviving pool").toBe(1);
  expect(results[0].outcome).toBe("success");
  expect(attemptsByPool.strong >= 1, "best pool attempted first").toBeTruthy();
  expect(attemptsByPool.weak >= 1, "surviving sibling IS attempted after exhaustion").toBeTruthy();
  expect(dispatcher.getTerminal(), "no strand terminal").toBe(null);
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
// Quota-unclassified (Slice A2b / backlog HIGH 2026-07-11) — TIER 2 of the
// three-tier classifier: a worker death whose text was quota-SUSPICIOUS (the
// broad pre-filter matched) but classified as NEITHER precise class. Must
// degrade CONSERVATIVELY: re-queue with a reversible cooldown, and — critically
// unlike credit_exhausted — the pool is NEVER added to exhaustedPoolIds.
// ---------------------------------------------------------------------------

test("createRollingDispatcher — quota_unclassified result re-queues the packet to a surviving pool WITHOUT permanently excluding the dying pool", async () => {
  await setupTmpQuotaDir();
  const { readQuotaState } = await import("../../src/shared/quota/state.ts");
  const attemptsByPool = { "pool-a": 0, "pool-b": 0 };

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      attemptsByPool[slot.poolId] = (attemptsByPool[slot.poolId] ?? 0) + 1;
      if (slot.poolId === "pool-a") {
        return {
          packet,
          outcome: "quota_unclassified",
          quotaUnclassified: { channel: "error", text: "unrecognized billing rejection" },
        };
      }
      return { packet, outcome: "success" };
    },
  });

  dispatcher.enqueue([makePacket("p1"), makePacket("p2")]);
  const results = await dispatcher.run();

  expect(results.length, "both packets complete after re-route").toBe(2);
  expect(results.every((r) => r.outcome === "success")).toBeTruthy();
  expect(attemptsByPool["pool-a"]).toBe(1);
  expect(attemptsByPool["pool-b"] >= 2).toBeTruthy();
  expect(dispatcher.getTerminal()).toBe(null);

  const state = dispatcher.getState();
  expect(
    state.exhaustedPoolIds.has("pool-a"),
    "quota_unclassified must NEVER add the pool to the permanent exclusion set",
  ).toBe(false);
  // Instead, a REVERSIBLE in-memory pause (piece D mechanism) bounds this run's
  // retries against the dying pool without ever excluding it.
  expect(state.pausedPoolResetAt.has("pool-a"), "reversible pause, not exclusion").toBe(true);

  // The conservative degrade also recorded a real, reversible, timed cooldown
  // in the PERSISTED quota state (never silent, never permanent).
  const quotaState = await readQuotaState();
  expect(quotaState.entries["pool-a"]?.cooldown_until, "reversible cooldown recorded").not.toBe(null);
});

test("createRollingDispatcher — fires onQuotaUnclassified once per pool with poolId + verbatim text", async () => {
  await setupTmpQuotaDir();
  const harvested = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      if (slot.poolId === "pool-a") {
        return {
          packet,
          outcome: "quota_unclassified",
          quotaUnclassified: { channel: "error", text: "mystery quota-shaped rejection" },
        };
      }
      return { packet, outcome: "success" };
    },
    onQuotaUnclassified: (info) => harvested.push(info),
  });

  dispatcher.enqueue([makePacket("p1"), makePacket("p2")]);
  await dispatcher.run();

  // pool-a is paused (not excluded) after its first quota_unclassified, so p2
  // never re-hits it within this run — the harvest hook fires exactly once.
  expect(harvested.length, "onQuotaUnclassified fires once per pool").toBe(1);
  expect(harvested[0]).toEqual({ poolId: "pool-a", text: "mystery quota-shaped rejection" });
});

test("createRollingDispatcher — onQuotaUnclassified is NOT fired for credit_exhausted or rate_limited results (classes stay disjoint)", async () => {
  await setupTmpQuotaDir();
  const harvested = [];
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b"), makePool("pool-c")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      if (slot.poolId === "pool-a") {
        return { packet, outcome: "credit_exhausted", creditExhaustion: { channel: "error", text: "out of credits", rawMatch: "out of credits" } };
      }
      if (slot.poolId === "pool-b") {
        return { packet, outcome: "rate_limited" };
      }
      return { packet, outcome: "success" };
    },
    onQuotaUnclassified: (info) => harvested.push(info),
  });
  dispatcher.enqueue([makePacket("p1")]);
  await dispatcher.run();
  expect(harvested.length).toBe(0);
});

test("createRollingDispatcher — when the only pool repeatedly quota_unclassifies, the run resolves via a RETRYABLE quota_paused strand (bounded, never a livelock, pool never excluded)", async () => {
  await setupTmpQuotaDir();
  let attempts = 0;
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("only-pool")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => {
      attempts++;
      return {
        packet,
        outcome: "quota_unclassified",
        quotaUnclassified: { channel: "error", text: "persistent unrecognized quota rejection" },
      };
    },
  });

  dispatcher.enqueue([makePacket("p1")]);
  // Bound the wait: with only ONE pool and no exclusion mechanism, the
  // reversible in-memory pause is what stops the engine from spinning forever
  // re-selecting the same dying pool — assert run() resolves promptly rather
  // than hanging or busy-looping.
  const results = await Promise.race([
    dispatcher.run(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("dispatcher.run() did not resolve — livelock")), 5000)),
  ]);

  // Never lands (the sole pool always quota_unclassifies) — no completion
  // result — but the pool was attempted exactly ONCE (paused immediately after,
  // never re-selected in a tight loop) and never permanently excluded.
  expect(results.length).toBe(0);
  expect(attempts, "attempted once, then paused (not re-selected in a spin loop)").toBe(1);

  const state = dispatcher.getState();
  expect(state.exhaustedPoolIds.has("only-pool"), "never permanently excluded").toBe(false);
  expect(state.pausedPoolResetAt.has("only-pool"), "reversibly paused").toBe(true);

  const terminal = dispatcher.getTerminal();
  expect(terminal !== null, "stranded work surfaces a terminal").toBeTruthy();
  // RETRYABLE quota_paused (not the non-retryable empty_pool credit_exhausted
  // hits) — this reflects that the degrade is reversible, not permanent.
  expect(terminal.reason).toBe("quota_paused");
  expect(terminal.stranded_ids).toEqual(["p1"]);
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
    new Map(), // oversizedPacketPools
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
    new Map(), // oversizedPacketPools
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

test("selectProvider — the DEFAULT capability floor tracks the exhausted set (standalone zero-spill)", async () => {
  await setupTmpQuotaDir();
  // A `deep` packet with the band-0 pool exhausted: the default (caller-built)
  // floor must relax to the surviving band-1 pool exactly like the dispatcher's
  // own instance — a static default floor returned null here (codex review
  // finding, 2026-07-23).
  const packet = { ...makePacket("p1", { complexity: 1.0 }), requiredTier: "deep" };
  const strong = makePool("strong", { rank: "deep", declaredCapabilityRank: 1 });
  const weak = makePool("weak", { rank: "small", declaredCapabilityRank: 9 });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(
    packet,
    [strong, weak],
    tracker,
    {},
    unlimitedSession(),
    new Set(["strong"]),
  );
  expect(slot !== null, "the surviving below-band pool must be selectable").toBeTruthy();
  expect(slot.poolId).toBe("weak");
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
  // degraded-pool has only 100 tokens left — it cannot fund the 1000-token packet, so
  // its derived remaining budget is below the packet cost → hard-degraded (token-native,
  // no percentage cliff). healthy-pool has ample tokens.
  const degraded = makePool("degraded-pool", {
    quotaSourceSnapshot: { remaining_pct: 0.05, tokens_remaining: 100 },
  });
  const healthy = makePool("healthy-pool", {
    quotaSourceSnapshot: { remaining_pct: 0.95, tokens_remaining: 1_000_000 },
  });
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
  // Both pools have only 100 tokens left — neither can fund the 1000-token packet, so
  // both are hard-degraded (all-degraded fallback group).
  const deep = makePool("deep-pool", {
    rank: "deep",
    quotaSourceSnapshot: { remaining_pct: 0.04, tokens_remaining: 100 },
  });
  const small = makePool("small-pool", {
    rank: "small",
    quotaSourceSnapshot: { remaining_pct: 0.04, tokens_remaining: 100 },
  });
  const tracker = new InFlightTokenTracker();
  // small-pool first in array; a degraded pool is a usable fallback, never a stall.
  const slot = selectProvider(packet, [small, deep], tracker, {}, enabledSession());
  expect(slot !== null, "a degraded pool is still a usable fallback — never a stall").toBeTruthy();
  expect(slot.poolId, "within the all-degraded group, high-complexity still prefers deep").toBe("deep-pool");
});

test("selectProvider — a near-wall pool that can't fund the packet's tokens spills to a healthy peer of LOWER capability (INV-QD-14, token-native, reachable at requestedConcurrency:1)", async () => {
  await setupTmpQuotaDir();
  // Regression: the health signal must be reachable at the requestedConcurrency:1 the
  // selection path uses (the `binding_cap === "token_budget"` signal was NOT — it only
  // sets when the gate REDUCES a >1 wave). A high-complexity packet would normally
  // prefer the deep pool by capability, but the deep pool's remaining budget (100
  // tokens) can't fund the 1000-token packet → hard-degraded → load spills to the
  // lower-capability but healthy standard pool BEFORE a 429.
  const packet = makePacket("p1", { complexity: 0.9, estimatedTokens: 1000 });
  const nearWall = makePool("nearwall-deep", {
    rank: "deep",
    quotaSourceSnapshot: { remaining_pct: 0.05, tokens_remaining: 100 },
  });
  const healthy = makePool("healthy-standard", {
    rank: "standard",
    quotaSourceSnapshot: { remaining_pct: 0.9, tokens_remaining: 1_000_000 },
  });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [nearWall, healthy], tracker, {}, enabledSession());
  expect(slot !== null).toBeTruthy();
  expect(
    slot.poolId,
    "a near-wall pool that can't fund the packet is spilled even to a lower-capability healthy peer",
  ).toBe("healthy-standard");
});

test("selectProvider — a low remaining_pct pool that STILL holds enough tokens is NOT degraded (the retired percentage cliff is gone)", async () => {
  await setupTmpQuotaDir();
  // 4% remaining but 50k absolute tokens left — plenty to fund the 1000-token packet.
  // The retired `remaining_pct < 0.3` cliff would have WRONGLY spilled this off; the
  // token-native signal keeps the more-capable pool because it can actually fund the work.
  const packet = makePacket("p1", { complexity: 0.9, estimatedTokens: 1000 });
  const lowPctButFunded = makePool("lowpct-deep", {
    rank: "deep",
    quotaSourceSnapshot: { remaining_pct: 0.04, tokens_remaining: 50_000 },
  });
  const healthy = makePool("healthy-standard", {
    rank: "standard",
    quotaSourceSnapshot: { remaining_pct: 0.9, tokens_remaining: 1_000_000 },
  });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [lowPctButFunded, healthy], tracker, {}, enabledSession());
  expect(slot !== null).toBeTruthy();
  expect(
    slot.poolId,
    "low % but enough absolute tokens → still the most-capable pool (no percentage cliff)",
  ).toBe("lowpct-deep");
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
// selectProvider — account-axis cooldown fold (Bug 3 / Slice A3, backlog HIGH
// 2026-07-11): same-account openai-compatible/NIM sources (same endpoint +
// api_key_env) must share ONE reactive cooldown, so a 429 learned on one pool
// gates every sibling pool of that account — not just the pool whose own key
// recorded it.
// ---------------------------------------------------------------------------

test("selectProvider — a cooldown learned on one same-account source gates its sibling (Bug 3 account fold)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  // nim-nano and nim-super share ONE NVIDIA_API_KEY against the SAME endpoint —
  // the exact live-run shape (primary + nim-nano/nim-super/nim-kimi, backlog
  // 2026-07-11). Only nim-nano's OWN key recorded the learned cooldown.
  const nimNano = makePool("nim-nano", {
    source: {
      transport: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      api_key_env: "NVIDIA_API_KEY",
      model: "nano",
    },
  });
  const nimSuper = makePool("nim-super", {
    source: {
      transport: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      api_key_env: "NVIDIA_API_KEY",
      model: "super",
    },
  });
  // A pool on a genuinely different account — must stay eligible.
  const otherAccount = makePool("healthy-other-account", {
    source: {
      transport: "openai-compatible",
      endpoint: "https://other-endpoint.example/v1",
      api_key_env: "OTHER_KEY",
      model: "x",
    },
  });
  const tracker = new InFlightTokenTracker();
  const liveEntries = { "nim-nano": { cooldown_until: future } };
  const slot = selectProvider(
    packet,
    [nimNano, nimSuper, otherAccount],
    tracker,
    liveEntries,
    enabledSession(),
  );
  expect(slot !== null).toBeTruthy();
  expect(
    slot.poolId,
    "nim-super shares nim-nano's (endpoint, api_key_env) account — a cooldown on nim-nano must fold onto nim-super too, so both spill for the peer on a genuinely different account",
  ).toBe("healthy-other-account");
});

test("selectProvider — sources with DIFFERENT api_key_env stay independent (no over-gating)", async () => {
  await setupTmpQuotaDir();
  const packet = makePacket("p1", { complexity: 0.5 });
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const cooling = makePool("cooling-pool", {
    source: {
      transport: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      api_key_env: "NVIDIA_API_KEY_A",
      model: "m1",
    },
  });
  // Same endpoint, DIFFERENT api_key_env — a genuinely different account/key —
  // must NOT be gated by the sibling's cooldown.
  const independent = makePool("independent-pool", {
    source: {
      transport: "openai-compatible",
      endpoint: "https://integrate.api.nvidia.com/v1",
      api_key_env: "NVIDIA_API_KEY_B",
      model: "m2",
    },
  });
  const tracker = new InFlightTokenTracker();
  const liveEntries = { "cooling-pool": { cooldown_until: future } };
  const slot = selectProvider(
    packet,
    [cooling, independent],
    tracker,
    liveEntries,
    enabledSession(),
  );
  expect(slot !== null).toBeTruthy();
  expect(
    slot.poolId,
    "a different api_key_env is a different account — cooling-pool's cooldown must NOT fold onto independent-pool",
  ).toBe("independent-pool");
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


// ---------------------------------------------------------------------------
// packet_too_large — per-packet pool skip + all-pools-strand livelock guard
// (2026-07-17 gap-fix lap; RED pre-fix: an all-pools-413 packet re-queued
// forever because noPoolCanAcceptNow is pool-level and never fires for a
// per-packet condition)
// ---------------------------------------------------------------------------

test("createRollingDispatcher — packet_too_large on the ONLY pool strands the packet (never spins), pool stays usable for other packets", async () => {
  await setupTmpQuotaDir();
  const big = makePacket("p-big");
  const small = makePacket("p-small");
  const dispatched = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => {
      dispatched.push(packet.id);
      if (packet.id === "p-big") {
        return {
          packet,
          outcome: "packet_too_large",
          packetTooLarge: { channel: "status", text: "Request too large (max 32MB).", rawMatch: "Request too large" },
        };
      }
      return { packet, outcome: "success" };
    },
  });

  dispatcher.enqueue([big, small]);
  const results = await dispatcher.run();

  // p-big was dispatched exactly once (no infinite re-queue spin), p-small succeeded.
  expect(dispatched.filter((id) => id === "p-big").length).toBe(1);
  const smallResult = results.find((r) => r.packet.id === "p-small");
  expect(smallResult?.outcome).toBe("success");
});

test("createRollingDispatcher — packet_too_large with a SECOND pool re-queues and succeeds there; hook fires with the pair", async () => {
  await setupTmpQuotaDir();
  const pkt = makePacket("p-413");
  const attempts = [];
  const hookCalls = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a"), makePool("pool-b")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      attempts.push(slot.poolId);
      if (slot.poolId === "pool-a") {
        return {
          packet,
          outcome: "packet_too_large",
          packetTooLarge: { channel: "status", text: "HTTP 413", rawMatch: "413" },
        };
      }
      return { packet, outcome: "success" };
    },
    onPacketTooLarge: (info) => hookCalls.push(info),
  });

  dispatcher.enqueue([pkt]);
  const results = await dispatcher.run();

  const finalResult = results.find((r) => r.packet.id === "p-413" && r.outcome === "success");
  expect(finalResult, "packet retried on the second pool and succeeded").toBeTruthy();
  expect(attempts.includes("pool-b"), "second pool attempted").toBeTruthy();
  expect(hookCalls.length).toBe(1);
  expect(hookCalls[0]).toMatchObject({ poolId: "pool-a", packetId: "p-413" });
});

test("createRollingDispatcher — model_unavailable excludes the pool for the run and fires the hook once", async () => {
  await setupTmpQuotaDir();
  const p1 = makePacket("p-1");
  const p2 = makePacket("p-2");
  const hookCalls = [];
  const attempts = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-404"), makePool("pool-ok")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      attempts.push([packet.id, slot.poolId]);
      if (slot.poolId === "pool-404") {
        return {
          packet,
          outcome: "model_unavailable",
          modelUnavailable: { channel: "status", text: "It may not exist", rawMatch: "may not exist" },
        };
      }
      return { packet, outcome: "success" };
    },
    onModelUnavailable: (info) => hookCalls.push(info),
  });

  dispatcher.enqueue([p1, p2]);
  const results = await dispatcher.run();

  const successes = results.filter((r) => r.outcome === "success");
  expect(successes.length, "both packets eventually succeed on the surviving pool").toBe(2);
  expect(hookCalls.length, "hook fires once per pool, not per packet").toBe(1);
  expect(hookCalls[0].poolId).toBe("pool-404");
  const attemptsOn404After = attempts.filter(([, poolId]) => poolId === "pool-404");
  expect(attemptsOn404After.length <= 2, "excluded pool never re-attempted after exclusion").toBeTruthy();
});

test("createRollingDispatcher — a packet that fits NO pool's declared context cap strands loud instead of spinning (never-dispatchable guard)", async () => {
  await setupTmpQuotaDir();
  // 30k cap; packet 20k + 15k harness overhead = 35k > cap → permanently unselectable.
  const big = { ...makePacket("p-nofit"), estimatedTokens: 20_000 };
  const small = makePacket("p-fits");
  const dispatched = [];

  const dispatcher = createRollingDispatcher({
    confirmedPools: [{ ...makePool("pool-capped"), contextCapTokens: 30_000 }],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => {
      dispatched.push(packet.id);
      return { packet, outcome: "success" };
    },
  });

  dispatcher.enqueue([big, small]);
  const results = await dispatcher.run();

  expect(dispatched, "only the fitting packet dispatches").toEqual(["p-fits"]);
  expect(results.length).toBe(1);
  const terminal = dispatcher.getTerminal();
  expect(terminal, "stranded packet surfaces via the terminal").toBeTruthy();
  expect(terminal.stranded_ids).toContain("p-nofit");
});

// ---------------------------------------------------------------------------
// Capability floor (F4) — enforced at packet→pool selection
//
// The floor previously lived only in the host-path admission contract; the
// engine selected by preference order alone, so a low-complexity deep-floor
// packet landed on the LEAST-capable pool. These are red on that HEAD
// semantics: selection (not a contract file) must refuse the incapable pool.
// ---------------------------------------------------------------------------

test("selectProvider — a floor-carrying packet is never bound to a pool below its capability floor (F4)", async () => {
  await setupTmpQuotaDir();
  // complexity 0.2 → the preference order alone picks the LEAST-capable pool,
  // which is exactly the pool the deep floor must exclude (red on HEAD).
  const packet = { ...makePacket("p1", { complexity: 0.2 }), requiredTier: "deep" };
  const deep = makePool("deep-pool", { rank: "deep" });
  const small = makePool("small-pool", { rank: "small" });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [deep, small], tracker, {}, unlimitedSession());
  expect(slot !== null).toBeTruthy();
  expect(
    slot.poolId,
    "a deep-floor packet must never select the bottom-band pool, whatever the preference order says",
  ).toBe("deep-pool");
});

test("selectProvider — the floor is RELATIVE: an all-bottom-band pool set stays eligible (never fail-closed)", async () => {
  await setupTmpQuotaDir();
  const packet = { ...makePacket("p1", { complexity: 0.2 }), requiredTier: "deep" };
  const small = makePool("small-pool", { rank: "small" });
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [small], tracker, {}, unlimitedSession());
  expect(slot !== null, "deep means 'most capable band AVAILABLE' — never an empty set").toBeTruthy();
  expect(slot.poolId).toBe("small-pool");
});

test("selectProvider — unknown capability fails OPEN: rank-less pools stay eligible for a floor-carrying packet (F4)", async () => {
  await setupTmpQuotaDir();
  const packet = { ...makePacket("p1", { complexity: 0.2 }), requiredTier: "deep" };
  // No `rank`, no declared capability score anywhere — the floor has no signal and
  // must never block (a fail-closed regression here would strand every floored
  // packet on capability-blind pool sets, e.g. LiteLLM-fronted pools).
  const blindA = makePool("blind-a");
  const blindB = makePool("blind-b");
  const tracker = new InFlightTokenTracker();
  const slot = selectProvider(packet, [blindA, blindB], tracker, {}, unlimitedSession());
  expect(slot !== null, "unknown capability is never a refusal").toBeTruthy();
});

test("createRollingDispatcher — an engine drive dispatches a floor-carrying packet only to the capable pool (F4)", async () => {
  await setupTmpQuotaDir();
  const seen = [];
  const dispatcher = createRollingDispatcher({
    confirmedPools: [
      makePool("deep-pool", { rank: "deep" }),
      makePool("small-pool", { rank: "small" }),
    ],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      seen.push(slot.poolId);
      return { packet, outcome: "success" };
    },
  });
  dispatcher.enqueue([{ ...makePacket("p1", { complexity: 0.2 }), requiredTier: "deep" }]);
  const results = await dispatcher.run();
  expect(results.length).toBe(1);
  expect(results[0].outcome).toBe("success");
  expect(seen, "the packet must be DISPATCHED to the capable pool only").toEqual(["deep-pool"]);
});

test("createRollingDispatcher — when the only above-floor pool exhausts, the floor relaxes to the survivor BEFORE stranding (F4 liveness + zero-spill)", async () => {
  await setupTmpQuotaDir();
  // The deep pool rate-limits away. Pre-zero-spill, the floor stayed banded over
  // the FULL confirmed set, so the surviving small pool was never attempted and
  // the packet stranded with a healthy pool idle — the exact live incident. Now
  // the floor tracks availability: once deep exhausts, small is the most capable
  // band AVAILABLE, gets its attempt, and only when it too exhausts does the
  // packet strand via the terminal (never a wait-tick spin — liveness holds).
  const seen = [];
  const dispatcher = createRollingDispatcher({
    confirmedPools: [
      makePool("deep-pool", { rank: "deep" }),
      makePool("small-pool", { rank: "small" }),
    ],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet, slot) => {
      seen.push(slot.poolId);
      return { packet, outcome: "rate_limited" };
    },
  });
  dispatcher.enqueue([{ ...makePacket("p1", { complexity: 0.9 }), requiredTier: "deep" }]);
  const results = await dispatcher.run();
  expect(seen[0], "the above-floor pool is preferred while alive").toBe("deep-pool");
  expect(seen, "the surviving pool IS attempted once the floor's holder exhausts").toContain("small-pool");
  expect(results.filter((r) => r.outcome === "success").length).toBe(0);
  const terminal = dispatcher.getTerminal();
  expect(terminal, "stranding surfaces via the partial-completion terminal, never a spin").not.toBe(null);
  expect(terminal.stranded_ids).toEqual(["p1"]);
});

// ---------------------------------------------------------------------------
// Engine decision log (legibility, spec Resolved decision 3): every per-packet
// engine decision — admit, ledger block, strand — is emitted through the
// onAdmissionDecision seam as a stamped record. No decision path is silent.
// ---------------------------------------------------------------------------

test("decision log — an unmetered dispatch (no ledger) still records engine_admitted with lease_id null", async () => {
  await setupTmpQuotaDir();
  const records = [];
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => ({ packet, outcome: "success" }),
    onAdmissionDecision: (r) => records.push(r),
  });
  dispatcher.enqueue([makePacket("p1")]);
  await dispatcher.run();

  const admits = records.filter((r) => r.kind === "engine_admitted");
  expect(admits).toEqual([
    expect.objectContaining({
      kind: "engine_admitted",
      packet_id: "p1",
      pool_id: "pool-a",
      lease_id: null,
      forced: false,
      constraints: [],
      seq: 0,
    }),
  ]);
  expect(typeof admits[0].ts).toBe("string");
});

test("decision log — a ledger block records engine_blocked with the constraint outcomes, then the forced backstop admit records forced:true", async () => {
  const quotaDir = await setupTmpQuotaDir();
  const { ReservationLedger } = await import("../../src/shared/quota/reservationLedger.ts");
  const ledger = new ReservationLedger(join(quotaDir, "reservations.json"));
  const records = [];
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => ({ packet, outcome: "success" }),
    reservationLedger: ledger,
    // A budget far below the packet's cost, nothing outstanding anywhere → the
    // liveness backstop force-admits the first blocked packet per pass.
    resolvePoolConstraints: (poolId, tokens) => ({
      constraints: [{ resourceKey: poolId, budget: 10, cost: tokens }],
      unpriced: [],
    }),
    onAdmissionDecision: (r) => records.push(r),
  });
  dispatcher.enqueue([makePacket("p1", { estimatedTokens: 5000 })]);
  await dispatcher.run();

  const kinds = records.map((r) => r.kind);
  expect(kinds).toEqual(["engine_blocked", "engine_admitted"]);
  expect(records[0]).toEqual(
    expect.objectContaining({
      packet_id: "p1",
      pool_id: "pool-a",
      reason: "budget_exhausted",
      any_outstanding: false,
      constraints: [
        expect.objectContaining({ resource_key: "pool-a", cleared: false, cost: 5000 }),
      ],
      binding: expect.objectContaining({ resource_key: "pool-a", cleared: false }),
    }),
  );
  expect(records[1]).toEqual(
    expect.objectContaining({
      packet_id: "p1",
      forced: true,
      constraints: [expect.objectContaining({ cleared: true })],
    }),
  );
  expect(records[1].lease_id).not.toBe(null);
  // seq is per-dispatcher monotonic — the authoritative timeline order.
  expect(records.map((r) => r.seq)).toEqual([0, 1]);
});

test("decision log — a never-dispatchable strand records the per-(packet, pool) why-not (context_cap)", async () => {
  await setupTmpQuotaDir();
  const records = [];
  const dispatcher = createRollingDispatcher({
    // Declared context cap far below the packet: fit-excluded on every pool —
    // the per-packet never-dispatchable strand, not the pool-wall one.
    confirmedPools: [makePool("tiny-pool", { contextCapTokens: 1000 })],
    sessionConfig: unlimitedSession(),
    dispatchPacket: async (packet) => ({ packet, outcome: "success" }),
    onAdmissionDecision: (r) => records.push(r),
  });
  dispatcher.enqueue([makePacket("huge", { estimatedTokens: 500000 })]);
  await dispatcher.run();

  expect(dispatcher.getState().strandedIds.has("huge")).toBe(true);
  const strands = records.filter((r) => r.kind === "engine_stranded_no_fitting_pool");
  expect(strands).toEqual([
    expect.objectContaining({
      packets: [
        {
          packet_id: "huge",
          pools: [{ pool_id: "tiny-pool", why: "context_cap" }],
        },
      ],
    }),
  ]);
});

test("decision log — identical re-blocks across passes are transition-deduped; the transition and the forced backstop still record (host-review F1/F3)", async () => {
  const quotaDir = await setupTmpQuotaDir();
  const { ReservationLedger } = await import("../../src/shared/quota/reservationLedger.ts");
  const ledger = new ReservationLedger(join(quotaDir, "reservations.json"));
  const records = [];
  // Two slow packets hold leases; the huge packet re-blocks IDENTICALLY on the
  // pass after the first completion (still outstanding) — that repeat must be
  // suppressed. After the second completion the block transitions to
  // any_outstanding:false, which records, and the forced backstop admits.
  const resolvers = new Map();
  const dispatcher = createRollingDispatcher({
    confirmedPools: [makePool("pool-a")],
    sessionConfig: unlimitedSession(),
    dispatchPacket: (packet) =>
      packet.id === "huge"
        ? Promise.resolve({ packet, outcome: "success" })
        : new Promise((resolve) => resolvers.set(packet.id, () => resolve({ packet, outcome: "success" }))),
    reservationLedger: ledger,
    resolvePoolConstraints: (poolId, tokens) => ({
      constraints: [{ resourceKey: poolId, budget: 100, cost: tokens }],
      unpriced: [],
    }),
    onAdmissionDecision: (r) => {
      records.push(r);
      // Release the slow packets one per pass, AFTER the pass that re-blocks
      // "huge" has run (each blocked/admitted record marks a pass boundary).
      const next = [...resolvers.keys()][0];
      if (next) {
        resolvers.get(next)();
        resolvers.delete(next);
      }
    },
  });
  dispatcher.enqueue([
    makePacket("slow-1", { estimatedTokens: 40 }),
    makePacket("slow-2", { estimatedTokens: 40 }),
    makePacket("huge", { estimatedTokens: 200 }),
  ]);
  await dispatcher.run();

  const hugeBlocked = records.filter((r) => r.kind === "engine_blocked" && r.packet_id === "huge");
  // Exactly TWO blocked records for "huge": the initial any_outstanding:true
  // (its identical repeat on the next pass suppressed) and the
  // any_outstanding:false transition. Then the forced backstop admits.
  expect(hugeBlocked.map((r) => r.any_outstanding)).toEqual([true, false]);
  const hugeAdmits = records.filter((r) => r.kind === "engine_admitted" && r.packet_id === "huge");
  expect(hugeAdmits.length).toBe(1);
  expect(hugeAdmits[0].forced).toBe(true);
});
