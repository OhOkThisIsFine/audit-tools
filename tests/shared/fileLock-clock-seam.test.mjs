/**
 * CP-NODE-5: fileLock carries an injectable clock seam (default Date.now) so the
 * staleness / timeout windows are exercised deterministically without sleeping real
 * wall-clock time. STALE_LOCK_MS stays exported (a duration, unchanged in value).
 */

import { test, expect } from "vitest";
import { writeFile } from "node:fs/promises";
import {
  STALE_LOCK_MS,
  makeClock,
  withTempDir,
  tmpLockPath,
} from "./fileLockTestSupport.mjs";

const { acquireLock, releaseLock, FileLockTimeoutError } =
  await import("../../src/shared/quota/fileLock.ts");

test("STALE_LOCK_MS is exported and unchanged (30s)", () => {
  expect(STALE_LOCK_MS).toBe(30_000);
});

test("injected clock: timeout fires off the injected now, not wall time", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    // Hold the lock by writing it as a FRESH lock (token never stale under our clock).
    const now = makeClock();
    await writeFile(lockPath, "held-by-someone-else", { flag: "wx" });

    // Acquire with a short timeout. Real wall time does not advance the injected
    // clock, so the only way the deadline is reached is by advancing `now`. Run the
    // acquire and step the clock past the deadline concurrently.
    const p = acquireLock(lockPath, 5_000, undefined, { now }).then(
      () => "acquired",
      (err) => err,
    );
    // Advance the injected clock past the deadline while the acquire loop spins.
    const tick = setInterval(() => now.advance(2_000), 5);
    const result = await p;
    clearInterval(tick);
    expect(result instanceof FileLockTimeoutError, "must time out via the injected clock").toBeTruthy();
  });
});

test("injected clock: a lock older than STALE_LOCK_MS under the clock is stolen", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    // Pre-create a lock; its real mtime is ~now-wall. We make our clock read FAR in
    // the future so the lock is unambiguously stale (now() - mtime > STALE_LOCK_MS),
    // letting the acquirer steal it and succeed well within its timeout.
    await writeFile(lockPath, "stale-holder", { flag: "wx" });
    const now = makeClock(Date.now() + STALE_LOCK_MS * 10);

    const token = await acquireLock(lockPath, 5_000, undefined, { now });
    expect(typeof token).toBe("string");
    expect(token.length > 0).toBeTruthy();
    await releaseLock(lockPath, token);
  });
});

test("default clock still works (no options) — fresh acquire/release", async () => {
  await withTempDir(async (dir) => {
    const lockPath = tmpLockPath(dir);
    const token = await acquireLock(lockPath);
    expect(typeof token).toBe("string");
    await releaseLock(lockPath, token);
  });
});
