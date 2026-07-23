import { test, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

const { admitBatch, admissionPoolsFromSummaries, DispatchAdmissionSchema, buildCapacityPoolCapabilityFloor } =
  await import("../../src/shared/dispatch/admissionLoop.ts");
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
    capabilityScore = null,
    throughputConcurrency = Infinity,
    capacityTokens = Infinity,
    calibrating = false,
    accountKey,
    windowBudgets = [],
  } = {},
) {
  return {
    poolId,
    resourceKey: poolId,
    budget,
    // Default: each pool is its own account (no sharing), so existing cases keep
    // metering exactly as before. Pass an explicit `accountKey` to put two pools on
    // ONE credential and exercise the shared-allowance partition.
    accountKey: accountKey ?? poolId,
    windowBudgets,
    declaredCap,
    costRank,
    capabilityRank,
    capabilityScore,
    throughputConcurrency,
    capacityTokens,
    calibrating,
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

test("raw capability score breaks a cost-equal, same-tier tie (lower score = more capable, routes first)", async () => {
  const ledger = await freshLedger();
  // Two repair-proxy-style pools: identical cost, identical tier ordinal (both the
  // neutral fallback), differing only by raw composite_rank. Each fits exactly one
  // packet, so the FIRST packet reveals which pool the router prefers.
  const strong = pool("rp/strong", { budget: 1000, costRank: 0, capabilityRank: 1, capabilityScore: 3 });
  const weak = pool("rp/weak", { budget: 1000, costRank: 0, capabilityRank: 1, capabilityScore: 40 });
  const res = await admitBatch({
    packets: [pkt("p1", 1000), pkt("p2", 1000)],
    pools: [weak, strong],
    ledger,
  });
  const byPacket = Object.fromEntries(res.granted.map((g) => [g.packet_id, g.pool_id]));
  // p1 → the more-capable (lower-score) pool; p2 spills to the other.
  expect(byPacket.p1).toBe("rp/strong");
  expect(byPacket.p2).toBe("rp/weak");
});

test("raw capability score never reorders against cost (cost stays primary)", async () => {
  const ledger = await freshLedger();
  // The cheaper pool is LESS capable (higher score); cost must still win.
  const cheapWeak = pool("cheap/weak", { budget: 1000, costRank: 0, capabilityRank: 1, capabilityScore: 999 });
  const dearStrong = pool("dear/strong", { budget: 1000, costRank: 5, capabilityRank: 1, capabilityScore: 1 });
  const res = await admitBatch({
    packets: [pkt("p1", 1000)],
    pools: [dearStrong, cheapWeak],
    ledger,
  });
  expect(res.granted[0].pool_id).toBe("cheap/weak");
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
  // The artifact is written via JSON.stringify and read back via JSON.parse —
  // validating the in-memory object proves nothing about what survives that
  // round trip (e.g. a cold-start `budget: Infinity` produces
  // `headroom_before: Infinity` in memory, which JSON.stringify collapses to
  // `null`). Exercise the real round trip, not the pre-serialization shape.
  const roundTripped = JSON.parse(JSON.stringify(admission));
  expect(() => DispatchAdmissionSchema.parse(roundTripped)).not.toThrow();
});

// ── Cold-start calibration clamp (host-path over-grant fix, token-aware sizing) ──
// At full cold start a live snapshot exists but NO window has a real token budget
// yet (pool.budget ⇒ +Infinity), so WITHOUT this clamp the host grant would fan
// out the whole frontier — at arbitrary per-packet size — before the
// tokens-per-percent slope is observed. `calibrating` caps the grant via
// `deriveColdStartAdmissionBatch`: sized to what conservatively fits when
// `pool.budget` is still a real finite number (a SIBLING window is the
// uncalibrated one), else the small slope-learning probe
// (`COLD_START_PROBE_BATCH`) — the bound the host ACTUALLY obeys (the
// scheduler's max_concurrent cold-start clamp never reaches the grant).

const { COLD_START_PROBE_BATCH } = await import(
  "../../src/shared/quota/scheduler.ts"
);

test("cold start, UNKNOWN budget (+Infinity): caps the grant to the slope-learning probe, never a large batch", async () => {
  const ledger = await freshLedger();
  const calibratingHost = pool("host#a/m", { budget: Infinity, calibrating: true });
  const packets = Array.from({ length: 6 }, (_, i) => pkt(`p${i + 1}`, 100));
  const res = await admitBatch({ packets, pools: [calibratingHost], ledger });
  // Bounded to the probe despite infinite budget and no declared cap.
  expect(res.granted.length).toBe(COLD_START_PROBE_BATCH);
  expect(res.blocked.length).toBe(6 - COLD_START_PROBE_BATCH);
  const ex = res.explains.find((e) => e.packet_id === `p${COLD_START_PROBE_BATCH + 1}`);
  expect(ex.reason).toBe("cap_reached");
});

test("cold start: a declared cap TIGHTER than the probe still wins (min semantics)", async () => {
  const ledger = await freshLedger();
  const cappedCalibrating = pool("codex#a/m", { budget: Infinity, calibrating: true, declaredCap: 1 });
  const packets = Array.from({ length: 4 }, (_, i) => pkt(`p${i + 1}`, 100));
  const res = await admitBatch({ packets, pools: [cappedCalibrating], ledger });
  expect(res.granted.length).toBe(1); // min(declaredCap=1, probe=COLD_START_PROBE_BATCH)
});

test("NOT calibrating: an established pool with budget grants the full batch (clamp does not fire)", async () => {
  const ledger = await freshLedger();
  const established = pool("host#a/m", { budget: Infinity, calibrating: false });
  const packets = Array.from({ length: 5 }, (_, i) => pkt(`p${i + 1}`, 100));
  const res = await admitBatch({ packets, pools: [established], ledger });
  expect(res.granted.length).toBe(5); // no cold-start clamp once a real budget exists
  expect(res.blocked.length).toBe(0);
});

test("cold start, UNKNOWN budget: a declared cap LOOSER than the probe loses to it", async () => {
  const ledger = await freshLedger();
  const looseCalibrating = pool("codex#a/m", { budget: Infinity, calibrating: true, declaredCap: 6 });
  const packets = Array.from({ length: 6 }, (_, i) => pkt(`p${i + 1}`, 100));
  const res = await admitBatch({ packets, pools: [looseCalibrating], ledger });
  expect(res.granted.length).toBe(COLD_START_PROBE_BATCH); // min(6, probe)
});

test("mixed pools: a calibrating pool is clamped while a coexisting established pool takes the overflow", async () => {
  const ledger = await freshLedger();
  // Calibrating host is cheapest → fills first but is capped at the probe batch;
  // the established (real-budget, not calibrating) source is NOT clamped → takes the rest.
  const calibratingHost = pool("host#a/m", { budget: Infinity, calibrating: true, costRank: 0 });
  const establishedSource = pool("nim#a/m", { budget: Infinity, calibrating: false, costRank: 1 });
  const packets = Array.from({ length: 5 }, (_, i) => pkt(`p${i + 1}`, 100));
  const res = await admitBatch({ packets, pools: [calibratingHost, establishedSource], ledger });
  const counts = res.granted.reduce((m, g) => ((m[g.pool_id] = (m[g.pool_id] ?? 0) + 1), m), {});
  expect(counts["host#a/m"]).toBe(COLD_START_PROBE_BATCH); // calibrating pool clamped to the probe
  expect(counts["nim#a/m"]).toBe(5 - COLD_START_PROBE_BATCH); // established pool takes overflow, unclamped
  expect(res.granted.length).toBe(5); // nothing dropped — overflow had a home
});

// ── Cold start, KNOWN (finite) budget: token-aware sizing, not a flat count ──────
// A pool can be `calibrating: true` while `pool.budget` is STILL a real finite
// number — the MIN-across-windows case where ONE sibling window has no learned
// slope but another window's budget is known (scheduler.ts's own per-window MIN
// reduction). In that case the grant must size to what the KNOWN budget
// conservatively fits, not the flat probe — this is the "derive the bootstrap
// batch from a conservative token estimate against the real remaining budget"
// fix (2026-07-11 backlog Bug 1a).

test("cold start, KNOWN ample budget: batch sizes to what fits — MORE than the old flat probe/2", async () => {
  const ledger = await freshLedger();
  // budget=100_000, packets cost 100 each, default safety margin 0.8 →
  // floor(100_000*0.8/100) = 800, far more than any flat small-count fallback.
  const ampleCalibrating = pool("host#a/m", { budget: 100_000, calibrating: true });
  const packets = Array.from({ length: 10 }, (_, i) => pkt(`p${i + 1}`, 100));
  const res = await admitBatch({ packets, pools: [ampleCalibrating], ledger });
  expect(res.granted.length).toBe(10); // ample known budget admits the WHOLE batch
  expect(res.blocked.length).toBe(0);
});

test("cold start, KNOWN tight budget: batch sizes DOWN to what fits — fewer than an ample batch would get", async () => {
  const ledger = await freshLedger();
  // budget=150, packets cost 100 each → floor(150*0.8/100) = 1: only one packet's
  // worth of headroom, so the second is blocked by the count-derived cap.
  const tightCalibrating = pool("host#a/m", { budget: 150, calibrating: true });
  const packets = [pkt("p1", 100), pkt("p2", 100)];
  const res = await admitBatch({ packets, pools: [tightCalibrating], ledger });
  expect(res.granted.length).toBe(1);
  expect(res.blocked).toEqual(["p2"]);
});

test("ANTI-OVER-ADMISSION GUARD: a large per-packet estimate against a SMALL known budget admits ZERO, never exceeds budget", async () => {
  // The 2026-07-11 incident shape: a calibrating pool with a small real remaining
  // budget (analogous to a tight session window) facing packets whose own token
  // estimate individually exceeds it. The batch must NEVER be granted past the
  // known budget — regardless of how the count-derived cap floors — because the
  // reservation ledger's own per-packet budget check is the backstop.
  const ledger = await freshLedger();
  const smallKnownBudget = pool("host#a/m", { budget: 1_000, calibrating: true });
  const hugePackets = [pkt("p1", 5_000), pkt("p2", 5_000), pkt("p3", 5_000)];
  const res = await admitBatch({ packets: hugePackets, pools: [smallKnownBudget], ledger });
  expect(res.granted.length).toBe(0); // never grants a packet that blows the known budget
  expect(res.blocked).toEqual(["p1", "p2", "p3"]);
  for (const ex of res.explains) {
    expect(ex.admitted).toBe(false);
    expect(ex.reason).toBe("budget_exhausted");
  }
});

test("ANTI-OVER-ADMISSION GUARD: unknown (+Infinity) budget never admits more than the slope-learning probe, however large the packets", async () => {
  // The other half of the same incident shape: when the budget is genuinely
  // UNKNOWN (not just small), a batch of huge packets must still be capped to the
  // probe count — never a large batch fanned out against an unmeasured ceiling.
  const ledger = await freshLedger();
  const unknownBudget = pool("host#a/m", { budget: Infinity, calibrating: true });
  const hugePackets = Array.from({ length: 5 }, (_, i) => pkt(`p${i + 1}`, 375_000));
  const res = await admitBatch({ packets: hugePackets, pools: [unknownBudget], ledger });
  expect(res.granted.length).toBe(COLD_START_PROBE_BATCH);
  expect(res.blocked.length).toBe(5 - COLD_START_PROBE_BATCH);
});

// ── Cost↔speed dispatch dial (spec/dispatch-cost-speed-dial.md) ──────────────
// Throughput = effective PARALLELISM (throughputConcurrency): higher = faster,
// +Infinity = hardware-parallel. Derived pool-class-aware (see the
// deriveThroughputConcurrency block below); here it is set explicitly per pool.

test("dial λ=0 (default) ignores throughput — the cheapest pool wins even when slowest", async () => {
  const ledger = await freshLedger();
  const cheapSlow = pool("cheap#a/m", { costRank: 0, throughputConcurrency: 2 });
  const priceyFast = pool("fast#a/m", { costRank: 2, throughputConcurrency: Infinity });
  const res = await admitBatch({ packets: [pkt("p1", 100)], pools: [priceyFast, cheapSlow], ledger });
  expect(res.granted[0].pool_id).toBe("cheap#a/m");
});

test("dial λ=1 (max speed) routes to the highest-parallelism capable pool, not the cheapest", async () => {
  const ledger = await freshLedger();
  const cheapSlow = pool("cheap#a/m", { costRank: 0, throughputConcurrency: 2 });
  const priceyFast = pool("fast#a/m", { costRank: 2, throughputConcurrency: Infinity });
  const res = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [cheapSlow, priceyFast],
    ledger,
    dispatchBias: 1,
  });
  expect(res.granted[0].pool_id).toBe("fast#a/m");
});

test("dial λ=1: a higher FINITE parallelism wins even when the poolId tiebreak would pick the other", async () => {
  // Non-vacuous: "aaa" sorts first lexicographically, so if throughput were ignored
  // the poolId tiebreak would pick it. Correct behavior picks the higher-parallelism "zzz".
  const ledger = await freshLedger();
  const slowFirstAlpha = pool("aaa#a/m", { costRank: 0, throughputConcurrency: 2 });
  const fastLastAlpha = pool("zzz#a/m", { costRank: 0, throughputConcurrency: 10 });
  const res = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [slowFirstAlpha, fastLastAlpha],
    ledger,
    dispatchBias: 1,
  });
  expect(res.granted[0].pool_id).toBe("zzz#a/m");
});

test("dial λ=1: a sequential host (concurrency 1) ranks BELOW a metered parallel source — not crowned", async () => {
  // The R-1 regression guard: the host must NOT win λ=1 just because it is cheapest.
  const ledger = await freshLedger();
  const host = pool("claude-code#host", { costRank: 0, throughputConcurrency: 1 }); // sequential host
  const nim = pool("nim#a/m", { costRank: 2, throughputConcurrency: 32 }); // metered parallel source
  const res = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [host, nim],
    ledger,
    dispatchBias: 1,
  });
  expect(res.granted[0].pool_id).toBe("nim#a/m");
});

test("dial: bias clamps to [0,1] — >1 behaves as 1, <0 as 0", async () => {
  const cheapSlow = () => pool("cheap#a/m", { costRank: 0, throughputConcurrency: 2 });
  const priceyFast = () => pool("fast#a/m", { costRank: 2, throughputConcurrency: Infinity });

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
  // cheap (cost 0, parallelism 2), mid (cost 1, FASTEST), costly (cost 2, parallelism 10).
  // λ=0 → cheap; λ=0.5 blended ordinals → mid strictly wins (0.5 < 1 < 1.5).
  const cheap = () => pool("cheap#a/m", { costRank: 0, throughputConcurrency: 2 });
  const mid = () => pool("mid#a/m", { costRank: 1, throughputConcurrency: Infinity });
  const costly = () => pool("costly#a/m", { costRank: 2, throughputConcurrency: 10 });

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

test("dial: a non-finite bias (NaN) coerces to the cost-first default, not a NaN comparator", async () => {
  const ledger = await freshLedger();
  const cheapSlow = pool("cheap#a/m", { costRank: 0, throughputConcurrency: 2 });
  const priceyFast = pool("fast#a/m", { costRank: 2, throughputConcurrency: Infinity });
  // NaN must not slip past the clamp into the sort (would yield engine-defined order).
  const res = await admitBatch({
    packets: [pkt("p1", 100)],
    pools: [priceyFast, cheapSlow],
    ledger,
    dispatchBias: NaN,
  });
  expect(res.granted[0].pool_id).toBe("cheap#a/m"); // cost-first default
});

test("dial: spill still walks the blended (speed) order when the faster pool's cap fills", async () => {
  const ledger = await freshLedger();
  // At λ=1 the higher-parallelism pool is preferred; once its cap fills, overflow
  // spills to the lower-parallelism pool — the cap gate still fires after the reorder.
  const faster = pool("faster#a/m", { costRank: 2, throughputConcurrency: 10, declaredCap: 2 });
  const slower = pool("slower#a/m", { costRank: 1, throughputConcurrency: 5, declaredCap: 1 });
  const res = await admitBatch({
    packets: [pkt("p1", 100), pkt("p2", 100), pkt("p3", 100)],
    pools: [faster, slower],
    ledger,
    dispatchBias: 1,
  });
  const counts = res.granted.reduce((m, g) => ((m[g.pool_id] = (m[g.pool_id] ?? 0) + 1), m), {});
  expect(counts["faster#a/m"]).toBe(2); // fills its cap of 2 first (preferred at λ=1)
  expect(counts["slower#a/m"]).toBe(1); // overflow spills to the slower pool
});

// ── Host-grant lease TTL (host-path lease-TTL fix) ───────────────────────────
// A host subagent wave runs for MINUTES; a lease minted at the ledger's 30s
// STALE_LOCK_MS default expires mid-wave. Expired leases stop counting toward
// BOTH the pool budget and the declared-cap in-flight count (admitBatch seeds
// the count from the pruned snapshot), so a concurrent co-located admitter
// would see the account free and double-grant it. Host grants therefore carry
// the wave-envelope DISPATCH_LEASE_TTL_MS.

const { computeDispatchAdmission } = await import(
  "../../src/shared/dispatch/admissionLoop.ts"
);
const { DISPATCH_LEASE_TTL_MS } = await import(
  "../../src/shared/quota/reservationLedger.ts"
);
const { STALE_LOCK_MS } = await import("../../src/shared/quota/fileLock.ts");

async function ledgerAt(clock) {
  const dir = await mkdtemp(join(tmpdir(), "admission-ttl-"));
  const path = join(dir, "reservations.json");
  return { path, ledger: new ReservationLedger(path, clock) };
}

test("host grant mints wave-envelope leases (DISPATCH_LEASE_TTL_MS), not the 30s ledger default", async () => {
  const t0 = 1_000_000;
  const { ledger } = await ledgerAt(() => t0);
  await computeDispatchAdmission({
    packets: [{ id: "p1", inputTokens: 100, complexity: 0.5 }],
    pools: [pool("host#a/m")],
    outputCap: 100,
    grantLeases: true,
    ledger,
  });
  const leases = Object.values(await ledger.snapshot()).flat();
  expect(leases.length).toBe(1);
  expect(leases[0].expiresAt).toBe(t0 + DISPATCH_LEASE_TTL_MS);
  expect(DISPATCH_LEASE_TTL_MS).toBeGreaterThan(STALE_LOCK_MS);
});

test("a concurrent admitter arriving past the 30s default still sees the wave's cap consumed (no double-grant)", async () => {
  const t0 = 1_000_000;
  let now = t0;
  const { path } = await ledgerAt(() => now);
  const cappedPool = () => pool("host#a/m", { declaredCap: 1 });
  const admitOnce = (id) =>
    computeDispatchAdmission({
      packets: [{ id, inputTokens: 100, complexity: 0.5 }],
      pools: [cappedPool()],
      outputCap: 100,
      grantLeases: true,
      // Each admitter is its own process in production — fresh ledger instance,
      // same shared file.
      ledger: new ReservationLedger(path, () => now),
    });

  const first = await admitOnce("p1");
  expect(first.granted_packet_ids).toEqual(["p1"]);

  // Mid-wave, after the OLD default TTL would have expired the lease.
  now = t0 + STALE_LOCK_MS + 1;
  const second = await admitOnce("p2");
  expect(second.granted_packet_ids).toEqual([]); // cap still held by the live wave lease
  expect(second.explains[0].reason).toBe("cap_reached");

  // Past the wave envelope the orphan lease self-clears (crash recovery intact).
  now = t0 + DISPATCH_LEASE_TTL_MS + 1;
  const third = await admitOnce("p3");
  expect(third.granted_packet_ids).toEqual(["p3"]);
});

// deriveThroughputConcurrency — the pool-class-aware derivation itself (the R-1 fix).
test("deriveThroughputConcurrency: source uncapped ⇒ +Inf, source capped ⇒ cap, host ⇒ subagents (default 1)", async () => {
  const { deriveThroughputConcurrency } = await import("../../src/shared/dispatch/admissionLoop.ts");
  // Backend source: uncapped is hardware-parallel (fastest); a declared cap ⇒ that count.
  expect(deriveThroughputConcurrency({ isConversationHost: false, sourceConcurrencyCap: null })).toBe(Infinity);
  expect(deriveThroughputConcurrency({ isConversationHost: false, sourceConcurrencyCap: 6 })).toBe(6);
  // Conversation host: unspecified subagent budget ⇒ sequential (1), NOT unbounded.
  expect(deriveThroughputConcurrency({ isConversationHost: true, hostActiveSubagents: null })).toBe(1);
  expect(deriveThroughputConcurrency({ isConversationHost: true, hostActiveSubagents: 4 })).toBe(4);
});

// ── Unified-routing step B: ONE fit predicate on both paths ──────────────────
// The host-admission path used to gate every pool against the WAVE's resolved
// window (`resolved_limits.context_tokens`), never the pool's own effective window
// — so a small-context source pool admitted packets it could never serve (413
// instead of a skip). RED before the fix (capacityTokens === resolved window for a
// capped source summary); GREEN after (context_cap_tokens outranks it).
test("admissionPoolsFromSummaries: a source pool's own context_cap_tokens outranks the wave's resolved window", async () => {
  const { admissionPoolsFromSummaries } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const base = {
    slots: 1,
    model: null,
    confidence: "low",
    source: "default",
    resolved_limits: { context_tokens: 200_000, output_tokens: 8_000 },
    host_concurrency_limit: null,
    cooldown_until: null,
    estimated_wave_tokens: 0,
    binding_cap: "none",
  };
  const pools = admissionPoolsFromSummaries([
    // A small-context backend source: its own window must gate, not the wave's.
    { ...base, pool_id: "groq/small-model", is_conversation_host: false, context_cap_tokens: 16_000 },
    // A host pool (never stamps context_cap_tokens): falls to its resolved window.
    { ...base, pool_id: "claude-code/*", is_conversation_host: true },
  ]);
  const byId = Object.fromEntries(pools.map((p) => [p.poolId, p]));
  expect(byId["groq/small-model"].capacityTokens).toBe(16_000);
  expect(byId["claude-code/*"].capacityTokens).toBe(200_000);
});

test("end-to-end: an oversized packet is NOT admitted to a small-window source pool on the host-admission path", async () => {
  const { admissionPoolsFromSummaries } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  const base = {
    slots: 4,
    model: null,
    confidence: "low",
    source: "default",
    resolved_limits: { context_tokens: 200_000, output_tokens: 8_000 },
    host_concurrency_limit: null,
    cooldown_until: null,
    estimated_wave_tokens: 0,
    binding_cap: "none",
  };
  const pools = admissionPoolsFromSummaries([
    // Free small pool sorts first on cost — but a 40k packet must NOT land on its 16k window.
    { ...base, pool_id: "groq/small-model", is_conversation_host: false, context_cap_tokens: 16_000, declared_cost_per_mtok: 0 },
    { ...base, pool_id: "claude-code/*", is_conversation_host: true },
  ]);
  const res = await admitBatch({ packets: [pkt("big", 40_000)], pools, ledger });
  expect(res.granted.length).toBe(1);
  expect(res.granted[0].pool_id).toBe("claude-code/*");
});

// ── Unified-routing step C: relative capability floor ────────────────────────
test("capability floor: a deep packet skips bottom-band scored pools and lands on the top band", async () => {
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  // Three scored pools (composite_rank: LOWER = better). Cheapest is the weakest —
  // without the floor, cost-first would send the deep packet there.
  const weak = pool("weak#a/m", { costRank: 0, capabilityScore: 300 });
  const mid = pool("mid#a/m", { costRank: 1, capabilityScore: 200 });
  const strong = pool("strong#a/m", { costRank: 2, capabilityScore: 100 });
  const pools = [weak, mid, strong];
  const capable = buildCapabilityFloorCapable(pools);
  const res = await admitBatch({
    packets: [{ id: "hard", cost: 1000, complexity: 1, requiredTier: "deep" }],
    pools,
    ledger,
    capable,
  });
  expect(res.granted.length).toBe(1);
  expect(res.granted[0].pool_id).toBe("strong#a/m"); // top tercile only
});

test("capability floor: standard admits top two bands; small admits all (cost-first prevails)", async () => {
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  const weak = pool("weak#a/m", { costRank: 0, capabilityScore: 300 });
  const mid = pool("mid#a/m", { costRank: 1, capabilityScore: 200 });
  const strong = pool("strong#a/m", { costRank: 2, capabilityScore: 100 });
  const pools = [weak, mid, strong];
  const capable = buildCapabilityFloorCapable(pools);
  const res = await admitBatch({
    packets: [
      { id: "std", cost: 1000, complexity: 1, requiredTier: "standard" },
      { id: "easy", cost: 1000, complexity: 0.5, requiredTier: "small" },
    ],
    pools,
    ledger,
    capable,
  });
  const byPacket = Object.fromEntries(res.granted.map((g) => [g.packet_id, g.pool_id]));
  expect(byPacket.std).toBe("mid#a/m"); // cheapest within bands 0-1
  expect(byPacket.easy).toBe("weak#a/m"); // no floor → cheapest overall
});

test("capability floor: UNKNOWN capability fails OPEN with a recorded note when banded siblings exist", async () => {
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  // An unknown pool (no score, neutral ordinal) alongside a scored sibling — a real
  // routing choice exists, so the fail-open is a low-confidence decision worth noting.
  const unknown = pool("proxy#groq/x", { costRank: 0, capabilityRank: 1 });
  const scoredPricey = pool("strong#a/m", { costRank: 5, capabilityScore: 100 });
  const pools = [unknown, scoredPricey];
  const failOpens = [];
  const capable = buildCapabilityFloorCapable(pools, (info) => failOpens.push(info));
  const res = await admitBatch({
    packets: [{ id: "hard", cost: 1000, complexity: 1, requiredTier: "deep" }],
    pools,
    ledger,
    capable,
  });
  expect(res.granted.length).toBe(1); // fail-open: the cheap unknown pool is admitted
  expect(res.granted[0].pool_id).toBe("proxy#groq/x");
  expect(failOpens).toEqual([
    { poolId: "proxy#groq/x", packetId: "hard", requiredTier: "deep" },
  ]);
});

test("capability floor composes over size-fit — a top-band pool that cannot HOLD the packet still rejects", async () => {
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  const strongSmall = pool("strong#a/m", { costRank: 0, capabilityScore: 100, capacityTokens: 500 });
  const midBig = pool("mid#a/m", { costRank: 1, capabilityScore: 200, capacityTokens: 100000 });
  const pools = [strongSmall, midBig];
  const capable = buildCapabilityFloorCapable(pools);
  const res = await admitBatch({
    packets: [{ id: "hard", cost: 40_000, complexity: 1, requiredTier: "standard" }],
    pools,
    ledger,
    capable,
  });
  // strong is band 0 but too small; mid is band 1 (standard-eligible) and fits.
  expect(res.granted.length).toBe(1);
  expect(res.granted[0].pool_id).toBe("mid#a/m");
});

test("capability floor: non-neutral tier ordinals band scoreless pools (roster deep→0, small→2)", async () => {
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  // Ordinal-only pools (a host roster): deep rank → band 0; small rank → band 2.
  const hostDeep = pool("host#a/deep", { costRank: 5, capabilityRank: 2 });
  const hostSmall = pool("host#a/small", { costRank: 0, capabilityRank: 0 });
  const pools = [hostDeep, hostSmall];
  const capable = buildCapabilityFloorCapable(pools);
  const res = await admitBatch({
    packets: [{ id: "hard", cost: 1000, complexity: 1, requiredTier: "deep" }],
    pools,
    ledger,
    capable,
  });
  // The cheap small-rank pool is band 2 → ineligible for deep; the deep rank takes it.
  expect(res.granted.length).toBe(1);
  expect(res.granted[0].pool_id).toBe("host#a/deep");
});

test("capability floor degeneracy pin: a SINGLE scored pool is band 0 by construction (relative-only, no absolute cutoff)", async () => {
  // With n=1 scored pool, "top tercile of scored pools" is that pool — even a
  // weak-scoring model. This is the deliberate consequence of the relative-not-
  // absolute invariant (never a named-model→tier map): with nothing to compare
  // against, the floor cannot call a model weak. Pinned so a future "fix" that
  // sneaks in an absolute score cutoff turns this red and gets discussed first.
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  const onlyScored = pool("weak#a/m", { costRank: 0, capabilityScore: 300 });
  const capable = buildCapabilityFloorCapable([onlyScored]);
  const res = await admitBatch({
    packets: [{ id: "hard", cost: 1000, complexity: 1, requiredTier: "deep" }],
    pools: [onlyScored],
    ledger,
    capable,
  });
  expect(res.granted.length).toBe(1);
  expect(res.granted[0].pool_id).toBe("weak#a/m");
});

// C-review F3: the floor is relative ALL the way down — an all-small roster still
// dispatches deep packets to the best AVAILABLE band, never a self-made livelock.
test("capability floor: an all-small pool set still admits deep packets (best-available band, no manufactured no_capable_pool)", async () => {
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  const smallA = pool("host#a/small-a", { costRank: 0, capabilityRank: 0 });
  const smallB = pool("host#a/small-b", { costRank: 1, capabilityRank: 0 });
  const pools = [smallA, smallB];
  const capable = buildCapabilityFloorCapable(pools);
  const res = await admitBatch({
    packets: [{ id: "hard", cost: 1000, complexity: 1, requiredTier: "deep" }],
    pools,
    ledger,
    capable,
  });
  expect(res.granted.length).toBe(1);
  expect(res.granted[0].pool_id).toBe("host#a/small-a"); // best available (band tie) → cheapest
});

// C-review F2: with ZERO capability data the floor is globally inert — no fail-open
// notes (a warning per packet on every ordinary single-host wave is fatigue, not signal).
test("capability floor: no banded pools ⇒ inert floor, NO fail-open notes", async () => {
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  const hostOnly = pool("claude-code/*", { costRank: 0, capabilityRank: 1 }); // neutral, unscored
  const failOpens = [];
  const capable = buildCapabilityFloorCapable([hostOnly], (info) => failOpens.push(info));
  const res = await admitBatch({
    packets: [{ id: "hard", cost: 1000, complexity: 1, requiredTier: "deep" }],
    pools: [hostOnly],
    ledger,
    capable,
  });
  expect(res.granted.length).toBe(1);
  expect(failOpens).toEqual([]); // inert floor → nothing to flag
});

// ── F4: grantLeases:false (plan-only / in-process engine path) still applies the
// structural predicates. On HEAD this path granted EVERY candidate before the
// capable gate ever ran ("granted before admitBatch"), so the contract displayed
// grants the engine would refuse — the write-only-contract class. Now the
// plan-only grant filters through the same capable (capability floor ∘ size-fit)
// predicate and explains each skip.
test("F4: grantLeases:false filters candidates through capable and explains the skip (no_capable_pool)", async () => {
  const { buildCapabilityFloorCapable } = await import("../../src/shared/dispatch/admissionLoop.ts");
  const ledger = await freshLedger();
  // Pool A: top band (capabilityRank 2 → band 0) but a tiny window — fails size-fit
  // for every packet here. Pool B: bottom band (capabilityRank 0 → band 2), huge
  // window. A "deep" packet therefore has NO capable pool: A fails fit, B fails the
  // floor (best available band is 0 via A, so band 2 is below a deep floor).
  const tinyDeep = pool("deep#a/m", { costRank: 2, capabilityRank: 2, capacityTokens: 1 });
  const bigSmall = pool("small#a/m", { costRank: 0, capabilityRank: 0, capacityTokens: Infinity });
  const pools = [tinyDeep, bigSmall];
  const res = await computeDispatchAdmission({
    packets: [
      { id: "hard", inputTokens: 5000, complexity: 1, requiredTier: "deep" },
      { id: "easy", inputTokens: 5000, complexity: 0.2 },
    ],
    pools,
    outputCap: 1000,
    grantLeases: false,
    ledger,
    capable: buildCapabilityFloorCapable(pools),
  });
  // The floor-less packet still plans onto the fitting pool; the deep packet is
  // NOT displayed as granted, and the skip is explained.
  expect(res.granted_packet_ids).toEqual(["easy"]);
  expect(res.leases).toEqual([]); // plan-only: never leases
  expect(res.explains).toEqual([
    expect.objectContaining({
      packet_id: "hard",
      admitted: false,
      // The deep packet's only floor-capable pool can't fit its envelope — the
      // skip is labeled as the SIZE fact it is (the relative floor alone can
      // never refuse every pool, so `no_capable_pool` is unreachable here).
      reason: "packet_oversized",
      pool_id: null,
    }),
  ]);
});

test("F4: grantLeases:false with an EMPTY pool set grants all — absent capacity summary is not a refusal", async () => {
  const ledger = await freshLedger();
  const res = await computeDispatchAdmission({
    packets: [{ id: "p1", inputTokens: 5000, complexity: 0.5 }],
    pools: [],
    outputCap: 1000,
    grantLeases: false,
    ledger,
  });
  expect(res.granted_packet_ids).toEqual(["p1"]);
  expect(res.leases).toEqual([]);
  expect(res.explains).toEqual([]);
});

// ---------------------------------------------------------------------------
// The N× over-admission — the defect this whole design exists to close.
// ---------------------------------------------------------------------------

/** An account-scoped percent window: the allowance shared by every sibling model. */
function accountWindow(pctRemaining, tokensPerPct, label = "session") {
  return {
    scope: "account",
    label,
    budget: pctRemaining,
    unit: "percent",
    tokensPerPct,
    reset_at: null,
  };
}

test("N-TIMES OVER-ADMISSION: siblings on ONE credential draw down ONE allowance", async () => {
  const ledger = await freshLedger();
  // Two models on one account, each seeing the SAME account-wide window: 10% left,
  // 1000 tokens per percentage point ⇒ 10_000 tokens of real headroom TOTAL.
  // Pre-fix each pool metered its own copy of that budget, so two pools admitted
  // ~2× the work the credential could actually serve (N pools ⇒ N×).
  const shared = () => accountWindow(10, 1000);
  const pools = [
    pool("nim#acct-1/nano", { accountKey: "nim#acct-1", windowBudgets: [shared()], costRank: 0 }),
    pool("nim#acct-1/super", { accountKey: "nim#acct-1", windowBudgets: [shared()], costRank: 1 }),
  ];
  // Six packets of 4000 tokens = 24_000 requested against 10_000 available.
  const packets = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, cost: 4000, complexity: 0.5 }));

  const res = await admitBatch({ packets, pools, ledger });

  // 4000 tokens = 4 percentage points; 10 points available ⇒ exactly 2 fit.
  expect(res.granted).toHaveLength(2);
  expect(res.blocked).toHaveLength(4);

  // Both grants meter against the SAME account key, whichever pool served them.
  const leased = await ledger.snapshot();
  expect(Object.keys(leased)).toEqual(["acct:nim#acct-1::session"]);
  const drawn = leased["acct:nim#acct-1::session"].reduce((sum, l) => sum + l.cost, 0);
  expect(drawn).toBeCloseTo(8, 6); // 2 packets × 4 points
});

test("a MODEL-scoped window throttles its own pool without starving its sibling", async () => {
  const ledger = await freshLedger();
  // Both share a roomy account window; only `nano` carries a tight model-scoped limit.
  const roomy = () => accountWindow(100, 1000);
  const pools = [
    pool("nim#acct-1/nano", {
      accountKey: "nim#acct-1",
      costRank: 0, // cheapest, so routing tries it first
      windowBudgets: [
        roomy(),
        { scope: "model", label: "session", budget: 4, unit: "percent", tokensPerPct: 1000, reset_at: null },
      ],
    }),
    pool("nim#acct-1/super", { accountKey: "nim#acct-1", costRank: 1, windowBudgets: [roomy()] }),
  ];
  const packets = Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, cost: 4000, complexity: 0.5 }));

  const res = await admitBatch({ packets, pools, ledger });

  // nano's own window fits exactly one 4-point packet; the rest spill to super
  // rather than being refused — the sibling is not starved by nano's private limit.
  expect(res.granted).toHaveLength(3);
  const byPool = res.granted.reduce((acc, g) => {
    acc[g.pool_id] = (acc[g.pool_id] ?? 0) + 1;
    return acc;
  }, {});
  expect(byPool["nim#acct-1/nano"]).toBe(1);
  expect(byPool["nim#acct-1/super"]).toBe(2);

  // Discriminating assertion: the model window must be keyed to the POOL, not the
  // account. A broken impl that keyed model-scoped windows to accountKey produces the
  // same 1/2 split, so the counts alone do not pin the partition — the keys do.
  const keys = Object.keys(await ledger.snapshot()).sort();
  expect(keys).toContain("pool:nim#acct-1/nano::session");
  expect(keys).toContain("acct:nim#acct-1::session");
});

test("TWO ACCOUNTS on one provider do not share an allowance", async () => {
  const ledger = await freshLedger();
  const pools = [
    pool("nim#acct-a/model", { accountKey: "nim#acct-a", windowBudgets: [accountWindow(4, 1000)], costRank: 0 }),
    pool("nim#acct-b/model", { accountKey: "nim#acct-b", windowBudgets: [accountWindow(4, 1000)], costRank: 1 }),
  ];
  const packets = Array.from({ length: 2 }, (_, i) => ({ id: `p${i}`, cost: 4000, complexity: 0.5 }));

  const res = await admitBatch({ packets, pools, ledger });

  // Each account affords exactly one packet — 2 total. If the account key collapsed
  // to the provider, the second would be refused.
  expect(res.granted).toHaveLength(2);
  expect(Object.keys(await ledger.snapshot()).sort()).toEqual([
    "acct:nim#acct-a::session",
    "acct:nim#acct-b::session",
  ]);
});

test("an UNPRICEABLE window refuses the pool rather than admitting on the priced subset", async () => {
  const ledger = await freshLedger();
  // The account window has no learned slope, so it cannot price the draw. Admitting
  // on the model window alone would meter against fewer allowances than bind it.
  const pools = [
    pool("nim#acct-1/nano", {
      accountKey: "nim#acct-1",
      windowBudgets: [
        { scope: "account", label: "session", budget: 50, unit: "percent", reset_at: null },
        { scope: "model", label: "session", budget: 1_000_000, unit: "tokens", reset_at: null },
      ],
    }),
  ];
  const res = await admitBatch({
    packets: [{ id: "p1", cost: 4000, complexity: 0.5 }],
    pools,
    ledger,
  });
  expect(res.granted).toEqual([]);
  expect(res.blocked).toEqual(["p1"]);
  // Nothing was reserved — a refusal must not leave a partial lease behind.
  expect(await ledger.snapshot()).toEqual({});
});

test("END-TO-END: two id'd siblings summarized from ONE credential meter as ONE account", async () => {
  const ledger = await freshLedger();
  // Starts from CAPACITY SUMMARIES — the real wire shape — and goes through
  // `admissionPoolsFromSummaries`, so the account key travels the production path
  // instead of being hand-injected into the pool helper. The pool ids are the
  // explicitly-declared ones the operator's sources-declared.json actually produces
  // (`nim-nano`, `nim-super`): no `/`, no `#`, nothing recoverable from the string.
  const CRED = "https://integrate.api.nvidia.com/v1::env:NVIDIA_API_KEY";
  const summary = (poolId) => ({
    pool_id: poolId,
    account_key: CRED,
    slots: 4,
    model: poolId,
    rank: "standard",
    confidence: "high",
    source: "declared",
    resolved_limits: { context_tokens: 200_000, output_tokens: 8_000 },
    host_concurrency_limit: null,
    is_conversation_host: false,
    cooldown_until: null,
    estimated_wave_tokens: 0,
    binding_cap: "none",
    remaining_token_budget: 10_000,
    binding_window: null,
    window_budgets: [
      { scope: "account", label: "session", budget: 10, unit: "percent", tokens_per_pct: 1000, reset_at: null },
    ],
    in_flight_tokens: 0,
  });

  const pools = admissionPoolsFromSummaries([summary("nim-nano"), summary("nim-super")]);
  // The identity survived the wire: both siblings resolve to the same account.
  expect(pools[0].accountKey).toBe(CRED);
  expect(pools[1].accountKey).toBe(CRED);

  const packets = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, cost: 4000, complexity: 0.5 }));
  const res = await admitBatch({ packets, pools, ledger });

  // 10 percentage points, 4 per packet ⇒ 2 fit ACROSS BOTH POOLS. Pre-fix each pool
  // metered its own copy and 4 were admitted against a 2-packet credential.
  expect(res.granted).toHaveLength(2);
  expect(Object.keys(await ledger.snapshot())).toEqual([`acct:${CRED}::session`]);
});

test("a declared in-flight cap is passed VERBATIM regardless of window count", async () => {
  // The cap counts IN-FLIGHT REQUESTS. A multi-constraint admission writes one ledger
  // row per window under one lease id, so seeding the count from rows would divide the
  // cap by the pool's window count — a 2-window pool with cap 4 would admit 2. The
  // seed only matters for leases from a PRIOR wave or a co-located run, so this
  // pre-seeds one such lease and checks the cap still admits the full remainder.
  const ledger = await freshLedger();
  const twoWindows = [
    { scope: "account", label: "session", budget: 1e9, unit: "tokens", reset_at: null },
    { scope: "account", label: "weekly", budget: 1e9, unit: "tokens", reset_at: null },
  ];
  // One packet already in flight on this pool, metering against BOTH windows.
  await ledger.admit({
    poolId: "p",
    constraints: [
      { resourceKey: "acct:acct-1::session", budget: 1e9, cost: 10 },
      { resourceKey: "acct:acct-1::weekly", budget: 1e9, cost: 10 },
    ],
  });

  const pools = [pool("p", { accountKey: "acct-1", windowBudgets: twoWindows, declaredCap: 3 })];
  const packets = Array.from({ length: 3 }, (_, i) => ({ id: `q${i}`, cost: 10, complexity: 0.5 }));
  const res = await admitBatch({ packets, pools, ledger });

  // Cap 3, one already in flight ⇒ 2 more. Counting rows would see 2 in flight ⇒ 1.
  expect(res.granted).toHaveLength(2);
});

// ── admissionPoolsFromSummaries — capability_rank field flow ──────────
// The capability_rank from DispatchCapacityPoolSummary flows through to the
// AdmissionPool.capabilityScore field (LOWER = MORE CAPABLE). This test verifies
// that a summary with capability_rank: 2 produces an AdmissionPool.capabilityScore === 2,
// and that an absent field produces capabilityScore: null (fail-open).

test("admissionPoolsFromSummaries: summary with capability_rank: 2 produces AdmissionPool.capabilityScore === 2", () => {
  const summaries = [
    {
      pool_id: "test-pool-1",
      model: "gpt-4",
      rank: "deep",
      is_conversation_host: false,
      concurrency_cap: null,
      host_concurrency_limit: null,
      declared_cost_per_mtok: null,
      remaining_token_budget: Infinity,
      context_cap_tokens: null,
      calibrating: false,
      capability_rank: 2, // explicit capability rank
      account_key: "acc-1",
      resolved_limits: { context_tokens: 200_000, output_tokens: 32_000 },
      window_budgets: [],
    },
  ];
  const pools = admissionPoolsFromSummaries(summaries);
  expect(pools).toHaveLength(1);
  expect(pools[0].capabilityScore).toBe(2);
});

test("admissionPoolsFromSummaries: summary without capability_rank field produces AdmissionPool.capabilityScore === null", () => {
  const summaries = [
    {
      pool_id: "test-pool-2",
      model: "gpt-3.5",
      rank: "standard",
      is_conversation_host: false,
      concurrency_cap: null,
      host_concurrency_limit: null,
      declared_cost_per_mtok: null,
      remaining_token_budget: Infinity,
      context_cap_tokens: null,
      calibrating: false,
      // capability_rank deliberately omitted — undefined
      account_key: "acc-2",
      resolved_limits: { context_tokens: 100_000, output_tokens: 16_000 },
      window_budgets: [],
    },
  ];
  const pools = admissionPoolsFromSummaries(summaries);
  expect(pools).toHaveLength(1);
  expect(pools[0].capabilityScore).toBe(null);
});

// ---------------------------------------------------------------------------
// Capability floor: live availability (zero-spill fix, re-dogfood 2026-07-22).
// The floor's reference point is "the most capable band AVAILABLE" — a pool the
// caller reports unavailable (exhausted for the run) must stop holding the
// floor at its band, so lower-band survivors stay capable.
// ---------------------------------------------------------------------------

test("capability floor: an unavailable best pool stops holding the floor (survivors become capable)", () => {
  const pools = [
    { id: "strong", rank: "deep", declaredCapabilityRank: 1 },
    { id: "weak", rank: "small", declaredCapabilityRank: 9 },
  ];
  const deepPacket = { id: "p1", requiredTier: "deep" };

  // Static (no availability signal): the floor sits at strong's band; weak fails.
  const staticFloor = buildCapacityPoolCapabilityFloor(pools);
  expect(staticFloor("strong", deepPacket)).toBe(true);
  expect(staticFloor("weak", deepPacket)).toBe(false);

  // Live availability: strong drops out → the best AVAILABLE band is weak's own.
  const unavailable = new Set();
  const liveFloor = buildCapacityPoolCapabilityFloor(pools, undefined, (id) => !unavailable.has(id));
  expect(liveFloor("weak", deepPacket), "weak below the floor while strong is live").toBe(false);
  unavailable.add("strong");
  expect(liveFloor("weak", deepPacket), "floor relaxes when strong exhausts").toBe(true);

  // Every banded pool unavailable → floor goes inert (fail-open); the
  // availability filters exclude those pools regardless.
  unavailable.add("weak");
  expect(liveFloor("weak", deepPacket)).toBe(true);
});
