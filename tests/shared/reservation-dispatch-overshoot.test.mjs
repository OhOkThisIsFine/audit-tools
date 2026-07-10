import { test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

// Wiring test for the reservation-ledger admission layer in the rolling dispatch
// engine (spec/audit/dispatch-admission-control.md). Exercises the spec's central
// validation criterion: two CO-LOCATED dispatch loops sharing one account budget
// (same ledger file, same `provider#account/model` resourceKey) never collectively
// exceed that budget — no 429-storm from independent optimistic estimates.

const { createRollingDispatcher } = await import(
  "../../src/shared/dispatch/rollingDispatch.ts"
);
const { ReservationLedger } = await import(
  "../../src/shared/quota/reservationLedger.ts"
);
const { setQuotaStateDir } = await import("../../src/shared/quota/state.ts");

function makePool(id = "pool-shared") {
  return {
    id,
    providerName: "claude-code",
    hostModel: null,
    hostConcurrencyLimit: null,
    quotaStateEntry: null,
    discoveredLimits: null,
    quotaSourceSnapshot: null,
  };
}

// Quota disabled → slot scheduling never throttles, so the reservation ledger is
// the SOLE admission gate under test (isolates the new behaviour).
function unlimitedSession() {
  return { quota: {} };
}

function makePacket(id, estimatedTokens) {
  return { id, payload: { id }, estimatedTokens, complexity: 0.5 };
}

async function tmpQuotaDir() {
  const dir = await mkdtemp(join(tmpdir(), "reservation-dispatch-"));
  setQuotaStateDir(dir);
  return dir;
}

// Shared in-flight token meter across BOTH co-located loops, recording the peak
// simultaneous reservation. The whole point of the ledger is that this peak stays
// within the shared budget even though the two loops never see each other's state
// except through the ledger file.
function sharedMeter() {
  const m = { inFlight: 0, peak: 0 };
  return {
    dispatchPacket(cost, delayMs = 15) {
      return async (packet) => {
        m.inFlight += cost;
        m.peak = Math.max(m.peak, m.inFlight);
        await new Promise((r) => setTimeout(r, delayMs));
        m.inFlight -= cost;
        return { packet, outcome: "success", actualTokens: cost };
      };
    },
    meter: m,
  };
}

test("two co-located dispatchers over one ledger never exceed the shared account budget", async () => {
  const quotaDir = await tmpQuotaDir();
  const ledgerPath = join(quotaDir, "reservation-ledger.json");
  const BUDGET = 100;
  const COST = 60; // COST <= BUDGET < 2*COST → at most one in flight across BOTH loops

  const { dispatchPacket, meter } = sharedMeter();

  // Two SEPARATE ledger instances pointing at the SAME file — the real co-located
  // scenario (two processes/loops), coordinating only through the locked file.
  const ledgerA = new ReservationLedger(ledgerPath);
  const ledgerB = new ReservationLedger(ledgerPath);

  const mkDispatcher = (prefix, ledger) => {
    const d = createRollingDispatcher({
      confirmedPools: [makePool()],
      sessionConfig: unlimitedSession(),
      dispatchPacket: dispatchPacket(COST),
      reservationLedger: ledger,
      resolvePoolBudget: () => BUDGET,
    });
    d.enqueue([
      makePacket(`${prefix}-1`, COST),
      makePacket(`${prefix}-2`, COST),
      makePacket(`${prefix}-3`, COST),
    ]);
    return d;
  };

  const a = mkDispatcher("a", ledgerA);
  const b = mkDispatcher("b", ledgerB);

  const [resA, resB] = await Promise.all([a.run(), b.run()]);

  // All six packets completed successfully...
  expect(resA.length).toBe(3);
  expect(resB.length).toBe(3);
  expect([...resA, ...resB].every((r) => r.outcome === "success")).toBe(true);

  // ...and the combined in-flight reservation never breached the shared budget.
  expect(meter.peak).toBeLessThanOrEqual(BUDGET);
});

test("liveness: a single packet whose cost exceeds the whole budget still runs (no deadlock)", async () => {
  const quotaDir = await tmpQuotaDir();
  const ledgerPath = join(quotaDir, "reservation-ledger.json");

  const { dispatchPacket, meter } = sharedMeter();
  const ledger = new ReservationLedger(ledgerPath);

  const d = createRollingDispatcher({
    confirmedPools: [makePool()],
    sessionConfig: unlimitedSession(),
    dispatchPacket: dispatchPacket(500),
    reservationLedger: ledger,
    resolvePoolBudget: () => 100, // packet cost 500 >> budget 100
  });
  d.enqueue([makePacket("oversized", 500)]);

  const results = await d.run();
  expect(results.length).toBe(1);
  expect(results[0].outcome).toBe("success");
  expect(meter.peak).toBe(500);
});

test("output-envelope reservation is counted in the admission cost", async () => {
  const quotaDir = await tmpQuotaDir();
  const ledgerPath = join(quotaDir, "reservation-ledger.json");

  // Two packets each with input estimate 40 (both fit in budget 100 on input
  // alone: 40+40=80 <= 100). A 40-token output envelope pushes each to cost 80, so
  // 80+80=160 > 100 and they MUST serialize — proving the envelope is in the cost.
  const { dispatchPacket, meter } = sharedMeter();
  const ledger = new ReservationLedger(ledgerPath);

  const d = createRollingDispatcher({
    confirmedPools: [makePool()],
    sessionConfig: unlimitedSession(),
    // The meter charges the FULL reserved cost (input + envelope) = 80 per packet.
    dispatchPacket: dispatchPacket(80),
    reservationLedger: ledger,
    resolvePoolBudget: () => 100,
    resolveOutputReservation: () => 40,
  });
  d.enqueue([makePacket("p1", 40), makePacket("p2", 40)]);

  const results = await d.run();
  expect(results.length).toBe(2);
  // Serialized by the envelope-inflated cost → peak is a single packet's 80, not 160.
  expect(meter.peak).toBeLessThanOrEqual(100);
  expect(meter.peak).toBe(80);
});

test("no ledger configured → dispatch is unchanged (additive path is inert)", async () => {
  await tmpQuotaDir();
  const { dispatchPacket, meter } = sharedMeter();

  const d = createRollingDispatcher({
    confirmedPools: [makePool()],
    sessionConfig: unlimitedSession(),
    dispatchPacket: dispatchPacket(1000, 5),
    // no reservationLedger
  });
  d.enqueue([makePacket("a", 1000), makePacket("b", 1000), makePacket("c", 1000)]);

  const results = await d.run();
  expect(results.length).toBe(3);
  // With no ledger and unlimited quota, all three dispatch concurrently.
  expect(meter.peak).toBe(3000);
});

