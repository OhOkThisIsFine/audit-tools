/**
 * A-10: on-disk ClaimRegistry — the dispatch-loop mutual-exclusion primitive.
 *
 * A claim is a soft lease a loop takes on a node before working it, so two
 * concurrent loops driving the same goal can never both pick the same node. The
 * entire read-modify-write runs inside `withFileLock(registryPath + '.lock')`, so
 * the check-then-claim is atomic across processes. Staleness reuses the file
 * lock's STALE_LOCK_MS verbatim; release/reclaim are token-checked so a
 * re-heartbeated live owner is never clobbered.
 *
 * Verifies:
 *   single-grant   two concurrent loops racing the SAME node → exactly one
 *                  acquires; the loser sees `{ acquired:false, heldBy }`.
 *   stale-reclaim  a claim past STALE_LOCK_MS (driven by an injected clock) is
 *                  reclaimable and is then re-grantable.
 *   token-survival a claim re-heartbeated before a reclaim survives; its owner
 *                  token still releases it.
 *   malformed      a corrupt registry file degrades to empty — claim never throws.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaimRegistry, STALE_LOCK_MS } from 'audit-tools/shared';

describe('A-10 ClaimRegistry', () => {
  let dir: string;
  let registryPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'a10-claim-'));
    registryPath = join(dir, 'claims.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('grants a node to exactly one of two concurrent loops (single-grant)', async () => {
    // Two independent registry handles on the SAME file = two loops, two processes.
    const loopA = new ClaimRegistry(registryPath);
    const loopB = new ClaimRegistry(registryPath);

    // Fire a burst of concurrent claims for the same node from both loops. The
    // lock-serialized read-modify-write must admit exactly one winner.
    const attempts = await Promise.all([
      loopA.claim('node-1', 'poolA'),
      loopB.claim('node-1', 'poolB'),
      loopA.claim('node-1', 'poolA'),
      loopB.claim('node-1', 'poolB'),
    ]);

    const winners = attempts.filter((r) => r.acquired);
    const losers = attempts.filter((r) => !r.acquired);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);

    const winnerToken = (winners[0] as { acquired: true; ownerToken: string }).ownerToken;
    // Every loser points at the live owner's token.
    for (const loser of losers) {
      expect((loser as { acquired: false; heldBy: string }).heldBy).toBe(winnerToken);
    }
    expect(await loopA.isClaimed('node-1')).toBe(true);

    // A second distinct node is independently grantable.
    const other = await loopB.claim('node-2', 'poolB');
    expect(other.acquired).toBe(true);
    expect(Object.keys(await loopA.listClaims()).sort()).toEqual(['node-1', 'node-2']);
  });

  it('reclaims a claim once its heartbeat passes STALE_LOCK_MS (stale-reclaim clock)', async () => {
    let nowMs = 1_000_000;
    const clock = () => nowMs;
    const reg = new ClaimRegistry(registryPath, clock);

    const first = await reg.claim('node-1', 'poolA');
    expect(first.acquired).toBe(true);

    // Just under the window: still live, nothing reclaimed, still claimed.
    nowMs += STALE_LOCK_MS;
    expect(await reg.reclaimStale()).toEqual([]);
    expect(await reg.isClaimed('node-1')).toBe(true);

    // Cross the window: the claim is stale → reclaimed and reads as unclaimed.
    nowMs += 1;
    expect(await reg.isClaimed('node-1')).toBe(false);
    expect(await reg.reclaimStale()).toEqual(['node-1']);
    expect(Object.keys(await reg.listClaims())).toEqual([]);

    // The freed node is grantable again, with a fresh token.
    const second = await reg.claim('node-1', 'poolB');
    expect(second.acquired).toBe(true);
    expect((second as { acquired: true; ownerToken: string }).ownerToken).not.toBe(
      (first as { acquired: true; ownerToken: string }).ownerToken,
    );
  });

  it('never clobbers a re-heartbeated live owner (token-survival)', async () => {
    let nowMs = 1_000_000;
    const clock = () => nowMs;
    const reg = new ClaimRegistry(registryPath, clock);

    const claim = await reg.claim('node-1', 'poolA');
    const token = (claim as { acquired: true; ownerToken: string }).ownerToken;

    // Time advances toward staleness, but the owner heartbeats just in time.
    nowMs += STALE_LOCK_MS;
    expect(await reg.heartbeat('node-1', token)).toBe(true);

    // A reclaim sweep now sees a FRESH claim (re-heartbeated) and leaves it.
    nowMs += 1; // would have been stale relative to the ORIGINAL claim time
    expect(await reg.reclaimStale()).toEqual([]);
    expect(await reg.isClaimed('node-1')).toBe(true);

    // A wrong-token release is a no-op; the real owner can still release.
    expect(await reg.release('node-1', 'not-the-owner')).toBe(false);
    expect(await reg.isClaimed('node-1')).toBe(true);
    expect(await reg.heartbeat('node-1', 'not-the-owner')).toBe(false);
    expect(await reg.release('node-1', token)).toBe(true);
    expect(await reg.isClaimed('node-1')).toBe(false);
  });

  it('degrades a corrupt registry to empty instead of throwing (malformed)', async () => {
    // Garbage that is not even JSON.
    await writeFile(registryPath, '{ not valid json ::::', 'utf8');
    const reg = new ClaimRegistry(registryPath);
    const claim = await reg.claim('node-1', 'poolA');
    expect(claim.acquired).toBe(true);
    // The bad content was overwritten with a well-formed map.
    const onDisk = JSON.parse(await readFile(registryPath, 'utf8'));
    expect(Object.keys(onDisk)).toEqual(['node-1']);

    // Well-formed JSON of the wrong shape (array) also degrades to empty.
    await writeFile(registryPath, '[1,2,3]', 'utf8');
    const reg2 = new ClaimRegistry(registryPath);
    expect(await reg2.listClaims()).toEqual({});
    expect((await reg2.claim('node-2', 'poolB')).acquired).toBe(true);

    // A map carrying one junk record keeps only the well-formed entries.
    await writeFile(
      registryPath,
      JSON.stringify({
        good: { ownerToken: 't', poolId: 'p', heartbeatAt: Date.now() },
        bad: { nope: true },
      }),
      'utf8',
    );
    const reg3 = new ClaimRegistry(registryPath);
    expect(Object.keys(await reg3.listClaims())).toEqual(['good']);
  });
});
