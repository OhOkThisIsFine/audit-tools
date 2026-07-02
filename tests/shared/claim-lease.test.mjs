/**
 * claim-lease.test.mjs
 *
 * Slice 1 of multi-agent cooperative runs (spec/multi-ide-concurrent-runs-design.md):
 * the claimWithBackoff (OD1 bounded backoff) + withClaimHeartbeat (OD3 layer 1:
 * heartbeat-driven ownership re-validation) helpers on top of ClaimRegistry.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { ClaimRegistry } = await import("../../src/shared/quota/claimRegistry.ts");
const { claimWithBackoff, withClaimHeartbeat, DEFAULT_CLAIM_BACKOFF_MS } =
  await import("../../src/shared/quota/claimLease.ts");

async function tempRegistry() {
  const dir = await mkdtemp(join(tmpdir(), "claim-lease-"));
  const registry = new ClaimRegistry(join(dir, "node-claims.json"));
  return { dir, registry, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("claimWithBackoff acquires an unheld node on the first attempt", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    const sleeps = [];
    const res = await claimWithBackoff(registry, "n1", {
      poolId: "p",
      sleepFn: async (ms) => void sleeps.push(ms),
    });
    assert.equal(res.acquired, true);
    assert.equal(sleeps.length, 0, "no backoff waits when uncontended");
  } finally {
    await cleanup();
  }
});

test("claimWithBackoff exhausts the backoff then returns not-acquired when held", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    // A peer holds it with a live (freshly heartbeated) claim.
    const held = await registry.claim("n1", "peer");
    assert.equal(held.acquired, true);

    const sleeps = [];
    const res = await claimWithBackoff(registry, "n1", {
      poolId: "p",
      backoffMs: [1, 2, 3],
      sleepFn: async (ms) => void sleeps.push(ms),
    });
    assert.equal(res.acquired, false);
    assert.equal(res.heldBy, held.ownerToken);
    assert.deepEqual(sleeps, [1, 2, 3], "waited through the full backoff before giving up");
  } finally {
    await cleanup();
  }
});

test("claimWithBackoff picks up a node freed mid-backoff", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    const held = await registry.claim("n1", "peer");
    const sleeps = [];
    // Release the peer's claim on the first backoff wait, so the 2nd attempt wins.
    const res = await claimWithBackoff(registry, "n1", {
      poolId: "p",
      backoffMs: [1, 1, 1],
      sleepFn: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 1) await registry.release("n1", held.ownerToken);
      },
    });
    assert.equal(res.acquired, true);
    assert.equal(sleeps.length, 1, "won on the retry right after the first wait");
  } finally {
    await cleanup();
  }
});

test("DEFAULT_CLAIM_BACKOFF_MS is a non-empty increasing schedule", () => {
  assert.ok(DEFAULT_CLAIM_BACKOFF_MS.length >= 1);
  for (let i = 1; i < DEFAULT_CLAIM_BACKOFF_MS.length; i++) {
    assert.ok(DEFAULT_CLAIM_BACKOFF_MS[i] > DEFAULT_CLAIM_BACKOFF_MS[i - 1]);
  }
});

test("withClaimHeartbeat refreshes a held claim and runs fn to completion", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    const held = await registry.claim("n1", "me");
    let ticks = 0;
    // Deterministic fake timer: capture the callback, fire it manually.
    let fired;
    const fakeSetInterval = (cb) => {
      fired = cb;
      return { unref() {} };
    };
    const fakeClearInterval = () => {};
    const out = await withClaimHeartbeat(
      registry,
      "n1",
      held.ownerToken,
      { intervalMs: 10, setIntervalFn: fakeSetInterval, clearIntervalFn: fakeClearInterval },
      async () => {
        fired(); // simulate one heartbeat tick during execution
        await new Promise((r) => setTimeout(r, 5));
        ticks++;
        return "done";
      },
    );
    assert.equal(out, "done");
    assert.equal(ticks, 1);
  } finally {
    await cleanup();
  }
});

test("claimMany grants only free nodes; a second peer gets the disjoint remainder", async () => {
  const { dir, cleanup } = await tempRegistry();
  try {
    const path = join(dir, "task-claims.json");
    const { ClaimRegistry: CR } = await import("../../src/shared/quota/claimRegistry.ts");
    const peerA = new CR(path);
    const peerB = new CR(path);

    const a = await peerA.claimMany(["t1", "t2", "t3", "t4"], "A");
    assert.deepEqual(a.granted.sort(), ["t1", "t2", "t3", "t4"]);
    for (const id of a.granted) assert.equal(typeof a.ownerTokenByNode[id], "string");

    // Peer B asks for an overlapping set; gets only the tasks A didn't already hold.
    const b = await peerB.claimMany(["t3", "t4", "t5", "t6"], "B");
    assert.deepEqual(b.granted.sort(), ["t5", "t6"], "disjoint from A's live claims");
  } finally {
    await cleanup();
  }
});

test("claimMany re-grants the SAME pool's own live claims (idempotent re-partition)", async () => {
  const { dir, cleanup } = await tempRegistry();
  try {
    const path = join(dir, "task-claims.json");
    const { ClaimRegistry: CR } = await import("../../src/shared/quota/claimRegistry.ts");
    const reg = new CR(path);

    // Run "R1" claims its partition, then re-runs the SAME partition (e.g. a
    // second prepare-dispatch within one audit run before ingest): it must
    // re-grant its own in-flight tasks, not skip them.
    const first = await reg.claimMany(["t1", "t2", "t3"], "R1");
    assert.deepEqual(first.granted.sort(), ["t1", "t2", "t3"]);
    const again = await reg.claimMany(["t1", "t2", "t3"], "R1");
    assert.deepEqual(again.granted.sort(), ["t1", "t2", "t3"], "same run re-grants its own claims");

    // A DIFFERENT run (distinct poolId) is still partitioned off.
    const other = await reg.claimMany(["t1", "t2", "t4"], "R2");
    assert.deepEqual(other.granted.sort(), ["t4"], "different run skips R1's live claims");
  } finally {
    await cleanup();
  }
});

test("clear removes claims unconditionally (no token) and reports the count", async () => {
  const { dir, cleanup } = await tempRegistry();
  try {
    const path = join(dir, "task-claims.json");
    const { ClaimRegistry: CR } = await import("../../src/shared/quota/claimRegistry.ts");
    const reg = new CR(path);
    await reg.claimMany(["t1", "t2", "t3"], "A");

    const removed = await reg.clear(["t1", "t3", "missing"]);
    assert.equal(removed, 2, "only present nodes count; missing ignored");

    // t1/t3 are now free for anyone; t2 still held.
    const re = await reg.claimMany(["t1", "t2", "t3"], "B");
    assert.deepEqual(re.granted.sort(), ["t1", "t3"], "cleared nodes reclaimable, t2 still held");
  } finally {
    await cleanup();
  }
});

test("ClaimRegistry honors a per-registry stale window (OD3 long lease)", async () => {
  const { dir, cleanup } = await tempRegistry();
  try {
    let clock = 1_000;
    const now = () => clock;
    // Long lease: 10_000ms window on a registry pointed at the same file.
    const longPath = join(dir, "long-claims.json");
    const { ClaimRegistry: CR } = await import("../../src/shared/quota/claimRegistry.ts");
    const reg = new CR(longPath, now, 10_000);

    const mine = await reg.claim("t1", "peerA");
    assert.equal(mine.acquired, true);

    // 5s later: within the 10s window → still owned, a rival cannot claim.
    clock = 6_000;
    const rivalEarly = await reg.claim("t1", "peerB");
    assert.equal(rivalEarly.acquired, false, "not stale before the configured window");

    // 11s after the claim: past the 10s window → reclaimable.
    clock = 12_000;
    const rivalLate = await reg.claim("t1", "peerB");
    assert.equal(rivalLate.acquired, true, "reclaimable once past the configured window");
  } finally {
    await cleanup();
  }
});

test("withClaimHeartbeat fires onRevoked when the claim was reclaimed by a peer", async () => {
  const { registry, cleanup } = await tempRegistry();
  try {
    const mine = await registry.claim("n1", "me");
    // Force-steal: overwrite with a peer's fresh claim via a stale-window trick —
    // simplest is to release mine and let a peer take it, so my token no longer owns.
    await registry.release("n1", mine.ownerToken);
    await registry.claim("n1", "peer");

    let revoked = false;
    let fired;
    const out = await withClaimHeartbeat(
      registry,
      "n1",
      mine.ownerToken, // no longer the owner
      {
        intervalMs: 10,
        setIntervalFn: (cb) => {
          fired = cb;
          return { unref() {} };
        },
        clearIntervalFn: () => {},
        onRevoked: () => {
          revoked = true;
        },
      },
      async () => {
        fired(); // heartbeat tick observes we no longer own it
        // give the async heartbeat().then() a turn to resolve
        await new Promise((r) => setTimeout(r, 20));
        return "finished-anyway";
      },
    );
    assert.equal(out, "finished-anyway");
    assert.equal(revoked, true, "onRevoked fired because heartbeat returned false");
  } finally {
    await cleanup();
  }
});
