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

function pool(poolId, { budget = Infinity, declaredCap = null, costRank = 0, capabilityRank = 0, capacityTokens = Infinity } = {}) {
  return {
    poolId,
    resourceKey: poolId,
    budget,
    declaredCap,
    costRank,
    capabilityRank,
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
