import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import the source directly (build-free under tsx/esm); the self-ref
// `audit-tools/shared` would resolve to dist, which the central build owns.
const { ClaimRegistry } = await import("../../src/shared/quota/claimRegistry.ts");
const { STALE_LOCK_MS } = await import("../../src/shared/quota/fileLock.ts");

async function tmpRegistry() {
  const dir = await mkdtemp(join(tmpdir(), "a10-claim-"));
  return { dir, registryPath: join(dir, "claims.json") };
}

test("grants a node to exactly one of two concurrent loops (single-grant)", async () => {
  const { dir, registryPath } = await tmpRegistry();
  try {
    const loopA = new ClaimRegistry(registryPath);
    const loopB = new ClaimRegistry(registryPath);

    const attempts = await Promise.all([
      loopA.claim("node-1", "poolA"),
      loopB.claim("node-1", "poolB"),
      loopA.claim("node-1", "poolA"),
      loopB.claim("node-1", "poolB"),
    ]);

    const winners = attempts.filter((r) => r.acquired);
    const losers = attempts.filter((r) => !r.acquired);
    assert.equal(winners.length, 1, "exactly one loop may claim the node");
    assert.equal(losers.length, 3);
    for (const loser of losers) {
      assert.equal(loser.heldBy, winners[0].ownerToken);
    }
    assert.equal(await loopA.isClaimed("node-1"), true);

    const other = await loopB.claim("node-2", "poolB");
    assert.equal(other.acquired, true);
    assert.deepEqual(Object.keys(await loopA.listClaims()).sort(), ["node-1", "node-2"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reclaims a claim once its heartbeat passes STALE_LOCK_MS (stale-reclaim clock)", async () => {
  const { dir, registryPath } = await tmpRegistry();
  try {
    let nowMs = 1_000_000;
    const reg = new ClaimRegistry(registryPath, () => nowMs);

    const first = await reg.claim("node-1", "poolA");
    assert.equal(first.acquired, true);

    nowMs += STALE_LOCK_MS; // exactly at the window — still live
    assert.deepEqual(await reg.reclaimStale(), []);
    assert.equal(await reg.isClaimed("node-1"), true);

    nowMs += 1; // past the window — now stale
    assert.equal(await reg.isClaimed("node-1"), false);
    assert.deepEqual(await reg.reclaimStale(), ["node-1"]);
    assert.deepEqual(Object.keys(await reg.listClaims()), []);

    const second = await reg.claim("node-1", "poolB");
    assert.equal(second.acquired, true);
    assert.notEqual(second.ownerToken, first.ownerToken);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("never clobbers a re-heartbeated live owner (token-survival)", async () => {
  const { dir, registryPath } = await tmpRegistry();
  try {
    let nowMs = 1_000_000;
    const reg = new ClaimRegistry(registryPath, () => nowMs);

    const claim = await reg.claim("node-1", "poolA");
    const token = claim.ownerToken;

    nowMs += STALE_LOCK_MS;
    assert.equal(await reg.heartbeat("node-1", token), true);

    nowMs += 1; // would be stale vs the original claim, but the heartbeat refreshed it
    assert.deepEqual(await reg.reclaimStale(), []);
    assert.equal(await reg.isClaimed("node-1"), true);

    assert.equal(await reg.release("node-1", "not-the-owner"), false);
    assert.equal(await reg.isClaimed("node-1"), true);
    assert.equal(await reg.heartbeat("node-1", "not-the-owner"), false);
    assert.equal(await reg.release("node-1", token), true);
    assert.equal(await reg.isClaimed("node-1"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("degrades a corrupt registry to empty instead of throwing (malformed)", async () => {
  const { dir, registryPath } = await tmpRegistry();
  try {
    await writeFile(registryPath, "{ not valid json ::::", "utf8");
    const reg = new ClaimRegistry(registryPath);
    const claim = await reg.claim("node-1", "poolA");
    assert.equal(claim.acquired, true);
    const onDisk = JSON.parse(await readFile(registryPath, "utf8"));
    assert.deepEqual(Object.keys(onDisk), ["node-1"]);

    await writeFile(registryPath, "[1,2,3]", "utf8");
    const reg2 = new ClaimRegistry(registryPath);
    assert.deepEqual(await reg2.listClaims(), {});
    assert.equal((await reg2.claim("node-2", "poolB")).acquired, true);

    await writeFile(
      registryPath,
      JSON.stringify({
        good: { ownerToken: "t", poolId: "p", heartbeatAt: Date.now() },
        bad: { nope: true },
      }),
      "utf8",
    );
    const reg3 = new ClaimRegistry(registryPath);
    assert.deepEqual(Object.keys(await reg3.listClaims()), ["good"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
