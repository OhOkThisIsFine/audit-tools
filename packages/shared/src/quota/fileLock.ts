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

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    return false;
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
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const now = Date.now();
    if (now - lastStaleCheckAt >= STALE_CHECK_INTERVAL_MS) {
      lastStaleCheckAt = now;
      if (await isLockStale(lockPath)) {
        try {
          await unlink(lockPath);
          logger?.event({ kind: "step", note: "stale_lock_removed", lock_path: lockPath } as never);
          continue;
        } catch {
          // Another process may have already cleaned it up
        }
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
