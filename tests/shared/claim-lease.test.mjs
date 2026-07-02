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
