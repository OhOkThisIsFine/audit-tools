/**
 * reservation-ledger.test.mjs
 *
 * The proactive token-reservation ledger (spec/audit/dispatch-admission-control.md).
 * Generalizes the ClaimRegistry pattern from task-claiming to quota-claiming:
 * resourceKey -> token leases, budget-gated admission under withFileLock, leases
 * expire so a crashed consumer never strands budget, reconcile frees on completion,
 * and two ledgers on the same file share outstanding (co-located account budget).
 */

import { test, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ReservationLedger } = await import(
  "../../src/shared/quota/reservationLedger.ts"
);

const KEY = "claude-code#acct-1/sonnet";

async function tempLedger(nowRef, ttlMs) {
  const dir = await mkdtemp(join(tmpdir(), "reservation-ledger-"));
  const path = join(dir, "reservation-ledger.json");
  const now = () => nowRef.t;
  const ledger = new ReservationLedger(path, now, ttlMs);
  return { dir, path, ledger, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("admits when budget covers cost; outstanding + headroom reflect the lease", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({ resourceKey: KEY, cost: 300, budget: 1000, poolId: "p1" });
    expect(d.admitted).toBe(true);
    expect(d.leaseId).toBeTruthy();
    expect(d.outstandingBefore).toBe(0);
    expect(d.headroomBefore).toBe(1000);
    expect(await ledger.outstanding(KEY)).toBe(300);
  } finally {
    await cleanup();
  }
});

test("second admit sees the first's outstanding lease and blocks when budget is exhausted", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const first = await ledger.admit({ resourceKey: KEY, cost: 700, budget: 1000, poolId: "p1" });
    expect(first.admitted).toBe(true);
    // 700 in flight, budget 1000 -> headroom 300 < 400 -> blocked.
    const second = await ledger.admit({ resourceKey: KEY, cost: 400, budget: 1000, poolId: "p2" });
    expect(second.admitted).toBe(false);
    expect(second.leaseId).toBe(null);
    expect(second.outstandingBefore).toBe(700);
    expect(second.headroomBefore).toBe(300);
    // A smaller request that fits is still admitted (headroom 300 >= 300).
    const third = await ledger.admit({ resourceKey: KEY, cost: 300, budget: 1000, poolId: "p3" });
    expect(third.admitted).toBe(true);
    expect(await ledger.outstanding(KEY)).toBe(1000);
  } finally {
    await cleanup();
  }
});

test("reconcile frees the reservation and is token-checked", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({ resourceKey: KEY, cost: 500, budget: 1000, poolId: "p1" });
    expect(await ledger.outstanding(KEY)).toBe(500);
    expect(await ledger.reconcile(KEY, d.leaseId)).toBe(true);
    expect(await ledger.outstanding(KEY)).toBe(0);
    // Reconciling an already-freed lease is a no-op.
    expect(await ledger.reconcile(KEY, d.leaseId)).toBe(false);
    // A budget that was blocked before is now admittable again.
    const again = await ledger.admit({ resourceKey: KEY, cost: 900, budget: 1000, poolId: "p2" });
    expect(again.admitted).toBe(true);
  } finally {
    await cleanup();
  }
});

test("non-finite budget admits optimistically (unbounded start; reactive floor corrects)", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({
      resourceKey: KEY,
      cost: 5_000_000,
      budget: Number.POSITIVE_INFINITY,
      poolId: "p1",
    });
    expect(d.admitted).toBe(true);
    expect(Number.isFinite(d.headroomBefore)).toBe(false);
  } finally {
    await cleanup();
  }
});

test("non-positive cost is always admitted with a lease (symmetric reconcile)", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({ resourceKey: KEY, cost: 0, budget: 0, poolId: "p1" });
    expect(d.admitted).toBe(true);
    expect(d.leaseId).toBeTruthy();
    // Cost clamps to 0, so it does not depress outstanding.
    expect(await ledger.outstanding(KEY)).toBe(0);
    expect(await ledger.reconcile(KEY, d.leaseId)).toBe(true);
  } finally {
    await cleanup();
  }
});

test("expired leases stop counting toward outstanding; budget returns automatically", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 5_000);
  try {
    await ledger.admit({ resourceKey: KEY, cost: 800, budget: 1000, poolId: "p1" });
    expect(await ledger.outstanding(KEY)).toBe(800);
    // Advance past the 5s TTL: the crashed consumer's lease no longer binds.
    nowRef.t = 1000 + 5_001;
    expect(await ledger.outstanding(KEY)).toBe(0);
    // A previously-blocked request now fits.
    const d = await ledger.admit({ resourceKey: KEY, cost: 900, budget: 1000, poolId: "p2" });
    expect(d.admitted).toBe(true);
    expect(d.outstandingBefore).toBe(0);
  } finally {
    await cleanup();
  }
});

test("reclaimExpired sweeps stale leases across keys", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 5_000);
  try {
    await ledger.admit({ resourceKey: KEY, cost: 100, budget: 1000, poolId: "p1" });
    await ledger.admit({ resourceKey: "codex#a/x", cost: 200, budget: 1000, poolId: "p2" });
    nowRef.t = 1000 + 5_001;
    expect(await ledger.reclaimExpired()).toBe(2);
    expect(await ledger.reclaimExpired()).toBe(0);
  } finally {
    await cleanup();
  }
});

test("two ledgers on the same file share outstanding (co-located account budget)", async () => {
  const nowRef = { t: 1000 };
  const { path, ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const peer = new ReservationLedger(path, () => nowRef.t, 60_000);
    await ledger.admit({ resourceKey: KEY, cost: 600, budget: 1000, poolId: "p1" });
    // The peer, sharing the same file, sees the first loop's lease and blocks.
    const peerAttempt = await peer.admit({ resourceKey: KEY, cost: 600, budget: 1000, poolId: "p2" });
    expect(peerAttempt.admitted).toBe(false);
    expect(peerAttempt.outstandingBefore).toBe(600);
  } finally {
    await cleanup();
  }
});

test("snapshot returns only live leases", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 5_000);
  try {
    // First lease at t=1000 (expires 6000); second at t=3000 (expires 8000).
    await ledger.admit({ resourceKey: KEY, cost: 100, budget: 1000, poolId: "p1" });
    nowRef.t = 3_000;
    await ledger.admit({ resourceKey: KEY, cost: 200, budget: 1000, poolId: "p2" });
    // Advance so ONLY the first lease has expired (t=7000: past 6000, before 8000).
    nowRef.t = 7_000;
    const snap = await ledger.snapshot();
    expect(snap[KEY].length).toBe(1);
    expect(snap[KEY][0].poolId).toBe("p2");
  } finally {
    await cleanup();
  }
});

test("a corrupt ledger file degrades to empty; admission still works", async () => {
  const nowRef = { t: 1000 };
  const { path, ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    await writeFile(path, "{ this is not json", "utf8");
    const d = await ledger.admit({ resourceKey: KEY, cost: 300, budget: 1000, poolId: "p1" });
    expect(d.admitted).toBe(true);
    expect(d.outstandingBefore).toBe(0);
  } finally {
    await cleanup();
  }
});
