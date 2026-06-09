import { writeFile, unlink, stat, readFile } from "node:fs/promises";
import type { RunLogger } from "../observability/runLog.js";

const STALE_LOCK_MS = 30_000;
const RETRY_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const STALE_CHECK_INTERVAL_MS = 1_000;

export class FileLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`Timed out acquiring lock: ${lockPath}`);
    this.name = "FileLockTimeoutError";
  }
}

function generateOwnerToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Returns the owner token of a stale lock (older than STALE_LOCK_MS), or null
// when the lock is fresh or already gone. Returning the token lets stale removal
// reuse releaseLock's token-checked delete, so a lock concurrently re-created
// with a different token is never clobbered.
async function readStaleLockToken(lockPath: string): Promise<string | null> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs <= STALE_LOCK_MS) return null;
    return await readFile(lockPath, "utf8");
  } catch {
    return null;
  }
}

// Delete a stale lock only if it still carries the token we observed as stale.
// If a concurrent acquirer replaced it with a fresh lock (different token) in the
// gap, leave that alone. Transient unlink failures are swallowed (ENOENT: already
// gone; EPERM/EACCES: concurrent Windows contention) — the acquire loop retries
// regardless. Distinct from releaseLock, which re-throws non-ENOENT errors on the
// normal release path.
async function removeStaleLock(lockPath: string, staleToken: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) !== staleToken) return;
    await unlink(lockPath);
  } catch {
    // best-effort stale cleanup
  }
}

export async function acquireLock(
  lockPath: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  logger?: RunLogger,
): Promise<string> {
  const token = generateOwnerToken();
  const deadline = Date.now() + timeoutMs;
  let lastStaleCheckAt = 0;

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

    const now = Date.now();
    if (now - lastStaleCheckAt >= STALE_CHECK_INTERVAL_MS) {
      lastStaleCheckAt = now;
      const staleToken = await readStaleLockToken(lockPath);
      if (staleToken !== null) {
        // Remove only the exact stale lock we observed; a fresh lock created by
        // another holder in the gap (different token) is preserved — closing the
        // TOCTOU where blind stale removal could clobber a newly-acquired lock.
        await removeStaleLock(lockPath, staleToken);
        logger?.event({ kind: "step", note: "stale_lock_removed", lock_path: lockPath } as never);
        continue;
      }
    }

    if (Date.now() >= deadline) {
      logger?.event({ kind: "error", note: "lock_timeout", lock_path: lockPath, timeout_ms: timeoutMs } as never);
      throw new FileLockTimeoutError(lockPath);
    }

    await new Promise<void>((r) => setTimeout(r, RETRY_INTERVAL_MS));
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
): Promise<T> {
  const token = await acquireLock(lockPath, timeoutMs, logger);
  try {
    return await fn();
  } finally {
    await releaseLock(lockPath, token);
  }
}
