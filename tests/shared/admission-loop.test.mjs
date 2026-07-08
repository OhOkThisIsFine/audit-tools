import { test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

const { admitBatch, DispatchAdmissionSchema } = await import(
  "../../src/shared/dispatch/admissionLoop.ts"
);
const { ReservationLedger } = await import(
  "../../src/shared/quota/reservationLedger.ts"
);

async function freshLedger() {
  const dir = await mkdtemp(join(tmpdir(), "admission-loop-"));
  return new ReservationLedger(join(dir, "reservations.json"));
}

function pkt(id, cost, complexity = 0.5) {
  return { id, cost, complexity };
}

function pool(
  poolId,
  {
    budget = Infinity,
    declaredCap = null,
    costRank = 0,
    capabilityRank = 0,
    throughputScore = Infinity,
    capacityTokens = Infinity,
  } = {},
) {
  return {
    poolId,
    resourceKey: poolId,
    budget,
    declaredCap,
    costRank,
    capabilityRank,
    throughputScore,
    capacityTokens,
  };
}

test("cost-first routing: the cheapest capable pool fills before pricier ones", async () => {
  const ledger = await freshLedger();
  // cheap pool budget only fits 2 packets (2000), pricey pool fits the rest.
  const cheap = pool("cheap#a/m", { budget: 2000, costRank: 0, capabilityRank: 0 });
  const pricey = pool("deep#a/m", { budget: 10000, costRank: 2, capabilityRank: 2 });
  const packets = [pkt("p1", 1000), pkt("p2", 1000), pkt("p3", 1000)];

  const res = await admitBatch({ packets, pools: [pricey, cheap], ledger });

  expect(res.granted.length).toBe(3);
  // p1, p2 → cheap (fills its 2000 budget); p3 spills to pricey.
  const byPacket = Object.fromEntries(res.granted.map((g) => [g.packet_id, g.pool_id]));
  expect(byPacket.p1).toBe("cheap#a/m");
  expect(byPacket.p2).toBe("cheap#a/m");
  expect(byPacket.p3).toBe("deep#a/m");
  expect(res.blocked.length).toBe(0);
});

test("capability gate: a packet too large for the cheap pool routes to the capable pool", async () => {
  const ledger = await freshLedger();
  const cheapSmall = pool("small#a/m", { costRank: 0, capabilityRank: 0, capacityTokens: 1500 });
  const deepBig = pool("deep#a/m", { costRank: 2, capabilityRank: 2, capacityTokens: 100000 });
  // p1 fits both → cheapest. p2 (5000) exceeds small's window → only deep is capable.
  const res = await admitBatch({
    packets: [pkt("p1", 1000), pkt("p2", 5000)],
    pools: [cheapSmall, deepBig],
    ledger,
  });
  const byPacket = Object.fromEntries(res.granted.map((g) => [g.packet_id, g.pool_id]));
  expect(byPacket.p1).toBe("small#a/m");
  expect(byPacket.p2).toBe("deep#a/m");
});

test("declared in-flight cap limits a pool by COUNT; overflow spills to the next pool", async () => {
  const ledger = await freshLedger();
  const capped = pool("codex#a/m", { costRank: 0, capabilityRank: 1, declaredCap: 2 });
  const fallback = pool("host#a/m", { costRank: 1, capabilityRank: 1 });
  const res = await admitBatch({
    packets: [pkt("p1", 100), pkt("p2", 100), pkt("p3", 100), pkt("p4", 100)],
    pools: [capped, fallback],
    ledger,
  });
  const counts = res.granted.reduce((m, g) => ((m[g.pool_id] = (m[g.pool_id] ?? 0) + 1), m), {});
  expect(counts["codex#a/m"]).toBe(2); // capped at declaredCap
  expect(counts["host#a/m"]).toBe(2); // overflow
  expect(res.granted.length).toBe(4);
});

test("no capable pool → packet blocked with a no_capable_pool explain", async () => {
  const ledger = await freshLedger();
  const tiny = pool("tiny#a/m", { capacityTokens: 500 });
  const res = await admitBatch({ packets: [pkt("big", 9000)], pools: [tiny], ledger });
  expect(res.granted.length).toBe(0);
  expect(res.blocked).toEqual(["big"]);
  const ex = res.explains.find((e) => e.packet_id === "big");
  expect(ex.admitted).toBe(false);
  expect(ex.reason).toBe("no_capable_pool");
  expect(ex.pool_id).toBe(null);
});

test("budget exhaustion blocks the remainder (deferred to a later grant)", async () => {
  const ledger = await freshLedger();
  const only = pool("only#a/m", { budget: 1500 });
  const res = await admitBatch({
    packets: [pkt("p1", 1000), pkt("p2", 1000)],
    pools: [only],
    ledger,
  });
  expect(res.granted.length).toBe(1); // 1000 ≤ 1500; second (2000) exceeds
  expect(res.blocked).toEqual(["p2"]);
  const ex = res.explains.find((e) => e.packet_id === "p2");
  expect(ex.reason).toBe("budget_exhausted");
});

test("grants persist as ledger leases and the artifact shape validates", async () => {
  const ledger = await freshLedger();
  const res = await admitBatch({
    packets: [pkt("p1", 100), pkt("p2", 100)],
    pools: [pool("host#a/m")],
    ledger,
  });
  // Leases are live in the shared ledger until reconciled at ingest.
  const snap = await ledger.snapshot();
  const leaseCount = Object.values(snap).reduce((n, arr) => n + arr.length, 0);
  expect(leaseCount).toBe(2);

  const admission = {
    granted_packet_ids: res.granted.map((g) => g.packet_id),
    declared_cap: null,
    leases: res.granted,
    explains: res.explains,
  };
  expect(() => DispatchAdmissionSchema.parse(admission)).not.toThrow();
});

// ── Cost↔speed dispatch dial (spec/dispatch-cost-speed-dial.md) ──────────────

test("dial λ=0 (default) ignores throughput — the cheapest pool wins even when slowest", async () => {
  const ledger = await freshLedger();
  const cheapSlow = pool("cheap#a/m", { costRank: 0, throughputScore: 1000 });
  const priceyFast = pool("fast#a/m", { costRank: 2, throughputScore: 100000 });
  const res = await admitBatch({ packets: [pkt("p1", 100)], pools: [priceyFast, cheapSlow], ledger });
  expect(res.granted[0].pool_id).toBe("cheap#a/m");
});

test("dial λ=1 (max speed) routes to the fastest capable pool, not the cheapest", async () => {
  const ledger = await freshLedger();
  const cheapSlow = pool("cheap#a/m", { costRank: 0, throughputScore: 1000 });
  const priceyFast = pool("fast#a/m", { costRank: 2, throughputScore: 100000 });
  const res = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [cheapSlow, priceyFast],
    ledger,
    dispatchBias: 1,
  });
  expect(res.granted[0].pool_id).toBe("fast#a/m");
});

test("dial: an unmetered pool (throughput +Infinity) ranks fastest at λ=1", async () => {
  const ledger = await freshLedger();
  const metered = pool("metered#a/m", { costRank: 0, throughputScore: 500000 });
  const unmetered = pool("local#a/m", { costRank: 2, throughputScore: Infinity });
  const res = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [metered, unmetered],
    ledger,
    dispatchBias: 1,
  });
  expect(res.granted[0].pool_id).toBe("local#a/m");
});

test("dial: bias clamps to [0,1] — >1 behaves as 1, <0 as 0", async () => {
  const cheapSlow = () => pool("cheap#a/m", { costRank: 0, throughputScore: 1000 });
  const priceyFast = () => pool("fast#a/m", { costRank: 2, throughputScore: 100000 });

  const over = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [cheapSlow(), priceyFast()],
    ledger: await freshLedger(),
    dispatchBias: 5,
  });
  expect(over.granted[0].pool_id).toBe("fast#a/m"); // clamps to 1 → speed-first

  const under = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [cheapSlow(), priceyFast()],
    ledger: await freshLedger(),
    dispatchBias: -2,
  });
  expect(under.granted[0].pool_id).toBe("cheap#a/m"); // clamps to 0 → cost-first
});

test("dial: an intermediate λ can pick a pool that is neither cheapest nor fastest-at-λ0", async () => {
  // cheap (cost 0, slow), mid (cost 1, FASTEST), costly (cost 2, mid-speed).
  // λ=0 → cheap; λ=0.5 blended ordinals → mid strictly wins (0.5 < 1 < 1.5).
  const cheap = () => pool("cheap#a/m", { costRank: 0, throughputScore: 100 });
  const mid = () => pool("mid#a/m", { costRank: 1, throughputScore: 10000 });
  const costly = () => pool("costly#a/m", { costRank: 2, throughputScore: 1000 });

  const atZero = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [cheap(), mid(), costly()],
    ledger: await freshLedger(),
    dispatchBias: 0,
  });
  expect(atZero.granted[0].pool_id).toBe("cheap#a/m");

  const atHalf = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [cheap(), mid(), costly()],
    ledger: await freshLedger(),
    dispatchBias: 0.5,
  });
  expect(atHalf.granted[0].pool_id).toBe("mid#a/m");
});

test("dial: spill still walks the blended order when the fastest pool is cap-reached", async () => {
  const ledger = await freshLedger();
  const fastest = pool("fastest#a/m", { costRank: 2, throughputScore: 100000, declaredCap: 1 });
  const nextFast = pool("next#a/m", { costRank: 1, throughputScore: 50000 });
  const res = await admitBatch({
    packets: [pkt("p1", 100), pkt("p2", 100)],
    pools: [fastest, nextFast],
    ledger,
    dispatchBias: 1,
  });
  const byPacket = Object.fromEntries(res.granted.map((g) => [g.packet_id, g.pool_id]));
  expect(byPacket.p1).toBe("fastest#a/m"); // fills its cap of 1
  expect(byPacket.p2).toBe("next#a/m"); // spills to the next-fastest
});
