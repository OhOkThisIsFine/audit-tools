/**
 * reservation-ledger.test.mjs
 *
 * The proactive token-reservation ledger (spec/audit/dispatch-admission-control.md).
 * Generalizes the ClaimRegistry pattern from task-claiming to quota-claiming:
 * resourceKey -> token leases, budget-gated admission under withFileLock, leases
 * expire so a crashed consumer never strands budget, reconcile frees on completion,
 * and two ledgers on the same file share outstanding (co-located account budget).
 *
 * Admission is MULTI-CONSTRAINT and all-or-nothing (account-metering design of
 * record, 2026-07-19): a dispatch draws against every window that applies to it —
 * an account-wide allowance shared with sibling models plus any model-scoped one —
 * and is admitted only if every constraint clears.
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

/** Single-constraint admit — the degenerate case, still the common one. */
function one(resourceKey, cost, budget, poolId) {
  return { constraints: [{ resourceKey, budget, cost }], poolId };
}

test("admits when budget covers cost; outstanding + headroom reflect the lease", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit(one(KEY, 300, 1000, "p1"));
    expect(d.admitted).toBe(true);
    expect(d.leaseId).toBeTruthy();
    expect(d.binding.outstandingBefore).toBe(0);
    expect(d.binding.headroomBefore).toBe(1000);
    expect(await ledger.outstanding(KEY)).toBe(300);
  } finally {
    await cleanup();
  }
});

test("second admit sees the first's outstanding lease and blocks when budget is exhausted", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const first = await ledger.admit(one(KEY, 700, 1000, "p1"));
    expect(first.admitted).toBe(true);
    // 700 in flight, budget 1000 -> headroom 300 < 400 -> blocked.
    const second = await ledger.admit(one(KEY, 400, 1000, "p2"));
    expect(second.admitted).toBe(false);
    expect(second.leaseId).toBe(null);
    expect(second.binding.outstandingBefore).toBe(700);
    expect(second.binding.headroomBefore).toBe(300);
    // A smaller request that fits is still admitted (headroom 300 >= 300).
    const third = await ledger.admit(one(KEY, 300, 1000, "p3"));
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
    const d = await ledger.admit(one(KEY, 500, 1000, "p1"));
    expect(await ledger.outstanding(KEY)).toBe(500);
    expect(await ledger.reconcile(d.leaseId)).toBe(true);
    expect(await ledger.outstanding(KEY)).toBe(0);
    // Reconciling an already-freed lease is a no-op.
    expect(await ledger.reconcile(d.leaseId)).toBe(false);
    // A budget that was blocked before is now admittable again.
    const again = await ledger.admit(one(KEY, 900, 1000, "p2"));
    expect(again.admitted).toBe(true);
  } finally {
    await cleanup();
  }
});

test("non-finite budget admits optimistically (unbounded start; reactive floor corrects)", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit(one(KEY, 5_000_000, Number.POSITIVE_INFINITY, "p1"));
    expect(d.admitted).toBe(true);
    expect(Number.isFinite(d.binding.headroomBefore)).toBe(false);
  } finally {
    await cleanup();
  }
});

test("non-positive cost is always admitted with a lease (symmetric reconcile)", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit(one(KEY, 0, 0, "p1"));
    expect(d.admitted).toBe(true);
    expect(d.leaseId).toBeTruthy();
    // Cost clamps to 0, so it does not depress outstanding.
    expect(await ledger.outstanding(KEY)).toBe(0);
    expect(await ledger.reconcile(d.leaseId)).toBe(true);
  } finally {
    await cleanup();
  }
});

test("expired leases stop counting toward outstanding; budget returns automatically", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 5_000);
  try {
    await ledger.admit(one(KEY, 800, 1000, "p1"));
    expect(await ledger.outstanding(KEY)).toBe(800);
    // Advance past the 5s TTL: the crashed consumer's lease no longer binds.
    nowRef.t = 1000 + 5_001;
    expect(await ledger.outstanding(KEY)).toBe(0);
    // A previously-blocked request now fits.
    const d = await ledger.admit(one(KEY, 900, 1000, "p2"));
    expect(d.admitted).toBe(true);
    expect(d.binding.outstandingBefore).toBe(0);
  } finally {
    await cleanup();
  }
});

test("reclaimExpired sweeps stale leases across keys", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 5_000);
  try {
    await ledger.admit(one(KEY, 100, 1000, "p1"));
    await ledger.admit(one("codex#a/x", 200, 1000, "p2"));
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
    await ledger.admit(one(KEY, 600, 1000, "p1"));
    // The peer, sharing the same file, sees the first loop's lease and blocks.
    const peerAttempt = await peer.admit(one(KEY, 600, 1000, "p2"));
    expect(peerAttempt.admitted).toBe(false);
    expect(peerAttempt.binding.outstandingBefore).toBe(600);
  } finally {
    await cleanup();
  }
});

test("snapshot returns only live leases", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 5_000);
  try {
    // First lease at t=1000 (expires 6000); second at t=3000 (expires 8000).
    await ledger.admit(one(KEY, 100, 1000, "p1"));
    nowRef.t = 3_000;
    await ledger.admit(one(KEY, 200, 1000, "p2"));
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
    const d = await ledger.admit(one(KEY, 300, 1000, "p1"));
    expect(d.admitted).toBe(true);
    expect(d.binding.outstandingBefore).toBe(0);
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Multi-constraint admission — the account-metering partition.
// ---------------------------------------------------------------------------

const ACCOUNT_SESSION = "claude-code#acct-1::session";
const MODEL_SESSION = "claude-code#acct-1/sonnet::session";

test("a model-scoped window blocks even when the shared account window has room", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 10 },
        { resourceKey: MODEL_SESSION, budget: 5, cost: 10 },
      ],
    });
    expect(d.admitted).toBe(false);
    expect(d.leaseId).toBe(null);
    // Every constraint is evaluated, not just up to the first failure.
    expect(d.constraints.map((c) => c.cleared)).toEqual([true, false]);
    // The binding constraint is the one that blocked.
    expect(d.binding.resourceKey).toBe(MODEL_SESSION);
  } finally {
    await cleanup();
  }
});

test("a blocked multi-constraint admit writes NOTHING — no partial reservation", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 10 },
        { resourceKey: MODEL_SESSION, budget: 5, cost: 10 },
      ],
    });
    expect(d.admitted).toBe(false);
    // The account window must NOT hold a stranded reservation for a dispatch that
    // never went out — that is the leak all-or-nothing exists to make impossible.
    expect(await ledger.outstanding(ACCOUNT_SESSION)).toBe(0);
    expect(await ledger.outstanding(MODEL_SESSION)).toBe(0);
  } finally {
    await cleanup();
  }
});

test("siblings on one account share the account window; each keeps its own model window", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const sonnetModel = "claude-code#acct-1/sonnet::session";
    const opusModel = "claude-code#acct-1/opus::session";
    // Sonnet takes 60 of the shared 100.
    const first = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 60 },
        { resourceKey: sonnetModel, budget: 1000, cost: 60 },
      ],
    });
    expect(first.admitted).toBe(true);
    // Opus has a wide-open model window but the ACCOUNT window only has 40 left.
    // This is the ledger-level mechanism that CAN express the N× over-admission
    // fix. It is not itself the fix: no production caller supplies an account
    // constraint yet (steps 3-4), so the live N× bug is still open.
    const second = await ledger.admit({
      poolId: "opus",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 60 },
        { resourceKey: opusModel, budget: 1000, cost: 60 },
      ],
    });
    expect(second.admitted).toBe(false);
    expect(second.binding.resourceKey).toBe(ACCOUNT_SESSION);
    expect(second.binding.headroomBefore).toBe(40);
    // Opus's own model window was never charged for the refused dispatch.
    expect(await ledger.outstanding(opusModel)).toBe(0);
  } finally {
    await cleanup();
  }
});

test("reconcile by lease id releases EVERY key the lease was recorded under", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 30 },
        { resourceKey: MODEL_SESSION, budget: 100, cost: 30 },
      ],
    });
    expect(d.admitted).toBe(true);
    expect(await ledger.outstanding(ACCOUNT_SESSION)).toBe(30);
    expect(await ledger.outstanding(MODEL_SESSION)).toBe(30);
    expect(await ledger.reconcile(d.leaseId)).toBe(true);
    // Both released — the caller cannot leak one window by forgetting a key.
    expect(await ledger.outstanding(ACCOUNT_SESSION)).toBe(0);
    expect(await ledger.outstanding(MODEL_SESSION)).toBe(0);
  } finally {
    await cleanup();
  }
});

test("windows meter in their OWN unit — binding is the tightest RATIO, not the smallest headroom", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    // Genuinely different units: a percent-denominated account window (budget 100)
    // and a token-denominated model window (budget 500_000). Raw headroom would
    // always name the percent window as "tightest" purely because its numbers are
    // smaller — here the TOKEN window is the one actually close to blocking.
    const modelTokens = "claude-code#acct-1/sonnet::tokens";
    const d = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 2 }, // 2% of headroom
        { resourceKey: modelTokens, budget: 500_000, cost: 450_000 }, // 90% of headroom
      ],
    });
    expect(d.admitted).toBe(true);
    expect(await ledger.outstanding(ACCOUNT_SESSION)).toBe(2);
    expect(await ledger.outstanding(modelTokens)).toBe(450_000);
    // Smallest headroom is the account window (98); the tightest is the token one.
    expect(d.binding.resourceKey).toBe(modelTokens);
  } finally {
    await cleanup();
  }
});

test("binding does not depend on the order the caller listed constraints in", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const tight = { resourceKey: MODEL_SESSION, budget: 10, cost: 9 };
    const loose = { resourceKey: ACCOUNT_SESSION, budget: 1000, cost: 1 };
    const forward = await ledger.admit({ poolId: "a", constraints: [tight, loose] });
    await ledger.reconcile(forward.leaseId);
    const reversed = await ledger.admit({ poolId: "a", constraints: [loose, tight] });
    expect(forward.binding.resourceKey).toBe(MODEL_SESSION);
    expect(reversed.binding.resourceKey).toBe(MODEL_SESSION);
  } finally {
    await cleanup();
  }
});

test("a repeated resourceKey accumulates within one attempt (no double-spend)", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 60 },
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 60 },
      ],
    });
    // 60 + 60 > 100: the second constraint sees the first's draw as outstanding.
    expect(d.admitted).toBe(false);
    expect(d.constraints[1].outstandingBefore).toBe(60);
  } finally {
    await cleanup();
  }
});

test("UNEQUAL sibling budgets: the smaller model window binds its own pool only", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    // nim-nano and nim-super share one credential but have genuinely different
    // model allowances (200 vs 1000). The earlier refused repair collapsed these
    // onto one budget and starved the smaller pool to zero; each must keep its own.
    const account = "nim#acct-1::session";
    const nano = "nim#acct-1/nano::session";
    const superb = "nim#acct-1/super::session";
    const nanoDraw = await ledger.admit({
      poolId: "nano",
      constraints: [
        { resourceKey: account, budget: 10_000, cost: 150 },
        { resourceKey: nano, budget: 200, cost: 150 },
      ],
    });
    expect(nanoDraw.admitted).toBe(true);
    // nano is now nearly out of its OWN window...
    const nanoAgain = await ledger.admit({
      poolId: "nano",
      constraints: [
        { resourceKey: account, budget: 10_000, cost: 150 },
        { resourceKey: nano, budget: 200, cost: 150 },
      ],
    });
    expect(nanoAgain.admitted).toBe(false);
    expect(nanoAgain.binding.resourceKey).toBe(nano);
    // ...but super is untouched: the small sibling's exhaustion must not starve it.
    const superDraw = await ledger.admit({
      poolId: "super",
      constraints: [
        { resourceKey: account, budget: 10_000, cost: 900 },
        { resourceKey: superb, budget: 1000, cost: 900 },
      ],
    });
    expect(superDraw.admitted).toBe(true);
  } finally {
    await cleanup();
  }
});

test("an UNCALIBRATED sibling's non-finite budget is unbounded on its own window only", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    // A pool with no learned exchange rate for its model window cannot price that
    // constraint; the caller passes +Infinity (optimistic start). The SHARED
    // account window must still bind it — an uncalibrated model must not become a
    // hole through which the account allowance leaks.
    //
    // NOTE: keeping the uncalibrated pool out of dispatch entirely (the design's
    // cold-start probe path) is the CALLER's obligation in steps 3-4, not the
    // ledger's. What is pinned here is that the ledger does not let the non-finite
    // budget on one constraint weaken a finite budget on another.
    const account = "nim#acct-1::session";
    const uncal = "nim#acct-1/fresh::session";
    await ledger.admit({
      poolId: "calibrated",
      constraints: [{ resourceKey: account, budget: 100, cost: 95 }],
    });
    const d = await ledger.admit({
      poolId: "fresh",
      constraints: [
        { resourceKey: account, budget: 100, cost: 50 },
        { resourceKey: uncal, budget: Number.POSITIVE_INFINITY, cost: 50 },
      ],
    });
    expect(d.admitted).toBe(false);
    expect(d.binding.resourceKey).toBe(account);
  } finally {
    await cleanup();
  }
});

test("binding names the BLOCKED constraint even when a cleared one sits at zero headroom", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    // A zero-cost constraint on an exhausted window CLEARS (nothing is drawn), so it
    // must rank loosest. Ranking headroom before cost made it score +Infinity and
    // outrank the constraint that actually blocked — misnaming the binding window.
    const d = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 0, cost: 0 },
        { resourceKey: MODEL_SESSION, budget: 10, cost: 100 },
      ],
    });
    expect(d.admitted).toBe(false);
    expect(d.constraints.map((c) => c.cleared)).toEqual([true, false]);
    expect(d.binding.resourceKey).toBe(MODEL_SESSION);
  } finally {
    await cleanup();
  }
});

test("tied tightness breaks on the key, not on caller order", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    // Two exhausted windows both score +Infinity. Without a deterministic tiebreak
    // the reduce keeps whichever the caller listed first.
    const a = { resourceKey: "aaa::session", budget: 0, cost: 5 };
    const b = { resourceKey: "bbb::session", budget: 0, cost: 5 };
    const forward = await ledger.admit({ poolId: "p", constraints: [a, b] });
    const reversed = await ledger.admit({ poolId: "p", constraints: [b, a] });
    expect(forward.binding.resourceKey).toBe("aaa::session");
    expect(reversed.binding.resourceKey).toBe("aaa::session");
  } finally {
    await cleanup();
  }
});

test("TWO ACCOUNTS on one backend_provider meter independently", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    // Same provider, two credentials. Exhausting one account's window must leave
    // the other's untouched — the partition is per ACCOUNT, not per provider.
    //
    // NOTE — this pins only the LEDGER half, which is nearly trivial: two distinct
    // map keys do not share a bucket. The substantive risk the design names is
    // whether account-key DERIVATION (`accountId.ts`) actually distinguishes two
    // credentials on one backend_provider — that is what an earlier review round
    // was about, and it is NOT covered here. Tracked in docs/backlog.md.
    const acctA = "nim#acct-a::session";
    const acctB = "nim#acct-b::session";
    const first = await ledger.admit({
      poolId: "a/model",
      constraints: [{ resourceKey: acctA, budget: 100, cost: 100 }],
    });
    expect(first.admitted).toBe(true);
    const sameAccount = await ledger.admit({
      poolId: "a/model",
      constraints: [{ resourceKey: acctA, budget: 100, cost: 1 }],
    });
    expect(sameAccount.admitted).toBe(false);
    const otherAccount = await ledger.admit({
      poolId: "b/model",
      constraints: [{ resourceKey: acctB, budget: 100, cost: 100 }],
    });
    expect(otherAccount.admitted).toBe(true);
  } finally {
    await cleanup();
  }
});

test("anyOutstanding is the ACROSS-constraint aggregate, not the blocking one's total", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    // The rolling dispatcher force-admits unbounded when a block happens with
    // NOTHING in flight anywhere (waiting could never help). Take a lease on the
    // account window, then block on an idle model window: the blocking constraint's
    // own outstanding is 0, but something IS in flight and will free room.
    // Reading the blocked constraint's own number here would force-dispatch
    // straight into overshoot.
    await ledger.admit({
      poolId: "sibling",
      constraints: [{ resourceKey: ACCOUNT_SESSION, budget: 100_000, cost: 60_000 }],
    });
    const d = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: MODEL_SESSION, budget: 1000, cost: 5000 },
        { resourceKey: ACCOUNT_SESSION, budget: 100_000, cost: 5000 },
      ],
    });
    expect(d.admitted).toBe(false);
    expect(d.binding.resourceKey).toBe(MODEL_SESSION);
    expect(d.binding.outstandingBefore).toBe(0);
    // ...yet the aggregate correctly reports that budget IS held elsewhere.
    expect(d.anyOutstanding).toBe(true);
  } finally {
    await cleanup();
  }
});

test("anyOutstanding is false when nothing is held anywhere (backstop may force)", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({
      poolId: "sonnet",
      constraints: [
        { resourceKey: MODEL_SESSION, budget: 1000, cost: 5000 },
        { resourceKey: ACCOUNT_SESSION, budget: 100_000, cost: 5000 },
      ],
    });
    expect(d.admitted).toBe(false);
    expect(d.anyOutstanding).toBe(false);
  } finally {
    await cleanup();
  }
});

test("a negative cost cannot manufacture headroom for peers", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    // Clamped once, so what is validated is what is persisted. An unclamped -50
    // would land on the lease and net the key's outstanding down to 50, handing
    // every co-located peer 50 units of headroom that do not exist.
    const d = await ledger.admit({
      poolId: "p1",
      constraints: [
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: -50 },
        { resourceKey: ACCOUNT_SESSION, budget: 100, cost: 100 },
      ],
    });
    expect(d.admitted).toBe(true);
    expect(await ledger.outstanding(ACCOUNT_SESSION)).toBe(100);
  } finally {
    await cleanup();
  }
});

test("an empty constraint set is admitted unmetered, with a lease for symmetry", async () => {
  const nowRef = { t: 1000 };
  const { ledger, cleanup } = await tempLedger(nowRef, 60_000);
  try {
    const d = await ledger.admit({ poolId: "p1", constraints: [] });
    expect(d.admitted).toBe(true);
    expect(d.leaseId).toBeTruthy();
    expect(d.binding).toBe(null);
    // Nothing was reserved, so reconcile finds nothing to free.
    expect(await ledger.reconcile(d.leaseId)).toBe(false);
  } finally {
    await cleanup();
  }
});
