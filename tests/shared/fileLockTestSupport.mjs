/**
 * Single-sourced test support for the fileLock suites
 * (`fileLock.test.mjs` + `fileLock-clock-seam.test.mjs`).
 *
 * CP-NODE-15: the temp-dir / lock-path / capturing-logger / injectable-clock
 * helpers used to be copy-pasted across the two fileLock test files. Drift
 * between the copies (a fixed helper in one file, a stale one in the other) is a
 * latent failure mode, so they are defined ONCE here and imported by both.
 *
 * `STALE_LOCK_MS` is re-exported from the source module so test back-dating math
 * reads the real exported duration instead of a copied `60_000` literal — if the
 * source threshold ever changes, the tests track it automatically (drift-guard
 * from the exported surface, not a hand-copied number).
 *
 * This file is intentionally NOT named `*.test.mjs` so the
 * `tests/shared/*.test.mjs` glob does not run it as a test (INV-shared-tests-01).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export { STALE_LOCK_MS } from "../../src/shared/quota/fileLock.ts";

/**
 * Controllable monotonic clock matching the fileLock {@link Clock} seam:
 * `now()` reads the current value; `now.advance(ms)` steps it forward. Lets the
 * staleness / timeout windows be exercised deterministically without sleeping
 * real wall-clock time.
 */
export function makeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** Run `fn(dir)` with a fresh OS temp dir, cleaning it up afterwards regardless. */
export async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "audit-tools-filelock-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Unique lock path inside `dir` (does not create the file). */
export function tmpLockPath(dir) {
  return join(dir, `test-lock-${randomUUID()}.lock`);
}

/**
 * Minimal in-memory RunLogger stand-in that captures `event(RunLogEvent)` calls
 * without writing to disk. Mirrors the RunLogger.event signature.
 */
export function makeCapturingLogger() {
  const events = [];
  return {
    events,
    event(ev) {
      events.push({ ...ev });
    },
  };
}
