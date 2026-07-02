import { test, expect } from "vitest";
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
    expect(winners.length, "exactly one loop may claim the node").toBe(1);
    expect(losers.length).toBe(3);
    for (const loser of losers) {
      expect(loser.heldBy).toBe(winners[0].ownerToken);
    }
    expect(await loopA.isClaimed("node-1")).toBe(true);

    const other = await loopB.claim("node-2", "poolB");
    expect(other.acquired).toBe(true);
    expect(Object.keys(await loopA.listClaims()).sort()).toEqual(["node-1", "node-2"]);
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
    expect(first.acquired).toBe(true);

    nowMs += STALE_LOCK_MS; // exactly at the window — still live
    expect(await reg.reclaimStale()).toEqual([]);
    expect(await reg.isClaimed("node-1")).toBe(true);

    nowMs += 1; // past the window — now stale
    expect(await reg.isClaimed("node-1")).toBe(false);
    expect(await reg.reclaimStale()).toEqual(["node-1"]);
    expect(Object.keys(await reg.listClaims())).toEqual([]);

    const second = await reg.claim("node-1", "poolB");
    expect(second.acquired).toBe(true);
    expect(second.ownerToken).not.toBe(first.ownerToken);
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
    expect(await reg.heartbeat("node-1", token)).toBe(true);

    nowMs += 1; // would be stale vs the original claim, but the heartbeat refreshed it
    expect(await reg.reclaimStale()).toEqual([]);
    expect(await reg.isClaimed("node-1")).toBe(true);

    expect(await reg.release("node-1", "not-the-owner")).toBe(false);
    expect(await reg.isClaimed("node-1")).toBe(true);
    expect(await reg.heartbeat("node-1", "not-the-owner")).toBe(false);
    expect(await reg.release("node-1", token)).toBe(true);
    expect(await reg.isClaimed("node-1")).toBe(false);
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
    expect(claim.acquired).toBe(true);
    const onDisk = JSON.parse(await readFile(registryPath, "utf8"));
    expect(Object.keys(onDisk)).toEqual(["node-1"]);

    await writeFile(registryPath, "[1,2,3]", "utf8");
    const reg2 = new ClaimRegistry(registryPath);
    expect(await reg2.listClaims()).toEqual({});
    expect((await reg2.claim("node-2", "poolB")).acquired).toBe(true);

    await writeFile(
      registryPath,
      JSON.stringify({
        good: { ownerToken: "t", poolId: "p", heartbeatAt: Date.now() },
        bad: { nope: true },
      }),
      "utf8",
    );
    const reg3 = new ClaimRegistry(registryPath);
    expect(Object.keys(await reg3.listClaims())).toEqual(["good"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
