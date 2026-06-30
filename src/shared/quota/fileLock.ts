import { writeFile, unlink, stat, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunLogger } from "../observability/runLog.js";

export const STALE_LOCK_MS = 30_000;

/**
 * Injectable monotonic-ish clock for the lock. Defaults to {@link Date.now}; tests
 * pass a controllable stub so staleness / timeout windows are exercised
 * deterministically without sleeping real wall-clock time. Every time read inside
 * the lock — owner-token minting, staleness comparison, deadline, backoff clamp —
 * routes through the `now` carried on the active options, so a single injected clock
 * governs the whole acquisition. `STALE_LOCK_MS` is unchanged (a duration, not a
 * clock) and stays exported.
 */
export type Clock = () => number;
const defaultClock: Clock = Date.now;
// Lock-acquire retry uses exponential backoff (initial → doubling → max) rather
// than a fixed poll, so a long contention window costs far fewer wakeups. The
// sleep is always clamped to the time left so backoff never overshoots timeoutMs.
const RETRY_INTERVAL_INITIAL_MS = 50;
const RETRY_INTERVAL_MAX_MS = 500;
const DEFAULT_TIMEOUT_MS = 10_000;
const STALE_CHECK_INTERVAL_MS = 1_000;

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out acquiring lock: ${lockPath}`);
    this.name = "FileLockTimeoutError";
  }
}

function generateOwnerToken(now: Clock = defaultClock): string {
  return `${process.pid}-${now()}-${Math.random().toString(36).slice(2)}`;
}

// Returns the owner token of a stale lock (older than STALE_LOCK_MS), or null
// when the lock is fresh or already gone. Returning the token lets stale removal
// reuse a token-checked delete, so a lock concurrently re-created with a
// different token is never clobbered.
async function readStaleLockToken(lockPath: string, now: Clock): Promise<string | null> {
  try {
    const info = await stat(lockPath);
    if (now() - info.mtimeMs <= STALE_LOCK_MS) return null;
    return await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
}

// Suffix for the per-lock exclusive "steal claim" sidecar. Acquiring this via an
// atomic `wx` create is what serializes stale-lock removal (see stealStaleLock).
const STEAL_CLAIM_SUFFIX = ".steal";

// Best-effort unlink that swallows ENOENT and transient Windows contention
// (EPERM/EACCES). Used for cleanup paths where a failure to delete is harmless
// because the acquire loop will retry regardless.
async function bestEffortUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort: already gone or briefly contended on Windows
  }
}

// Atomically (lease-style) steal a lock we observed as stale.
//
// The previous implementation did read-token-then-unlink as two non-atomic steps
// directly on the lock file. That admitted a double-hold: stealer X reads the
// stale token, stealer Y reads the same stale token, X unlinks and re-creates a
// FRESH lock via `wx`, then Y — still acting on its earlier observation — unlinks
// X's fresh lock and re-creates its own, so both X and Y believe they hold it.
//
// Fix: serialize the *removal right* through an exclusive sidecar claim. Only one
// acquirer can `wx`-create `${lockPath}.steal`; that winner is the sole party that
// may unlink the stale lock. Everyone else (EEXIST on the claim) backs off and
// retries the normal acquire path. After the single winner removes the stale file,
// the lock is gained by whoever wins the ordinary atomic `wx` create on lockPath —
// and no acquirer ever unlinks a *fresh* lock, because (a) only the claim winner
// unlinks at all and (b) it unlinks only while the content still equals the exact
// stale token it set out to remove. Mutual exclusion therefore holds even under
// concurrent steal.
//
// The claim sidecar is itself crash-tolerant: a winner that dies mid-steal would
// orphan it, so a claim older than STALE_LOCK_MS is treated as abandoned and
// reclaimed, mirroring the main lock's staleness recovery. The claim is always
// removed in a finally on the happy path so it lives only for the brief
// token-check + unlink window.
async function stealStaleLock(lockPath: string, staleToken: string, now: Clock): Promise<void> {
  const claimPath = `${lockPath}${STEAL_CLAIM_SUFFIX}`;
  try {
    await writeFile(claimPath, generateOwnerToken(now), { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Another acquirer holds the steal claim. If that claim is itself stale, a
      // stealer crashed mid-steal — reclaim it so the lock can never wedge
      // permanently. Otherwise leave the in-progress steal alone and let the main
      // loop retry the ordinary acquire path.
      try {
        const claimInfo = await stat(claimPath);
        if (now() - claimInfo.mtimeMs > STALE_LOCK_MS) {
          await bestEffortUnlink(claimPath);
        }
      } catch {
        // claim vanished between EEXIST and stat — nothing to reclaim
      }
      return;
    }
    if (code === "EPERM" || code === "EACCES") return; // transient Windows contention
    throw err;
  }

  // We exclusively hold the steal claim: we are the only party permitted to remove
  // the stale lock. Delete it only if it STILL carries the exact stale token we
  // observed; if a prior steal already replaced it with a fresh lock (different
  // token), leave that lock intact.
  try {
    if ((await readFile(lockPath, "utf8")) === staleToken) {
      await unlink(lockPath);
    }
  } catch {
    // best-effort: lock already gone or briefly contended on Windows
  } finally {
    await bestEffortUnlink(claimPath);
  }
}

/** Optional seams for the lock — currently just the injectable {@link Clock}. */
export interface LockOptions {
  /** Clock used for all time reads in this acquisition. Defaults to {@link Date.now}. */
  now?: Clock;
}

export async function acquireLock(
  lockPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  logger?: RunLogger,
  options: LockOptions = {},
): Promise<string> {
  const now = options.now ?? defaultClock;
  const token = generateOwnerToken(now);
  const deadline = now() + timeoutMs;
  let lastStaleCheckAt = 0;
  let retryInterval = RETRY_INTERVAL_INITIAL_MS;

  // A lock cannot be created in a directory that does not exist — the `wx` create
  // would ENOENT (not EEXIST), failing the whole acquisition. Ensure the parent dir
  // exists so callers that lock a path before its run dir is materialized (e.g. the
  // A-8 audit hybrid claiming before the review run is set up) just work. Idempotent.
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await writeFile(lockPath, token, { flag: "wx" });
      return token;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EEXIST means the lock is already held → wait and retry. On Windows a
      // concurrent create/delete race on the same lock file can surface as
      // EPERM/EACCES instead of EEXIST; treat those as transient contention and
      // retry as well, rather than failing the whole acquisition.
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw err;
    }

    // Check the deadline BEFORE any stale-check IO (stat/readFile) or sleep, so a
    // slow filesystem cannot push the actual return time past timeoutMs.
    if (now() >= deadline) {
      logger?.event({ kind: "error", note: "lock_timeout", lock_path: lockPath, timeout_ms: timeoutMs } as never);
      throw new FileLockTimeoutError(lockPath);
    }

    const checkAt = now();
    if (checkAt - lastStaleCheckAt >= STALE_CHECK_INTERVAL_MS) {
      lastStaleCheckAt = checkAt;
      const staleToken = await readStaleLockToken(lockPath, now);
      if (staleToken !== null) {
        // Steal the exact stale lock we observed via a lease-style, mutually
        // exclusive claim (see stealStaleLock). Only the single claim winner ever
        // unlinks, and only while the lock still carries this stale token — so a
        // fresh lock another holder created in the gap is never clobbered, and two
        // concurrent stealers can never both end up holding the lock.
        await stealStaleLock(lockPath, staleToken, now);
        logger?.event({ kind: "step", note: "stale_lock_removed", lock_path: lockPath } as never);
        // Progress was made (a slot may have opened); retry promptly and reset
        // the backoff window.
        retryInterval = RETRY_INTERVAL_INITIAL_MS;
        continue;
      }
    }

    // Exponential backoff, clamped to the time left so we never sleep past the
    // deadline. Doubles each idle cycle up to RETRY_INTERVAL_MAX_MS.
    const sleepMs = Math.min(retryInterval, Math.max(0, deadline - now()));
    await new Promise<void>((r) => setTimeout(r, sleepMs));
    retryInterval = Math.min(retryInterval * 2, RETRY_INTERVAL_MAX_MS);
  }
}

export async function releaseLock(lockPath: string, ownerToken: string): Promise<void> {
  try {
    const content = await readFile(lockPath, "utf8");
    if (content !== ownerToken) {
      // Lock was stolen by another holder; do not delete their lock.
      return;
    }
    await unlink(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // ENOENT: lock already gone — swallow silently
  }
}

export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
  logger?: RunLogger,
  options: LockOptions = {},
): Promise<T> {
  const token = await acquireLock(lockPath, timeoutMs, logger, options);
  let hasFnError = false;
  try {
    return await fn();
  } catch (err) {
    hasFnError = true;
    throw err;
  } finally {
    try {
      await releaseLock(lockPath, token);
    } catch (releaseErr) {
      // If fn() already threw, preserve that original error for the caller — a
      // secondary failure while releasing the lock must not mask the real cause.
      // If fn() succeeded, the release error is the only failure, so surface it.
      if (!hasFnError) throw releaseErr;
    }
  }
}
